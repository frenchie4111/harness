// Renderer-side mirror of the main-process store. This is intentionally
// a passive view: the renderer NEVER originates a mutation here. Every
// change comes from a `state:event` message that we apply via the
// SHARED reducer (the same code main runs), guaranteeing the two stay
// in sync without any custom diffing.
//
// Multi-backend (Tier 1): the renderer holds a `BackendsRegistry` of
// `(transport, ClientStore)` pairs — one per configured backend. Each
// transport is naturally scoped to one backend (each `state:event`
// channel only ever delivers events from its own server), so no
// per-event routing is required: at registration time we wire each
// transport's `onStateEvent` directly to its own store. The hooks
// below (`useSettings`, `usePrs`, `usePanes`, …) read from the
// **active** backend's store via `useSyncExternalStore`, with the
// subscribe callback firing on either (a) inner-store events or (b)
// active-id changes — so switching backends triggers a re-render that
// reads from the new active store.
//
// To mutate state, call the corresponding `window.api` method (e.g.
// `window.api.setTheme(...)`). That goes to whichever backend
// `window.api` currently routes to (active backend for most surfaces;
// always-local for connections-list mutations). Main dispatches
// through its store, broadcasts the event back here, the matching
// per-backend store applies it, and any component reading via the
// active backend's hooks re-renders.

import { useSyncExternalStore } from 'react'
import {
  initialState,
  rootReducer,
  type AppState,
  type StateEvent
} from '../shared/state'
import type { LocalTransportHandle, BackendConnection } from './types'

/** Stable id for the in-process Electron backend. Mirrors the value in
 *  src/main/persistence.ts; duplicated here because main isn't
 *  importable from renderer code. */
export const LOCAL_BACKEND_ID = 'local'

/** Per-backend client-side mirror. One instance per configured backend.
 *  Owns the AppState mirror, the listener set, and the cached client
 *  id. Constructed by the registry at backend-add time. */
class ClientStore {
  private state: AppState = initialState
  private listeners = new Set<() => void>()
  private clientIdValue: string | null = null

  applyEvent(event: StateEvent): void {
    this.state = rootReducer(this.state, event)
    for (const l of this.listeners) l()
  }

  setSnapshot(state: AppState): void {
    this.state = state
    for (const l of this.listeners) l()
  }

  setClientId(id: string): void {
    this.clientIdValue = id
  }

  getClientId(): string | null {
    return this.clientIdValue
  }

  getState(): AppState {
    return this.state
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
}

/** Holds N `(transport, store)` pairs and tracks which one is active.
 *  The "routing by backend" is structural — each transport's event
 *  channel only delivers its own backend's events, so wiring each
 *  transport's `onStateEvent` to its own store at registration is the
 *  whole story. There is no central event dispatcher.
 *
 *  Active selection is renderer-shell-owned (per
 *  plans/tier-1-multi-backend-ux.md §C). For Tier 1 v1 the registry
 *  starts with only the local backend; remote backends are added in
 *  later steps when the chip strip / add-backend modal lands. */
interface BackendEntry {
  connection: BackendConnection
  transport: LocalTransportHandle
  store: ClientStore
}

class BackendsRegistry {
  private entries = new Map<string, BackendEntry>()
  private activeId: string = LOCAL_BACKEND_ID
  private activeIdListeners = new Set<() => void>()
  private listListeners = new Set<() => void>()

  add(connection: BackendConnection, transport: LocalTransportHandle): ClientStore {
    if (this.entries.has(connection.id)) {
      throw new Error(`backend already registered: ${connection.id}`)
    }
    const store = new ClientStore()
    this.entries.set(connection.id, { connection, transport, store })
    transport.onStateEvent((event, _seq) => store.applyEvent(event as StateEvent))
    for (const l of this.listListeners) l()
    return store
  }

  remove(id: string): void {
    if (id === LOCAL_BACKEND_ID) {
      throw new Error('cannot remove local backend')
    }
    if (!this.entries.has(id)) return
    this.entries.delete(id)
    if (this.activeId === id) this.setActive(LOCAL_BACKEND_ID)
    for (const l of this.listListeners) l()
  }

  updateConnection(id: string, patch: Partial<BackendConnection>): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.connection = { ...entry.connection, ...patch }
    for (const l of this.listListeners) l()
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  getStore(id: string): ClientStore | undefined {
    return this.entries.get(id)?.store
  }

  getTransport(id: string): LocalTransportHandle | undefined {
    return this.entries.get(id)?.transport
  }

  getConnection(id: string): BackendConnection | undefined {
    return this.entries.get(id)?.connection
  }

  listConnections(): BackendConnection[] {
    return Array.from(this.entries.values()).map((e) => e.connection)
  }

  getActiveStore(): ClientStore {
    const e = this.entries.get(this.activeId)
    if (!e) throw new Error(`no store for active backend ${this.activeId}`)
    return e.store
  }

  getActiveTransport(): LocalTransportHandle {
    const e = this.entries.get(this.activeId)
    if (!e) throw new Error(`no transport for active backend ${this.activeId}`)
    return e.transport
  }

  getActiveConnection(): BackendConnection {
    const e = this.entries.get(this.activeId)
    if (!e) throw new Error(`no connection for active backend ${this.activeId}`)
    return e.connection
  }

  getActiveId(): string {
    return this.activeId
  }

  getAllIds(): string[] {
    return Array.from(this.entries.keys())
  }

  setActive(id: string): void {
    if (this.activeId === id) return
    if (!this.entries.has(id)) throw new Error(`unknown backend ${id}`)
    this.activeId = id
    // Push the new active transport into the preload's router so
    // window.api.X(...) calls go to the right backend. The function is
    // unavailable in environments that don't expose it (e.g. older
    // preloads or future test fixtures); a missing setter is silently
    // tolerated.
    const setter = (window as unknown as {
      __harness_setActiveTransport?: (impl: LocalTransportHandle) => void
    }).__harness_setActiveTransport
    const transport = this.entries.get(id)?.transport
    if (setter && transport) setter(transport)
    for (const l of this.activeIdListeners) l()
  }

  subscribeActiveId(cb: () => void): () => void {
    this.activeIdListeners.add(cb)
    return () => {
      this.activeIdListeners.delete(cb)
    }
  }

  subscribeList(cb: () => void): () => void {
    this.listListeners.add(cb)
    return () => {
      this.listListeners.delete(cb)
    }
  }
}

const registry = new BackendsRegistry()

/** Subscribe to "anything that would change what the slice hooks read"
 *  — fires on either active-store events or active-id changes. The
 *  active-id branch swaps the inner subscription so listeners stay
 *  tracking whichever store is currently active, without callers
 *  having to re-subscribe. */
function subscribeActive(cb: () => void): () => void {
  let storeUnsub = registry.getActiveStore().subscribe(cb)
  const idUnsub = registry.subscribeActiveId(() => {
    storeUnsub()
    storeUnsub = registry.getActiveStore().subscribe(cb)
    cb()
  })
  return () => {
    storeUnsub()
    idUnsub()
  }
}

/** Server-assigned identity for this renderer wrt the active backend.
 *  Per-backend — when active flips, this value can change. Components
 *  using `useSyncExternalStore` (via the slice hooks below) re-render
 *  on the swap and would naturally pick up the new id. Synchronous
 *  callers (selectors comparing `controllerClientId` to "me") get the
 *  active value at call time. */
export function getClientId(): string | null {
  return registry.getActiveStore().getClientId()
}

export async function initStore(): Promise<void> {
  const localTransport = window.__harness_local_transport
  if (!localTransport) {
    throw new Error(
      'preload did not expose __harness_local_transport — Tier 1 multi-backend wiring missing'
    )
  }
  // Wire the local backend first; for v1 it's the only one in the
  // registry. Remote backends from `connections[]` get added by the
  // chip-strip controller in a later commit.
  //
  // The connection's `kind` follows the runtime: in the browser web
  // client, `__HARNESS_WEB__` is true and the underlying transport is
  // a WebSocketClientTransport — semantically remote, even though the
  // registry id is still `local` (it's the always-present default the
  // user can't remove). UI gating reads `kind`, not the id.
  const isWeb = typeof window !== 'undefined' && window.__HARNESS_WEB__ === true
  const localConnection: BackendConnection = {
    id: LOCAL_BACKEND_ID,
    label: 'Local',
    url: '',
    kind: isWeb ? 'remote' : 'local',
    addedAt: 0
  }
  const localStore = registry.add(localConnection, localTransport)

  const [snapshot, id] = await Promise.all([
    localTransport.getStateSnapshot(),
    localTransport.getClientId()
  ])
  localStore.setSnapshot(snapshot.state)
  localStore.setClientId(id)
  // eslint-disable-next-line no-console
  console.log(`[take-control] initStore localClientId=${id}`)

  // Diagnostic logging for the controller/spectator flow. If the UI is
  // ever stuck on the wrong controller, grep console for
  // `[take-control]` — every roster event hitting the local backend's
  // store is logged with the post-reducer controllerClientId.
  localTransport.onStateEvent((event) => {
    const e = event as StateEvent
    if (
      e.type === 'terminals/controlTaken' ||
      e.type === 'terminals/controlReleased' ||
      e.type === 'terminals/clientJoined' ||
      e.type === 'terminals/clientDisconnected'
    ) {
      const payload = e.payload as { terminalId?: string }
      const tid = payload.terminalId
      const session = tid ? localStore.getState().terminals.sessions[tid] : undefined
      // eslint-disable-next-line no-console
      console.log(
        `[take-control] applied event=${e.type} payload=${JSON.stringify(e.payload)} myClientId=${id} postController=${session?.controllerClientId ?? 'null'}`
      )
    }
  })
}

function getActiveState(): AppState {
  return registry.getActiveStore().getState()
}

/** Selector hook reading from the **active** backend's store. Re-fires
 *  on inner-store events AND on active-backend changes (so switching
 *  backends triggers a re-render that reads fresh state from the new
 *  active store). */
export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribeActive,
    () => selector(getActiveState()),
    () => selector(initialState)
  )
}

export function useSettings() {
  return useAppState((s) => s.settings)
}

export function usePrs() {
  return useAppState((s) => s.prs)
}

export function useOnboarding() {
  return useAppState((s) => s.onboarding)
}

export function useHooks() {
  return useAppState((s) => s.hooks)
}

export function useWorktrees() {
  return useAppState((s) => s.worktrees)
}

export function useTerminals() {
  return useAppState((s) => s.terminals)
}

export function usePanes() {
  return useAppState((s) => s.terminals.panes)
}

export function useLastActive() {
  return useAppState((s) => s.terminals.lastActive)
}

export function useUpdater() {
  return useAppState((s) => s.updater)
}

export function useRepoConfigs() {
  return useAppState((s) => s.repoConfigs.byRepo)
}

export function useCosts() {
  return useAppState((s) => s.costs)
}

export function useBrowser() {
  return useAppState((s) => s.browser)
}

/** Session roster (controller + spectators) for a given terminal id.
 *  Re-renders only when that terminal's entry changes. Returns null if
 *  the terminal hasn't been joined yet (e.g. right after pane create
 *  but before the XTerminal mount dispatches terminal:join). */
export function useTerminalSession(terminalId: string) {
  return useAppState((s) => s.terminals.sessions[terminalId] ?? null)
}

export function useJsonClaude() {
  return useAppState((s) => s.jsonClaude)
}

/** Per-session selector. Narrow over `useJsonClaude()` so a streaming
 *  delta from session A doesn't re-render every JsonModeChat mounted
 *  for sessions B/C/D — the reducer keeps the per-key reference stable
 *  for sessions it didn't touch, so this selector returns the same
 *  object and useSyncExternalStore skips the render. */
export function useJsonClaudeSession(sessionId: string) {
  return useAppState((s) => s.jsonClaude.sessions[sessionId] ?? null)
}

/** Approvals map alone. Narrow over `useJsonClaude()` for the same
 *  reason — delta events on any session don't touch pendingApprovals,
 *  so subscribers here skip the streaming hot path entirely. */
export function useJsonClaudePendingApprovals() {
  return useAppState((s) => s.jsonClaude.pendingApprovals)
}

/** Returns the list of registered backends (local + any added remotes).
 *  Re-renders on backend add/remove/rename. The chip strip uses this to
 *  render avatars; UI gating uses `useActiveBackend()` instead. */
export function useConnections(): readonly BackendConnection[] {
  return useSyncExternalStore(
    (cb) => registry.subscribeList(cb),
    () => registry.listConnections(),
    () => []
  )
}

/** Returns the currently-active backend's connection metadata. Re-renders
 *  on either the active id changing OR the active backend's metadata
 *  being patched (e.g. rename). The most-used field is `kind` — gating
 *  things like RemoteFilePicker vs native dialog (per design §L). */
export function useActiveBackend(): BackendConnection {
  return useSyncExternalStore(
    (cb) => {
      const offList = registry.subscribeList(cb)
      const offId = registry.subscribeActiveId(cb)
      return () => {
        offList()
        offId()
      }
    },
    () => registry.getActiveConnection(),
    () => ({
      id: LOCAL_BACKEND_ID,
      label: 'Local',
      url: '',
      kind: 'local' as const,
      addedAt: 0
    })
  )
}

/** Test-only / advanced: get a handle to the registry. Lets the chip
 *  strip and add-backend flow add/switch backends. Never call from
 *  hooks — they should always use the slice hooks above. */
export function getBackendsRegistry(): BackendsRegistry {
  return registry
}

export type { AppState, StateEvent }
