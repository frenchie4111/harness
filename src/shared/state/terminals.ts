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
  type: 'agent' | 'shell' | 'diff' | 'file'
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
}

export interface WorkspacePane {
  id: string
  tabs: TerminalTab[]
  activeTabId: string
}

export type SplitDirection = 'horizontal' | 'vertical'

export interface TerminalsState {
  /** PTY status per terminal id. */
  statuses: Record<string, PtyStatus>
  /** Only meaningful when status is 'needs-approval'; null otherwise. */
  pendingTools: Record<string, PendingTool | null>
  /** Per-terminal foreground-process indicator for shell tabs. */
  shellActivity: Record<string, ShellActivity>
  /** Pane / tab tree per worktree path. Authored entirely in main via the
   * panes-fsm methods. */
  panes: Record<string, WorkspacePane[]>
  /** Per-worktree pane layout direction. 'horizontal' = side by side (default),
   * 'vertical' = stacked top/bottom. */
  splitDirections: Record<string, SplitDirection>
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
      payload: Record<string, WorkspacePane[]>
    }
  | {
      type: 'terminals/panesForWorktreeChanged'
      payload: { worktreePath: string; panes: WorkspacePane[] }
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
      type: 'terminals/splitDirectionChanged'
      payload: { worktreePath: string; direction: SplitDirection }
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
  splitDirections: {},
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
    case 'terminals/splitDirectionChanged': {
      const { worktreePath, direction } = event.payload
      if (state.splitDirections[worktreePath] === direction) return state
      return {
        ...state,
        splitDirections: { ...state.splitDirections, [worktreePath]: direction }
      }
    }
    case 'terminals/sessionIdDiscovered': {
      const { terminalId, sessionId } = event.payload
      const nextPanes: Record<string, WorkspacePane[]> = {}
      let changed = false
      for (const [path, paneList] of Object.entries(state.panes)) {
        nextPanes[path] = paneList.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) => {
            if (tab.id !== terminalId || tab.sessionId) return tab
            changed = true
            return { ...tab, sessionId }
          })
        }))
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
