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
  /** Tear down the PTY backing a closed tab. Called for agent + shell
   *  tabs when they're removed from the tree (closeTab, restartAgentTab,
   *  clearForWorktree). Authoritative on the main side so PTY lifetime
   *  no longer depends on a renderer being mounted to issue the kill —
   *  important for the web client, where any client (or none) might be
   *  the one driving the close. */
  killTabPty?: (tabId: string) => void
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
    const pane: PaneLeaf = {
      type: 'leaf',
      id: newPaneId(),
      tabs,
      activeTabId: agentTabId
    }
    this.commit(wtPath, pane)
    return pane
  }

  addTab(wtPath: string, tab: TerminalTab, paneId?: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) {
      const pane: PaneLeaf = {
        type: 'leaf',
        id: newPaneId(),
        tabs: [tab],
        activeTabId: tab.id
      }
      this.commit(wtPath, pane)
      return
    }
    const leaves = getLeaves(tree)
    const targetId = paneId || leaves[0].id
    const updated = mapLeaves(tree, (leaf) => {
      if (leaf.id !== targetId) return leaf
      return { ...leaf, tabs: [...leaf.tabs, tab], activeTabId: tab.id }
    })
    this.commit(wtPath, updated)
  }

  closeTab(wtPath: string, tabId: string): void {
    const tree = this.getTree(wtPath)
    if (!tree) return
    const leaf = findLeafByTabId(tree, tabId)
    if (!leaf) return
    const closing = leaf.tabs.find((t) => t.id === tabId)
    if (closing && (closing.type === 'agent' || closing.type === 'shell')) {
      this.opts.killTabPty?.(tabId)
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
