export type PtyStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval'

export interface PendingTool {
  name: string
  input: Record<string, unknown>
}

export interface ShellActivity {
  active: boolean
  processName?: string
}

export type AgentKind = 'claude' | 'codex'

export interface TerminalTab {
  id: string
  type: 'agent' | 'shell' | 'diff' | 'file' | 'browser'
  label: string
  /** For agent tabs: which CLI agent this tab runs. */
  agentKind?: AgentKind
  /** For diff/file tabs: the file path */
  filePath?: string
  /** For diff tabs: whether the diff is for staged changes */
  staged?: boolean
  /** For diff tabs: show the branch diff (base...HEAD) instead of working-tree diff */
  branchDiff?: boolean
  /** For diff tabs: when set, show this commit's full diff instead of a file diff */
  commitHash?: string
  /** For agent tabs: UUID passed to the agent CLI so the tab resumes its own session. */
  sessionId?: string
  /** For agent tabs: one-shot kickoff prompt. In-memory only — main strips it before persistence. */
  initialPrompt?: string
  /** For agent tabs: one-shot teleport session id. In-memory only — main strips it before persistence. */
  teleportSessionId?: string
  /** For browser tabs: the URL currently loaded (restored on reload). */
  url?: string
}

// ---------------------------------------------------------------------------
// Pane tree types — the layout is a binary tree where leaves hold tabs and
// split nodes define a direction + ratio for their two children.
// ---------------------------------------------------------------------------

export type SplitDirection = 'horizontal' | 'vertical'

export interface PaneLeaf {
  type: 'leaf'
  id: string
  tabs: TerminalTab[]
  activeTabId: string
}

export interface PaneSplit {
  type: 'split'
  id: string
  direction: SplitDirection
  children: [PaneNode, PaneNode]
  ratio: number
}

export type PaneNode = PaneLeaf | PaneSplit

/** Backwards-compat alias — some call sites still reference the old name. */
export type WorkspacePane = PaneLeaf

// ---------------------------------------------------------------------------
// Tree helpers — pure functions used by both the reducer and PanesFSM.
// ---------------------------------------------------------------------------

export function getLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node]
  return [...getLeaves(node.children[0]), ...getLeaves(node.children[1])]
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.children[0], paneId) || findLeaf(node.children[1], paneId)
}

export function findLeafByTabId(node: PaneNode, tabId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.tabs.some((t) => t.id === tabId) ? node : null
  return (
    findLeafByTabId(node.children[0], tabId) || findLeafByTabId(node.children[1], tabId)
  )
}

export function hasAnyTabs(node: PaneNode): boolean {
  if (node.type === 'leaf') return node.tabs.length > 0
  return hasAnyTabs(node.children[0]) || hasAnyTabs(node.children[1])
}

export function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.type === 'leaf') return fn(node)
  const left = mapLeaves(node.children[0], fn)
  const right = mapLeaves(node.children[1], fn)
  if (left === node.children[0] && right === node.children[1]) return node
  return { ...node, children: [left, right] }
}

export function replaceNode(
  root: PaneNode,
  nodeId: string,
  replacement: PaneNode
): PaneNode {
  if (root.id === nodeId) return replacement
  if (root.type === 'leaf') return root
  const left = replaceNode(root.children[0], nodeId, replacement)
  const right = replaceNode(root.children[1], nodeId, replacement)
  if (left === root.children[0] && right === root.children[1]) return root
  return { ...root, children: [left, right] }
}

/** Remove a leaf by id. If the leaf is a child of a split, the split
 * collapses to the remaining sibling. Returns null if the root itself
 * is the removed leaf. */
export function removeLeaf(root: PaneNode, leafId: string): PaneNode | null {
  if (root.type === 'leaf') return root.id === leafId ? null : root
  const [left, right] = root.children
  if (left.type === 'leaf' && left.id === leafId) return right
  if (right.type === 'leaf' && right.id === leafId) return left
  const newLeft = removeLeaf(left, leafId)
  if (newLeft !== left) {
    return newLeft === null ? right : { ...root, children: [newLeft, right] }
  }
  const newRight = removeLeaf(right, leafId)
  if (newRight !== right) {
    return newRight === null ? left : { ...root, children: [left, newRight] }
  }
  return root
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface TerminalsState {
  /** PTY status per terminal id. */
  statuses: Record<string, PtyStatus>
  /** Only meaningful when status is 'needs-approval'; null otherwise. */
  pendingTools: Record<string, PendingTool | null>
  /** Per-terminal foreground-process indicator for shell tabs. */
  shellActivity: Record<string, ShellActivity>
  /** Pane layout tree per worktree path. Authored entirely in main via the
   * panes-fsm methods. */
  panes: Record<string, PaneNode>
  /** Per-worktree most-recent-activity timestamp (ms since epoch). Used by
   * the sidebar for recency sort. Updated by the activity-deriver in main
   * whenever a contained terminal changes status. */
  lastActive: Record<string, number>
}

export type TerminalsEvent =
  | {
      type: 'terminals/statusChanged'
      payload: { id: string; status: PtyStatus; pendingTool: PendingTool | null }
    }
  | {
      type: 'terminals/shellActivityChanged'
      payload: { id: string; active: boolean; processName?: string }
    }
  | { type: 'terminals/removed'; payload: string }
  | {
      type: 'terminals/panesReplaced'
      payload: Record<string, PaneNode>
    }
  | {
      type: 'terminals/panesForWorktreeChanged'
      payload: { worktreePath: string; panes: PaneNode }
    }
  | {
      type: 'terminals/panesForWorktreeCleared'
      payload: string
    }
  | {
      type: 'terminals/lastActiveChanged'
      payload: { worktreePath: string; ts: number }
    }
  | {
      type: 'terminals/paneRatioChanged'
      payload: { worktreePath: string; splitId: string; ratio: number }
    }
  | {
      type: 'terminals/sessionIdDiscovered'
      payload: { terminalId: string; sessionId: string }
    }

export const initialTerminals: TerminalsState = {
  statuses: {},
  pendingTools: {},
  shellActivity: {},
  panes: {},
  lastActive: {}
}

export function terminalsReducer(
  state: TerminalsState,
  event: TerminalsEvent
): TerminalsState {
  switch (event.type) {
    case 'terminals/statusChanged': {
      const { id, status, pendingTool } = event.payload
      // pendingTool only matters when the status is needs-approval; null it
      // otherwise so the renderer doesn't flash stale approval UI.
      const nextPending = status === 'needs-approval' ? pendingTool : null
      return {
        ...state,
        statuses: { ...state.statuses, [id]: status },
        pendingTools: { ...state.pendingTools, [id]: nextPending }
      }
    }
    case 'terminals/shellActivityChanged': {
      const { id, active, processName } = event.payload
      return {
        ...state,
        shellActivity: {
          ...state.shellActivity,
          [id]: { active, processName }
        }
      }
    }
    case 'terminals/removed': {
      const id = event.payload
      if (
        !(id in state.statuses) &&
        !(id in state.pendingTools) &&
        !(id in state.shellActivity)
      ) {
        return state
      }
      const { [id]: _s, ...restStatuses } = state.statuses
      const { [id]: _p, ...restPending } = state.pendingTools
      const { [id]: _a, ...restActivity } = state.shellActivity
      void _s
      void _p
      void _a
      return {
        ...state,
        statuses: restStatuses,
        pendingTools: restPending,
        shellActivity: restActivity
      }
    }
    case 'terminals/panesReplaced': {
      return { ...state, panes: event.payload }
    }
    case 'terminals/panesForWorktreeChanged': {
      const { worktreePath, panes } = event.payload
      return {
        ...state,
        panes: { ...state.panes, [worktreePath]: panes }
      }
    }
    case 'terminals/panesForWorktreeCleared': {
      const worktreePath = event.payload
      if (!(worktreePath in state.panes)) return state
      const { [worktreePath]: _dropped, ...rest } = state.panes
      void _dropped
      return { ...state, panes: rest }
    }
    case 'terminals/lastActiveChanged': {
      const { worktreePath, ts } = event.payload
      return {
        ...state,
        lastActive: { ...state.lastActive, [worktreePath]: ts }
      }
    }
    case 'terminals/paneRatioChanged': {
      const { worktreePath, splitId, ratio } = event.payload
      const tree = state.panes[worktreePath]
      if (!tree) return state
      const updated = replaceNode(tree, splitId, {
        ...findSplit(tree, splitId)!,
        ratio
      })
      if (updated === tree) return state
      return { ...state, panes: { ...state.panes, [worktreePath]: updated } }
    }
    case 'terminals/sessionIdDiscovered': {
      const { terminalId, sessionId } = event.payload
      const nextPanes: Record<string, PaneNode> = {}
      let changed = false
      for (const [path, tree] of Object.entries(state.panes)) {
        nextPanes[path] = mapLeaves(tree, (leaf) => {
          const newTabs = leaf.tabs.map((tab) => {
            if (tab.id !== terminalId || tab.sessionId) return tab
            changed = true
            return { ...tab, sessionId }
          })
          return newTabs === leaf.tabs ? leaf : { ...leaf, tabs: newTabs }
        })
      }
      return changed ? { ...state, panes: nextPanes } : state
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

function findSplit(node: PaneNode, splitId: string): PaneSplit | null {
  if (node.type === 'leaf') return null
  if (node.id === splitId) return node
  return findSplit(node.children[0], splitId) || findSplit(node.children[1], splitId)
}
