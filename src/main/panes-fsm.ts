import type { Store } from './store'
import type {
  AgentKind,
  TerminalTab,
  PaneNode,
  PaneLeaf,
  SplitDirection
} from '../shared/state/terminals'
import {
  getLeaves,
  findLeaf,
  findLeafByTabId,
  hasAnyTabs,
  mapLeaves,
  replaceNode,
  removeLeaf
} from '../shared/state/terminals'
import type { PersistedPaneNode } from './persistence'
import { agentDisplayName, getAgentInfo } from '../shared/agent-registry'
import { log } from './debug'

interface PanesFSMOptions {
  persist: (panes: Record<string, PaneNode>) => void
  getRepoRootForWorktree: (worktreePath: string) => string | undefined
  getLatestClaudeSessionId: (worktreePath: string) => Promise<string | null>
  getDefaultAgentKind?: () => AgentKind
  /** Read the JSON-mode Claude feature flag + default-tab-type setting.
   *  When the flag is on AND default is 'json', a default Claude agent
   *  tab gets spawned as a json-claude tab instead. Always returns
   *  'xterm' (or undefined) when the feature flag is off. */
  getDefaultClaudeTabType?: () => 'xterm' | 'json'
  /** Tear down the PTY backing a closed tab. Called for agent + shell
   *  tabs when they're removed from the tree (closeTab, restartAgentTab,
   *  clearForWorktree). Authoritative on the main side so PTY lifetime
   *  no longer depends on a renderer being mounted to issue the kill —
   *  important for the web client, where any client (or none) might be
   *  the one driving the close. */
  killTabPty?: (tabId: string) => void
  /** Tear down a json-claude subprocess on tab close. Same authoritative-
   *  on-main contract as killTabPty, but routes to JsonClaudeManager
   *  instead of PtyManager. */
  killJsonClaude?: (sessionId: string) => void
  /** Drop the slice entry for a json-claude session. Used by
   *  convertTabType when swapping AWAY from json — without this, the
   *  stale 'exited' session entry survives and JsonModeChat's mount
   *  useEffect short-circuits if the user later swaps back to the same
   *  sessionId. The on-disk jsonl is untouched, so a re-mount replays
   *  history via seedFromTranscript. */
  clearJsonClaudeSession?: (sessionId: string) => void
  /** Spawn a json-claude session and (optionally) send a one-shot
   *  initial prompt as the first user message. Called from
   *  ensureInitialized when a default json-claude tab is created so
   *  the subprocess + initial prompt land on the same path the xterm
   *  side gets via --prompt. The renderer's JsonModeChat useEffect
   *  notices the session already exists and skips its own start. */
  startJsonClaudeWithPrompt?: (
    sessionId: string,
    worktreePath: string,
    initialPrompt?: string
  ) => void
  /** Spawn (or resume) a json-claude session without an initial
   *  prompt. Used by wakeJsonClaudeTab to re-attach a slept tab to a
   *  fresh subprocess. Idempotent: a no-op if the session is already
   *  running. */
  startJsonClaude?: (sessionId: string, worktreePath: string) => void
}

function newPaneId(): string {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function newSplitId(): string {
  return `split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function stripTransientTabFields(tab: TerminalTab): TerminalTab {
  if (!tab.initialPrompt && !tab.teleportSessionId) return tab
  const { initialPrompt: _ip, teleportSessionId: _ts, ...rest } = tab
  void _ip
  void _ts
  return rest
}

export class PanesFSM {
  private store: Store
  private opts: PanesFSMOptions
  private sleepingPanes = new Map<string, PaneNode>()

  constructor(store: Store, opts: PanesFSMOptions) {
    this.store = store
    this.opts = opts
  }

  hasSleepingPanes(wtPath: string): boolean {
    return this.sleepingPanes.has(wtPath)
  }

  private getTree(wtPath: string): PaneNode | null {
    return this.store.getSnapshot().state.terminals.panes[wtPath] || null
  }

  private getAllPanes(): Record<string, PaneNode> {
    return this.store.getSnapshot().state.terminals.panes
  }

  private buildPersistPayload(): Record<string, PaneNode> {
    const out: Record<string, PaneNode> = {}
    for (const [path, tree] of this.sleepingPanes) out[path] = tree
    for (const [path, tree] of Object.entries(this.getAllPanes())) out[path] = tree
    return out
  }

  private commit(wtPath: string, next: PaneNode): void {
    this.store.dispatch({
      type: 'terminals/panesForWorktreeChanged',
      payload: { worktreePath: wtPath, panes: next }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  async restoreFromConfig(
    persistedNested:
      | Record<string, Record<string, PersistedPaneNode>>
      | undefined
  ): Promise<void> {
    if (!persistedNested) return
    this.sleepingPanes.clear()
    for (const byWt of Object.values(persistedNested)) {
      for (const [wtPath, paneTree] of Object.entries(byWt)) {
        const tree = await this.hydratePersistedTree(paneTree, wtPath)
        this.sleepingPanes.set(wtPath, tree)
      }
    }
  }

  private async hydratePersistedTree(
    node: PersistedPaneNode,
    wtPath: string
  ): Promise<PaneNode> {
    if (node.type === 'split') {
      const [left, right] = await Promise.all([
        this.hydratePersistedTree(node.children[0], wtPath),
        this.hydratePersistedTree(node.children[1], wtPath)
      ])
      return {
        type: 'split',
        id: node.id,
        direction: node.direction,
        ratio: node.ratio,
        children: [left, right]
      }
    }
    const allTabs = node.tabs
    const needsBackfill = allTabs.some((t) => t.type === 'agent' && !t.sessionId)
    const latest = needsBackfill
      ? await this.opts.getLatestClaudeSessionId(wtPath).catch(() => null)
      : null
    let claimedLatest = false
    const tabs: TerminalTab[] = allTabs.map((t): TerminalTab => {
      const base: TerminalTab = {
        id: t.id,
        type: t.type,
        label: t.label,
        agentKind: t.agentKind,
        sessionId: t.sessionId,
        url: t.url,
        command: t.command,
        cwd: t.cwd
      }
      // Persisted json-claude tabs hydrate as 'asleep' so app launch
      // doesn't spawn one subprocess per tab. The renderer wakes them
      // on first focus via panes:wakeTab.
      if (base.type === 'json-claude') {
        return { ...base, mode: 'asleep' }
      }
      if (base.type !== 'agent' || base.sessionId) return base
      if (latest && !claimedLatest) {
        claimedLatest = true
        return { ...base, sessionId: latest }
      }
      return { ...base, sessionId: crypto.randomUUID() }
    })
    return {
      type: 'leaf',
      id: node.id,
      tabs,
      activeTabId: node.activeTabId
    }
  }

  ensureInitialized(
    wtPath: string,
    opts?: { initialPrompt?: string; teleportSessionId?: string }
  ): PaneNode {
    const existing = this.getTree(wtPath)
    if (existing && hasAnyTabs(existing)) return existing

    const sleeping = this.sleepingPanes.get(wtPath)
    if (sleeping && hasAnyTabs(sleeping)) {
      this.sleepingPanes.delete(wtPath)
      this.commit(wtPath, sleeping)
      return sleeping
    }

    const agentKind = this.opts.getDefaultAgentKind?.() ?? 'claude'
    const agentInfo = getAgentInfo(agentKind)
    const shellTabId = `shell-${wtPath}-${Date.now()}`
    // Branch to a json-claude default tab when the user has opted in
    // and the kind is Claude. teleport sessions stay on xterm (json-
    // claude has no `--resume <id>` analog for an arbitrary external
    // session today). initialPrompt is honored for both — for the
    // json-claude side we pre-spawn the subprocess and send it as the
    // first message via startJsonClaudeWithPrompt below.
    const wantsJson =
      agentKind === 'claude' &&
      this.opts.getDefaultClaudeTabType?.() === 'json' &&
      !opts?.teleportSessionId
    let agentTab: TerminalTab
    let jsonClaudeKickoff: { sessionId: string; initialPrompt?: string } | null = null
    if (wantsJson) {
      const sessionId = crypto.randomUUID()
      agentTab = {
        id: sessionId,
        type: 'json-claude',
        label: 'Claude (JSON)',
        sessionId,
        mode: 'awake'
      }
      jsonClaudeKickoff = { sessionId, initialPrompt: opts?.initialPrompt }
    } else {
      const agentTabId = `agent-${wtPath.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`
      agentTab = {
        id: agentTabId,
        type: 'agent',
        agentKind,
        label: agentInfo.displayName,
        sessionId: agentInfo.assignsSessionId ? crypto.randomUUID() : undefined,
        initialPrompt: opts?.teleportSessionId ? undefined : opts?.initialPrompt,
        teleportSessionId: opts?.teleportSessionId
      }
    }
    const tabs: TerminalTab[] = [agentTab, { id: shellTabId, type: 'shell', label: 'Shell' }]
    const pane: PaneLeaf = {
      type: 'leaf',
      id: newPaneId(),
      tabs,
      activeTabId: agentTab.id
    }
    this.commit(wtPath, pane)
    // Only kick off main-side spawn when an initialPrompt needs to land
    // as the first message. For prompt-less json-claude tabs, the
    // renderer's JsonModeChat useEffect handles the start — and for
    // sleeping panes / tab-type swaps we never reach this branch at
    // all, so resume flows are unaffected.
    if (jsonClaudeKickoff?.initialPrompt) {
      this.opts.startJsonClaudeWithPrompt?.(
        jsonClaudeKickoff.sessionId,
        wtPath,
        jsonClaudeKickoff.initialPrompt
      )
    }
    return pane
  }

  addTab(wtPath: string, tab: TerminalTab, paneId?: string): void {
    // Brand-new json-claude tabs default to 'awake' — the user just
    // clicked to create one, so the renderer's auto-spawn path should
    // proceed. Slept-by-default only applies to tabs hydrated from
    // disk in restoreFromConfig.
    const normalizedTab: TerminalTab =
      tab.type === 'json-claude' && tab.mode === undefined
        ? { ...tab, mode: 'awake' }
        : tab
    const tree = this.getTree(wtPath)
    if (!tree) {
      const pane: PaneLeaf = {
        type: 'leaf',
        id: newPaneId(),
        tabs: [normalizedTab],
        activeTabId: normalizedTab.id
      }
      this.commit(wtPath, pane)
      return
    }
    const leaves = getLeaves(tree)
    const targetId = paneId || leaves[0].id
    const updated = mapLeaves(tree, (leaf) => {
      if (leaf.id !== targetId) return leaf
      return {
        ...leaf,
        tabs: [...leaf.tabs, normalizedTab],
        activeTabId: normalizedTab.id
      }
    })
    this.commit(wtPath, updated)
  }

  /** Tear down a json-claude tab's subprocess while leaving its tab
   *  record (and the on-disk session jsonl) intact. The tab stays in
   *  the tree with mode='asleep' so the user can wake it later. No-op
   *  for non-json-claude tabs or tabs already asleep. */
  sleepJsonClaudeTab(wtPath: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const tab = leaf.tabs.find((t) => t.id === tabId)
    if (!tab || tab.type !== 'json-claude') return
    if ((tab.mode ?? 'awake') === 'asleep') return
    this.opts.killJsonClaude?.(tabId)
    this.store.dispatch({
      type: 'terminals/tabSlept',
      payload: { worktreePath: wtPath, tabId }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  /** Re-spawn a slept json-claude tab. Marks the tab awake and kicks
   *  off the same start path as a fresh tab. No-op for non-json-claude
   *  tabs or tabs already awake. */
  wakeJsonClaudeTab(wtPath: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const tab = leaf.tabs.find((t) => t.id === tabId)
    if (!tab || tab.type !== 'json-claude') return
    if ((tab.mode ?? 'awake') === 'awake') return
    this.store.dispatch({
      type: 'terminals/tabWoken',
      payload: { worktreePath: wtPath, tabId }
    })
    this.opts.startJsonClaude?.(tabId, wtPath)
    this.opts.persist(this.buildPersistPayload())
  }

  closeTab(wtPath: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const closing = leaf.tabs.find((t) => t.id === tabId)
    if (closing && (closing.type === 'agent' || closing.type === 'shell')) {
      this.opts.killTabPty?.(tabId)
    } else if (closing && closing.type === 'json-claude') {
      this.opts.killJsonClaude?.(tabId)
    }
    const remaining = leaf.tabs.filter((t) => t.id !== tabId)
    if (remaining.length === 0) {
      const collapsed = removeLeaf(tree, leaf.id)
      if (collapsed === null) {
        this.commit(wtPath, { ...leaf, tabs: [], activeTabId: '' })
      } else {
        this.commit(wtPath, collapsed)
      }
      return
    }
    let newActive = leaf.activeTabId
    if (leaf.activeTabId === tabId) {
      const closedIdx = leaf.tabs.findIndex((t) => t.id === tabId)
      const targetIdx = Math.max(0, Math.min(closedIdx - 1, remaining.length - 1))
      newActive = remaining[targetIdx].id
    }
    const updated = replaceNode(tree, leaf.id, {
      ...leaf,
      tabs: remaining,
      activeTabId: newActive
    })
    this.commit(wtPath, updated)
  }

  /** Swap an agent tab to a json-claude tab (or vice versa) without
   *  losing the on-disk session. The sessionId on the source tab maps
   *  to the same `~/.claude/projects/.../`<sessionId>`.jsonl` regardless
   *  of which renderer is driving it, so killing the current backend
   *  and dispatching the type flip is enough — the destination
   *  component (XTerminal or JsonModeChat) self-spawns the matching
   *  process on mount via --resume. */
  convertTabType(
    wtPath: string,
    tabId: string,
    newType: 'agent' | 'json-claude'
  ): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const tab = leaf.tabs.find((t) => t.id === tabId)
    if (!tab) return
    if (tab.type === newType) return
    if (tab.type !== 'agent' && tab.type !== 'json-claude') return
    if (tab.type === 'agent' && tab.agentKind && tab.agentKind !== 'claude') {
      // Only Claude agent tabs have a json-claude counterpart; refuse
      // to swap a Codex tab.
      log('panes-fsm', `convertTabType refused for non-claude agent kind=${tab.agentKind}`)
      return
    }
    const sessionId = tab.sessionId ?? crypto.randomUUID()
    if (tab.type === 'agent') {
      this.opts.killTabPty?.(tabId)
    } else {
      this.opts.killJsonClaude?.(tabId)
      // Drop the slice entry too, otherwise a subsequent swap back to
      // json-claude with the same sessionId would find a stale 'exited'
      // entry and JsonModeChat's mount useEffect would skip the start.
      this.opts.clearJsonClaudeSession?.(tabId)
    }
    const newId =
      newType === 'json-claude'
        ? sessionId
        : `agent-${wtPath.replace(/[^a-zA-Z0-9]/g, '-')}-${Date.now()}`
    const newLabel = newType === 'json-claude' ? 'Claude (JSON)' : agentDisplayName('claude')
    this.store.dispatch({
      type: 'terminals/tabTypeChanged',
      payload: { worktreePath: wtPath, tabId, newId, newType, newLabel }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  restartAgentTab(wtPath: string, tabId: string, newId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    // Tear down the old PTY before swapping the id — once we commit the
    // new id, no client has a way to refer to the old PTY anymore.
    this.opts.killTabPty?.(tabId)
    const updated = mapLeaves(tree, (leaf) => {
      if (!leaf.tabs.some((t) => t.id === tabId)) return leaf
      const tabs = leaf.tabs.map((t) =>
        t.id === tabId && t.type === 'agent' ? { ...t, id: newId } : t
      )
      const activeTabId = leaf.activeTabId === tabId ? newId : leaf.activeTabId
      return { ...leaf, tabs, activeTabId }
    })
    this.commit(wtPath, updated)
  }

  selectTab(wtPath: string, paneId: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree || !findLeaf(tree, paneId)) return
    const updated = mapLeaves(tree, (leaf) =>
      leaf.id === paneId ? { ...leaf, activeTabId: tabId } : leaf
    )
    this.commit(wtPath, updated)
  }

  reorderTabs(
    wtPath: string,
    paneId: string,
    fromId: string,
    toId: string
  ): void {
    if (fromId === toId) return
    const tree = this.getTree(wtPath)
    if (!tree) return
    const updated = mapLeaves(tree, (leaf) => {
      if (leaf.id !== paneId) return leaf
      const fromIdx = leaf.tabs.findIndex((t) => t.id === fromId)
      const toIdx = leaf.tabs.findIndex((t) => t.id === toId)
      if (fromIdx === -1 || toIdx === -1) return leaf
      const tabs = leaf.tabs.slice()
      const [moved] = tabs.splice(fromIdx, 1)
      tabs.splice(toIdx, 0, moved)
      return { ...leaf, tabs }
    })
    this.commit(wtPath, updated)
  }

  moveTabToPane(
    wtPath: string,
    tabId: string,
    toPaneId: string,
    toIndex?: number
  ): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const sourceLeaf = findLeafByTabId(tree, tabId)
    if (!sourceLeaf) return
    const moved = sourceLeaf.tabs.find((t) => t.id === tabId)!
    const sourceTabs = sourceLeaf.tabs.filter((t) => t.id !== tabId)
    const sourceActive =
      sourceLeaf.activeTabId === tabId
        ? sourceTabs[0]?.id || ''
        : sourceLeaf.activeTabId

    let updated: PaneNode
    if (sourceTabs.length === 0 && sourceLeaf.id !== toPaneId) {
      const collapsed = removeLeaf(tree, sourceLeaf.id)
      if (!collapsed) {
        updated = mapLeaves(tree, (leaf) => {
          if (leaf.id !== toPaneId) return leaf
          const tabs = leaf.tabs.slice()
          tabs.splice(toIndex ?? tabs.length, 0, moved)
          return { ...leaf, tabs, activeTabId: moved.id }
        })
      } else {
        updated = mapLeaves(collapsed, (leaf) => {
          if (leaf.id !== toPaneId) return leaf
          const tabs = leaf.tabs.slice()
          tabs.splice(toIndex ?? tabs.length, 0, moved)
          return { ...leaf, tabs, activeTabId: moved.id }
        })
      }
    } else {
      updated = mapLeaves(tree, (leaf) => {
        if (leaf.id === sourceLeaf.id && leaf.id !== toPaneId) {
          return { ...leaf, tabs: sourceTabs, activeTabId: sourceActive }
        }
        if (leaf.id === toPaneId) {
          const baseTabs =
            leaf.id === sourceLeaf.id ? sourceTabs : leaf.tabs.slice()
          baseTabs.splice(toIndex ?? baseTabs.length, 0, moved)
          return { ...leaf, tabs: baseTabs, activeTabId: moved.id }
        }
        return leaf
      })
    }
    this.commit(wtPath, updated)
  }

  splitPane(
    wtPath: string,
    fromPaneId: string,
    direction: SplitDirection = 'horizontal'
  ): PaneLeaf | null {
    const tree = this.getTree(wtPath)
    if (!tree) return null
    const source = findLeaf(tree, fromPaneId)
    if (!source) return null
    const sourceActive = source.tabs.find((t) => t.id === source.activeTabId)
    const sourceType = sourceActive?.type
    const shouldShell =
      !sourceType ||
      sourceType === 'agent' ||
      sourceType === 'shell' ||
      sourceType === 'browser'

    let tab: TerminalTab
    if (shouldShell) {
      tab = { id: `shell-${Date.now()}`, type: 'shell', label: 'Shell' }
    } else {
      tab = {
        ...sourceActive!,
        id: `${sourceActive!.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      }
    }

    const newLeaf: PaneLeaf = {
      type: 'leaf',
      id: newPaneId(),
      tabs: [tab],
      activeTabId: tab.id
    }

    const splitNode: PaneNode = {
      type: 'split',
      id: newSplitId(),
      direction,
      children: [source, newLeaf],
      ratio: 0.5
    }

    const updated = replaceNode(tree, fromPaneId, splitNode)
    this.commit(wtPath, updated)
    return newLeaf
  }

  setRatio(wtPath: string, splitId: string, ratio: number): void {
    this.store.dispatch({
      type: 'terminals/paneRatioChanged',
      payload: { worktreePath: wtPath, splitId, ratio }
    })
    this.opts.persist(this.buildPersistPayload())
  }

  clearForWorktree(wtPath: string): void {
    const inLive = wtPath in this.getAllPanes()
    const inSleeping = this.sleepingPanes.delete(wtPath)
    if (!inLive && !inSleeping) return
    if (inLive) {
      // Kill PTYs for every agent + shell tab under this worktree
      // before dispatching the clear, so any clients listening for
      // terminal:exit get the signal in the same window as the tree
      // update instead of leaking PTYs.
      const tree = this.getTree(wtPath)
      if (tree) {
        for (const leaf of getLeaves(tree)) {
          for (const tab of leaf.tabs) {
            if (tab.type === 'agent' || tab.type === 'shell') {
              this.opts.killTabPty?.(tab.id)
            } else if (tab.type === 'json-claude') {
              this.opts.killJsonClaude?.(tab.id)
            }
          }
        }
      }
      this.store.dispatch({
        type: 'terminals/panesForWorktreeCleared',
        payload: wtPath
      })
    }
    this.opts.persist(this.buildPersistPayload())
  }
}

export { stripTransientTabFields }
