import type { Store } from './store'
import type { AgentKind, TerminalTab, WorkspacePane } from '../shared/state/terminals'
import type { PersistedPane } from './persistence'
import { agentDisplayName, getAgentInfo } from '../shared/agent-registry'
import { log } from './debug'

interface PanesFSMOptions {
  /** Persist a flat Record<wtPath, WorkspacePane[]> back to the on-disk
   * config. PanesFSM calls this on every mutation; the impl should
   * debounce/coalesce if the cost matters. */
  persist: (panes: Record<string, WorkspacePane[]>) => void
  /** Look up the repoRoot for a given worktree path. PanesFSM uses this
   * to nest persisted panes by repo (existing config layout). */
  getRepoRootForWorktree: (worktreePath: string) => string | undefined
  /** Look up the most recent on-disk agent session id for a worktree
   * (used by the boot-time backfill). */
  getLatestClaudeSessionId: (worktreePath: string) => Promise<string | null>
  /** Return the user's configured default agent kind. Used when creating
   * the initial agent tab for a new worktree. */
  getDefaultAgentKind?: () => AgentKind
}

function newPaneId(): string {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Strip in-memory-only fields before persisting. initialPrompt and
 * teleportSessionId are one-shot consumption signals — they're meaningful
 * the first time a Claude tab spawns and stale forever after. */
function stripTransientTabFields(tab: TerminalTab): TerminalTab {
  if (!tab.initialPrompt && !tab.teleportSessionId) return tab
  const { initialPrompt: _ip, teleportSessionId: _ts, ...rest } = tab
  void _ip
  void _ts
  return rest
}

/** Owns the pane/tab state machine. Every operation mutates the store and
 * triggers a persist. Renderer thinness goal: the renderer should never
 * compute new pane state locally — it always calls one of these methods. */
export class PanesFSM {
  private store: Store
  private opts: PanesFSMOptions
  /** Persisted panes that haven't been pushed into the store yet. Populated
   * by restoreFromConfig at boot; drained lazily by ensureInitialized when
   * a worktree wakes up. This is how sleep-on-boot for merged worktrees
   * works: the panes exist on disk but aren't in the store, so the renderer
   * doesn't mount xterm and PtyManager doesn't spawn Claude. They have to
   * be merged into every persist payload so unrelated commits don't blow
   * them away from disk. */
  private sleepingPanes = new Map<string, WorkspacePane[]>()

  constructor(store: Store, opts: PanesFSMOptions) {
    this.store = store
    this.opts = opts
  }

  /** True if a worktree has persisted panes waiting to be woken. */
  hasSleepingPanes(wtPath: string): boolean {
    return this.sleepingPanes.has(wtPath)
  }

  /** Read the current panes for a worktree from the store snapshot. */
  private getPanes(wtPath: string): WorkspacePane[] {
    return this.store.getSnapshot().state.terminals.panes[wtPath] || []
  }

  private getAllPanes(): Record<string, WorkspacePane[]> {
    return this.store.getSnapshot().state.terminals.panes
  }

  /** Build the persist payload: live panes from the store, plus any
   * sleeping panes still on disk. Merging is required so that committing
   * an awake worktree doesn't accidentally evict sleeping ones from the
   * persisted config. */
  private buildPersistPayload(): Record<string, WorkspacePane[]> {
    const out: Record<string, WorkspacePane[]> = {}
    for (const [path, panes] of this.sleepingPanes) out[path] = panes
    for (const [path, panes] of Object.entries(this.getAllPanes())) out[path] = panes
    return out
  }

  /** Dispatch a per-worktree change and persist all panes. */
  private commit(wtPath: string, next: WorkspacePane[]): void {
    this.store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: wtPath, panes: next }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  /** Boot-time restore from on-disk persisted panes. Backfills missing
   * Claude session ids the same way the renderer used to. Loads panes
   * into the sleepingPanes buffer rather than the store — they get
   * promoted to live state lazily by ensureInitialized() when each
   * worktree wakes up (boot drain for non-merged paths, activation IPC
   * for merged paths). */
  async restoreFromConfig(
    persistedNested: Record<string, Record<string, PersistedPane[]>> | undefined
  ): Promise<void> {
    if (!persistedNested) return
    this.sleepingPanes.clear()
    for (const byWt of Object.values(persistedNested)) {
      for (const [wtPath, paneList] of Object.entries(byWt)) {
        const allTabs = paneList.flatMap((p) => p.tabs)
        const needsBackfill = allTabs.some(
          (t) => t.type === 'agent' && !t.sessionId
        )
        const latest = needsBackfill
          ? await this.opts.getLatestClaudeSessionId(wtPath).catch(() => null)
          : null
        let claimedLatest = false
        const panes: WorkspacePane[] = paneList.map((pane) => ({
          id: pane.id,
          activeTabId: pane.activeTabId,
          tabs: pane.tabs.map((t): TerminalTab => {
            const base: TerminalTab = {
              id: t.id,
              type: t.type,
              label: t.label,
              agentKind: t.agentKind,
              sessionId: t.sessionId
            }
            if (base.type !== 'agent' || base.sessionId) return base
            if (latest && !claimedLatest) {
              claimedLatest = true
              return { ...base, sessionId: latest }
            }
            return { ...base, sessionId: crypto.randomUUID() }
          })
        }))
        this.sleepingPanes.set(wtPath, panes)
      }
    }
  }

  /** If a worktree has no panes, create the default Claude+Shell pair.
   * Renderer calls this on first activation; subsequent activations are
   * no-ops because the panes already exist. The optional initialPrompt /
   * teleportSessionId are one-shot signals consumed by XTerminal on
   * first spawn. */
  ensureInitialized(
    wtPath: string,
    opts?: { initialPrompt?: string; teleportSessionId?: string }
  ): WorkspacePane[] {
    const existing = this.getPanes(wtPath)
    if (existing.some((p) => p.tabs.length > 0)) return existing

    const sleeping = this.sleepingPanes.get(wtPath)
    if (sleeping && sleeping.some((p) => p.tabs.length > 0)) {
      this.sleepingPanes.delete(wtPath)
      this.commit(wtPath, sleeping)
      return sleeping
    }

    const agentKind = this.opts.getDefaultAgentKind?.() ?? 'claude'
    const agentInfo = getAgentInfo(agentKind)
    const agentTabId = `agent-${wtPath.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`
    const shellTabId = `shell-${wtPath}-${Date.now()}`
    const tabs: TerminalTab[] = [
      {
        id: agentTabId,
        type: 'agent',
        agentKind,
        label: agentInfo.displayName,
        sessionId: agentInfo.assignsSessionId ? crypto.randomUUID() : undefined,
        initialPrompt: opts?.teleportSessionId ? undefined : opts?.initialPrompt,
        teleportSessionId: opts?.teleportSessionId
      },
      { id: shellTabId, type: 'shell', label: 'Shell' }
    ]
    const pane: WorkspacePane = {
      id: newPaneId(),
      tabs,
      activeTabId: agentTabId
    }
    this.commit(wtPath, [pane])
    return [pane]
  }

  /** Append a tab to a target pane, creating the initial pane if none. */
  addTab(wtPath: string, tab: TerminalTab, paneId?: string): void {
    const list = this.getPanes(wtPath)
    if (list.length === 0) {
      const pane: WorkspacePane = { id: newPaneId(), tabs: [tab], activeTabId: tab.id }
      this.commit(wtPath, [pane])
      return
    }
    const targetId = paneId || list[0].id
    const next = list.map((p) =>
      p.id === targetId ? { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id } : p
    )
    this.commit(wtPath, next)
  }

  closeTab(wtPath: string, tabId: string): void {
    const list = this.getPanes(wtPath)
    const next: WorkspacePane[] = []
    for (const pane of list) {
      if (!pane.tabs.some((t) => t.id === tabId)) {
        next.push(pane)
        continue
      }
      const remaining = pane.tabs.filter((t) => t.id !== tabId)
      if (remaining.length === 0) {
        // Drop empty panes — unless this is the worktree's only pane,
        // in which case keep it empty so a fresh Claude tab can spawn.
        if (list.length === 1) next.push({ ...pane, tabs: [], activeTabId: '' })
        continue
      }
      const newActive =
        pane.activeTabId === tabId ? remaining[0].id : pane.activeTabId
      next.push({ ...pane, tabs: remaining, activeTabId: newActive })
    }
    this.commit(wtPath, next)
  }

  /** Replace the tab id (so React remounts XTerminal and spawns a fresh
   * pty) but keep the existing sessionId so the new Claude process resumes
   * the same conversation via `--resume`. */
  restartAgentTab(wtPath: string, tabId: string, newId: string): void {
    const list = this.getPanes(wtPath)
    const next = list.map((pane) => {
      if (!pane.tabs.some((t) => t.id === tabId)) return pane
      const tabs = pane.tabs.map((t) =>
        t.id === tabId && t.type === 'agent' ? { ...t, id: newId } : t
      )
      const activeTabId = pane.activeTabId === tabId ? newId : pane.activeTabId
      return { ...pane, tabs, activeTabId }
    })
    this.commit(wtPath, next)
  }

  selectTab(wtPath: string, paneId: string, tabId: string): void {
    const list = this.getPanes(wtPath)
    if (!list.some((p) => p.id === paneId)) return
    const next = list.map((p) =>
      p.id === paneId ? { ...p, activeTabId: tabId } : p
    )
    this.commit(wtPath, next)
  }

  reorderTabs(
    wtPath: string,
    paneId: string,
    fromId: string,
    toId: string
  ): void {
    if (fromId === toId) return
    const list = this.getPanes(wtPath)
    const next = list.map((pane) => {
      if (pane.id !== paneId) return pane
      const fromIdx = pane.tabs.findIndex((t) => t.id === fromId)
      const toIdx = pane.tabs.findIndex((t) => t.id === toId)
      if (fromIdx === -1 || toIdx === -1) return pane
      const tabs = pane.tabs.slice()
      const [moved] = tabs.splice(fromIdx, 1)
      tabs.splice(toIdx, 0, moved)
      return { ...pane, tabs }
    })
    this.commit(wtPath, next)
  }

  moveTabToPane(
    wtPath: string,
    tabId: string,
    toPaneId: string,
    toIndex?: number
  ): void {
    const list = this.getPanes(wtPath)
    let moved: TerminalTab | null = null
    const stripped = list.map((pane) => {
      const idx = pane.tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return pane
      moved = pane.tabs[idx]
      const tabs = pane.tabs.slice()
      tabs.splice(idx, 1)
      const activeTabId =
        pane.activeTabId === tabId ? tabs[0]?.id || '' : pane.activeTabId
      return { ...pane, tabs, activeTabId }
    })
    if (!moved) return
    // Drop now-empty source panes unless dropping would leave nothing.
    const filtered =
      stripped.length > 1
        ? stripped.filter((p) => p.tabs.length > 0 || p.id === toPaneId)
        : stripped
    const next = filtered.map((pane) => {
      if (pane.id !== toPaneId) return pane
      const tabs = pane.tabs.slice()
      const insertAt = toIndex ?? tabs.length
      tabs.splice(insertAt, 0, moved!)
      return { ...pane, tabs, activeTabId: moved!.id }
    })
    this.commit(wtPath, next)
  }

  /** Split: create a new pane to the right of `fromPaneId`. The new pane
   * mirrors the source pane's active tab type, except claude → shell. */
  splitPane(wtPath: string, fromPaneId: string): WorkspacePane | null {
    const list = this.getPanes(wtPath)
    const source = list.find((p) => p.id === fromPaneId)
    const sourceActive = source?.tabs.find((t) => t.id === source.activeTabId)
    const sourceType = sourceActive?.type
    const shouldShell =
      !sourceType || sourceType === 'agent' || sourceType === 'shell'

    let tab: TerminalTab
    if (shouldShell) {
      tab = { id: `shell-${Date.now()}`, type: 'shell', label: 'Shell' }
    } else {
      tab = {
        ...sourceActive!,
        id: `${sourceActive!.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      }
    }

    const newPane: WorkspacePane = {
      id: newPaneId(),
      tabs: [tab],
      activeTabId: tab.id
    }
    const idx = list.findIndex((p) => p.id === fromPaneId)
    const insertAt = idx === -1 ? list.length : idx + 1
    const next = list.slice()
    next.splice(insertAt, 0, newPane)
    this.commit(wtPath, next)
    return newPane
  }

  clearForWorktree(wtPath: string): void {
    const inLive = wtPath in this.getAllPanes()
    const inSleeping = this.sleepingPanes.delete(wtPath)
    if (!inLive && !inSleeping) return
    if (inLive) {
      this.store.dispatch({
        type: 'terminals/panesForWorktreeCleared',
        payload: wtPath
      })
    }
    this.opts.persist(this.buildPersistPayload())
  }
}

export { stripTransientTabFields }
