// Renderer-side stand-in for the ticket-data workstream's main-process
// IPC surface + `tickets` slice. Built so the ticket UI can ship and be
// exercised end-to-end before the data PR lands. Everything in this file
// is intentionally local-only — nothing crosses the contextBridge.
//
// At merge time:
//   - Delete this file.
//   - Move the `tickets` namespace methods in `build-backend.ts` onto
//     real `req('tickets:...')` IPC calls.
//   - Swap the renderer hooks below for `useAppState((s) => s.tickets)`
//     against the slice the data workstream lands.
//
// State is split across two stores so the UI surfaces only care about
// the bits they need:
//   - providers/links — long-lived config keyed by id/repoRoot.
//   - cache — id → Ticket entries pulled lazily via list() + get().

import { useSyncExternalStore } from 'react'
import {
  createMockTicketProvider,
  type Ticket,
  type TicketProvider,
  type TicketProviderConfig,
  type TicketProviderType,
  type WorktreeTicketLink,
  type GithubIssuesConfig,
  type NotionConfig
} from '../shared/tickets'

interface TicketsStubState {
  providers: TicketProviderConfig[]
  /** Provider id → boolean "has a token in our stub vault". The real
   *  data workstream persists tokens encrypted under
   *  `ticket-provider-token:<id>` in `secrets.enc`; the stub just tracks
   *  presence so "Token configured" / "Replace token" reads right. */
  tokens: Record<string, boolean>
  /** Worktree path → linked ticket. The data workstream will persist
   *  this on the worktrees slice; the stub puts it here so the picker
   *  can demonstrate the full flow. */
  byWorktree: Record<string, WorktreeTicketLink>
  /** Ticket id → cached Ticket. Populated by `list()` results and `get()`
   *  calls so the sidebar chip + picker can show titles synchronously. */
  cache: Record<string, Ticket>
}

const initial: TicketsStubState = {
  providers: [
    // Seed with one provider so the dev flow has something to assign on
    // first launch. The provider is unassigned by default — the user
    // picks which of their configured projects it applies to from the
    // provider form in Settings → Ticket Providers. Real GitHub/Notion
    // impls land in the data workstream.
    {
      id: 'stub-default',
      label: 'Example issues (mock)',
      type: 'github-issues',
      config: { repo: 'frenchie4111/harness' },
      appliesToRepoRoots: []
    }
  ],
  tokens: { 'stub-default': true },
  byWorktree: {},
  cache: {}
}

let state: TicketsStubState = initial
const listeners = new Set<() => void>()

function getState(): TicketsStubState {
  return state
}

function setState(patch: (s: TicketsStubState) => TicketsStubState): void {
  state = patch(state)
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// Per-provider TicketProvider instances. The stub serves everything via
// `createMockTicketProvider` regardless of `type` — the real data
// workstream will dispatch to GithubIssuesProvider / NotionProvider here.
const providerInstances = new Map<string, TicketProvider>()
function getProviderInstance(id: string): TicketProvider {
  const cached = providerInstances.get(id)
  if (cached) return cached
  const fresh = createMockTicketProvider(id)
  providerInstances.set(id, fresh)
  return fresh
}

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tp-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

/** Patch payload for `updateProvider`. `config` is the full type-specific
 *  config object — partial updates would have to be discriminated against
 *  `type`, and callers always know the full shape anyway. */
export interface UpdateProviderPatch {
  label?: string
  config?: GithubIssuesConfig | NotionConfig
  appliesToRepoRoots?: string[]
}

/** Mirrors the IPC surface the data workstream will land. Everything here
 *  is a fire-and-respond Promise — same signature shapes as the
 *  `window.api.*` methods, just routed through the local in-memory store
 *  instead of contextBridge. */
export const ticketsStub = {
  async listProviders(): Promise<TicketProviderConfig[]> {
    return getState().providers
  },
  async addProvider(
    input: {
      label: string
      type: TicketProviderType
      config: GithubIssuesConfig | NotionConfig
      appliesToRepoRoots?: string[]
    },
    token?: string
  ): Promise<TicketProviderConfig> {
    const id = uuid()
    const cfg: TicketProviderConfig = {
      id,
      label: input.label,
      type: input.type,
      config: input.config,
      appliesToRepoRoots: input.appliesToRepoRoots ?? []
    }
    setState((s) => ({
      ...s,
      providers: [...s.providers, cfg],
      tokens: token ? { ...s.tokens, [id]: true } : s.tokens
    }))
    return cfg
  },
  async updateProvider(
    id: string,
    patch: UpdateProviderPatch,
    token?: string
  ): Promise<TicketProviderConfig | null> {
    const current = getState().providers.find((p) => p.id === id)
    if (!current) return null
    const next: TicketProviderConfig = {
      ...current,
      label: patch.label ?? current.label,
      config: patch.config ?? current.config,
      appliesToRepoRoots:
        patch.appliesToRepoRoots ?? current.appliesToRepoRoots
    }
    setState((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.id === id ? next : p)),
      tokens: token ? { ...s.tokens, [id]: true } : s.tokens
    }))
    // Refresh the provider instance so subsequent list/get pick up the
    // new config (in this stub it's all mock data — but real impls would
    // need the rebuild).
    providerInstances.delete(id)
    return next
  },
  async removeProvider(id: string): Promise<boolean> {
    if (!getState().providers.some((p) => p.id === id)) return false
    setState((s) => {
      const { [id]: _droppedToken, ...restTokens } = s.tokens
      void _droppedToken
      return {
        ...s,
        providers: s.providers.filter((p) => p.id !== id),
        tokens: restTokens
      }
    })
    providerInstances.delete(id)
    return true
  },
  async hasProviderToken(id: string): Promise<boolean> {
    return getState().tokens[id] === true
  },
  async setProviderToken(id: string, token: string): Promise<boolean> {
    if (!getState().providers.some((p) => p.id === id)) return false
    setState((s) => ({ ...s, tokens: { ...s.tokens, [id]: token.length > 0 } }))
    return true
  },
  async list(providerId: string, query?: string): Promise<Ticket[]> {
    const provider = getProviderInstance(providerId)
    const tickets = await provider.list(query)
    setState((s) => {
      const cache = { ...s.cache }
      for (const t of tickets) cache[t.id] = t
      return { ...s, cache }
    })
    return tickets
  },
  async get(providerId: string, externalId: string): Promise<Ticket | null> {
    const provider = getProviderInstance(providerId)
    const t = await provider.get(externalId)
    if (t) setState((s) => ({ ...s, cache: { ...s.cache, [t.id]: t } }))
    return t
  },
  async linkWorktree(worktreePath: string, link: WorktreeTicketLink): Promise<boolean> {
    setState((s) => ({
      ...s,
      byWorktree: { ...s.byWorktree, [worktreePath]: link }
    }))
    return true
  },
  async unlinkWorktree(worktreePath: string): Promise<boolean> {
    setState((s) => {
      if (!(worktreePath in s.byWorktree)) return s
      const { [worktreePath]: _dropped, ...rest } = s.byWorktree
      void _dropped
      return { ...s, byWorktree: rest }
    })
    return true
  }
} as const

export type TicketsStub = typeof ticketsStub

/** Read-only hook returning the providers list. Re-renders only when
 *  the providers array reference changes (add / update / remove). */
export function useTicketProviders(): TicketProviderConfig[] {
  return useSyncExternalStore(
    subscribe,
    () => getState().providers,
    () => initial.providers
  )
}

/** Returns true when the stub has a token recorded for the given
 *  provider. Used in Settings to show "Token configured" / "Replace
 *  token" instead of an empty input. */
export function useTicketProviderHasToken(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getState().tokens[id] === true,
    () => false
  )
}

/** Provider ids that should surface in `repoRoot`'s ticket picker. The
 *  membership lives on each provider's `appliesToRepoRoots` — derive
 *  here rather than persist a redundant copy. The returned array is
 *  cached per repoRoot so `useSyncExternalStore`'s reference comparison
 *  stays stable across renders that don't change the set. */
export function useRepoLinkedProviderIds(repoRoot: string | null | undefined): string[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!repoRoot) return EMPTY_IDS
      const cached = derivedRepoLinkCache.get(repoRoot)
      const ids: string[] = []
      for (const p of getState().providers) {
        if (p.appliesToRepoRoots?.includes(repoRoot)) ids.push(p.id)
      }
      if (cached && cached.length === ids.length && cached.every((v, i) => v === ids[i])) {
        return cached
      }
      derivedRepoLinkCache.set(repoRoot, ids)
      return ids
    },
    () => EMPTY_IDS
  )
}

const EMPTY_IDS: string[] = []
const derivedRepoLinkCache = new Map<string, string[]>()

/** The ticket linked to a given worktree path, or null. */
export function useWorktreeLinkedTicket(
  worktreePath: string | null | undefined
): WorktreeTicketLink | null {
  return useSyncExternalStore(
    subscribe,
    () => (worktreePath ? getState().byWorktree[worktreePath] ?? null : null),
    () => null
  )
}

/** Cached Ticket for the (providerId, externalId) pair, or null when
 *  the cache hasn't been populated yet. Callers can fire `tickets.get()`
 *  to populate it asynchronously. */
export function useCachedTicket(
  link: WorktreeTicketLink | null | undefined
): Ticket | null {
  const id = link ? `${link.providerId}:${link.externalId}` : null
  return useSyncExternalStore(
    subscribe,
    () => (id ? getState().cache[id] ?? null : null),
    () => null
  )
}

/** Imperative read for non-React callers. Returns a snapshot — don't
 *  hold it across renders, use the hooks instead. */
export function getTicketsStubSnapshot(): TicketsStubState {
  return getState()
}

/** Test-only: reset the stub to its initial state. Used by component
 *  tests that need a clean slate between cases. */
export function __resetTicketsStubForTests(): void {
  state = initial
  providerInstances.clear()
  derivedRepoLinkCache.clear()
  for (const l of listeners) l()
}
