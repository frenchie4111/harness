// JSON-mode Claude tab state. Distinct from the terminals slice because
// this tab type does not run a PTY — its lifecycle is driven by a
// long-lived `claude -p --input-format stream-json` subprocess managed by
// JsonClaudeManager, and its per-tool approval flow rides an MCP bridge
// instead of the terminal-hook status dir.

export type JsonClaudeSessionState =
  | 'idle'
  | 'connecting'
  | 'running'
  | 'exited'
  | 'auth-required'

/** Mirrors `claude --permission-mode` choices. Subset relevant to a
 *  json-claude tab: we don't expose bypassPermissions (unsafe) or
 *  dontAsk/auto (overlap with default). */
export type JsonClaudePermissionMode = 'default' | 'acceptEdits' | 'plan'

export interface JsonClaudeMessageBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  // For 'text': markdown content.
  text?: string
  // For 'tool_use': content block fields.
  id?: string
  name?: string
  input?: Record<string, unknown>
  // For 'tool_result': correlation + rendered body.
  toolUseId?: string
  content?: string
  isError?: boolean
}

export interface JsonClaudeChatEntry {
  /** Monotonic per-session id so React can key rows stably. */
  entryId: string
  kind: 'user' | 'assistant' | 'system' | 'error' | 'tool_result'
  blocks?: JsonClaudeMessageBlock[]
  text?: string
  timestamp: number
}

export interface JsonClaudeSession {
  sessionId: string
  worktreePath: string
  state: JsonClaudeSessionState
  exitCode: number | null
  exitReason: string | null
  /** Buffered chat history for this session. Kept in the store so a
   *  reloading renderer doesn't lose the scrollback. */
  entries: JsonClaudeChatEntry[]
  /** Last text of the most recent user submission; used by the renderer to
   *  pair the echo against the user-card it just rendered optimistically. */
  busy: boolean
  /** --permission-mode flag passed to claude at spawn time. Changing
   *  this kills + respawns with --resume so the mode change is
   *  effectively mid-session. */
  permissionMode: JsonClaudePermissionMode
}

export interface JsonClaudePendingApproval {
  requestId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId?: string
  timestamp: number
}

export interface JsonClaudeState {
  /** Per-session state keyed by session id (== terminal/tab id). */
  sessions: Record<string, JsonClaudeSession>
  /** Pending approvals keyed by request id (unique across sessions). */
  pendingApprovals: Record<string, JsonClaudePendingApproval>
}

export type JsonClaudeEvent =
  | {
      type: 'jsonClaude/sessionStarted'
      payload: { sessionId: string; worktreePath: string }
    }
  | {
      type: 'jsonClaude/sessionStateChanged'
      payload: {
        sessionId: string
        state: JsonClaudeSessionState
        exitCode?: number | null
        exitReason?: string | null
      }
    }
  | {
      type: 'jsonClaude/entryAppended'
      payload: { sessionId: string; entry: JsonClaudeChatEntry }
    }
  | {
      type: 'jsonClaude/toolResultAttached'
      payload: {
        sessionId: string
        toolUseId: string
        content: string
        isError: boolean
      }
    }
  | {
      type: 'jsonClaude/busyChanged'
      payload: { sessionId: string; busy: boolean }
    }
  | {
      type: 'jsonClaude/sessionCleared'
      payload: { sessionId: string }
    }
  | {
      type: 'jsonClaude/approvalRequested'
      payload: JsonClaudePendingApproval
    }
  | {
      type: 'jsonClaude/approvalResolved'
      payload: { requestId: string }
    }
  | {
      type: 'jsonClaude/permissionModeChanged'
      payload: { sessionId: string; mode: JsonClaudePermissionMode }
    }

export const initialJsonClaude: JsonClaudeState = {
  sessions: {},
  pendingApprovals: {}
}

function appendBlocksToEntry(
  entries: JsonClaudeChatEntry[],
  entry: JsonClaudeChatEntry
): JsonClaudeChatEntry[] {
  return [...entries, entry]
}

export function jsonClaudeReducer(
  state: JsonClaudeState,
  event: JsonClaudeEvent
): JsonClaudeState {
  switch (event.type) {
    case 'jsonClaude/sessionStarted': {
      const { sessionId, worktreePath } = event.payload
      // Preserve entries + permissionMode if this session id already
      // exists (re-attach on reload or mode-change respawn), reset exit
      // bookkeeping.
      const existing = state.sessions[sessionId]
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [sessionId]: {
            sessionId,
            worktreePath,
            state: 'connecting',
            exitCode: null,
            exitReason: null,
            entries: existing?.entries ?? [],
            busy: false,
            permissionMode: existing?.permissionMode ?? 'default'
          }
        }
      }
    }
    case 'jsonClaude/sessionStateChanged': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { state: next, exitCode, exitReason } = event.payload
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            state: next,
            exitCode: exitCode ?? session.exitCode,
            exitReason: exitReason ?? session.exitReason
          }
        }
      }
    }
    case 'jsonClaude/entryAppended': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            entries: appendBlocksToEntry(session.entries, event.payload.entry)
          }
        }
      }
    }
    case 'jsonClaude/toolResultAttached': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { toolUseId, content, isError } = event.payload
      // Attach to the most recent entry that carries the matching tool_use
      // block — keeps correlation tight in the UI without a separate map.
      let changed = false
      const nextEntries = session.entries.map((entry) => {
        if (!entry.blocks) return entry
        const nextBlocks = entry.blocks.map((b) => {
          if (b.type !== 'tool_use' || b.id !== toolUseId) return b
          changed = true
          return { ...b }
        })
        return nextBlocks === entry.blocks ? entry : { ...entry, blocks: nextBlocks }
      })
      void nextEntries
      void changed
      // Also append a tool_result entry so the renderer can show the body
      // independently of the tool_use card when useful.
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            entries: [
              ...session.entries,
              {
                entryId: `${session.sessionId}-tr-${toolUseId}-${session.entries.length}`,
                kind: 'tool_result',
                timestamp: Date.now(),
                blocks: [
                  {
                    type: 'tool_result',
                    toolUseId,
                    content,
                    isError
                  }
                ]
              }
            ]
          }
        }
      }
    }
    case 'jsonClaude/busyChanged': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, busy: event.payload.busy }
        }
      }
    }
    case 'jsonClaude/sessionCleared': {
      const { sessionId } = event.payload
      if (!state.sessions[sessionId]) return state
      const { [sessionId]: _dropped, ...rest } = state.sessions
      void _dropped
      // Drop any pending approvals from this session so the renderer
      // doesn't show dangling cards.
      const nextPending: Record<string, JsonClaudePendingApproval> = {}
      for (const [id, req] of Object.entries(state.pendingApprovals)) {
        if (req.sessionId !== sessionId) nextPending[id] = req
      }
      return { ...state, sessions: rest, pendingApprovals: nextPending }
    }
    case 'jsonClaude/approvalRequested': {
      const req = event.payload
      return {
        ...state,
        pendingApprovals: { ...state.pendingApprovals, [req.requestId]: req }
      }
    }
    case 'jsonClaude/approvalResolved': {
      const { requestId } = event.payload
      if (!state.pendingApprovals[requestId]) return state
      const { [requestId]: _dropped, ...rest } = state.pendingApprovals
      void _dropped
      return { ...state, pendingApprovals: rest }
    }
    case 'jsonClaude/permissionModeChanged': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            permissionMode: event.payload.mode
          }
        }
      }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
