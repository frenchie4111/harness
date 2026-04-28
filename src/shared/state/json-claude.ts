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
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  // For 'text' and 'thinking': markdown content. The wire-format
  // `thinking` field on extended-thinking blocks maps onto this same
  // field so the delta-append code stays uniform.
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
  /** True while this assistant entry is still being streamed via
   *  --include-partial-messages. Cleared when the consolidated
   *  assistant event arrives and the manager dispatches
   *  assistantEntryFinalized. The renderer uses this to draw a
   *  blinking cursor at the end of the text. */
  isPartial?: boolean
  /** True for a user entry that was typed while busy=true and has
   *  been written to stdin but not yet resolved by claude (i.e.,
   *  no `result` boundary has fired since it was queued). The
   *  renderer styles these as dashed/muted "queued" bubbles with
   *  a cancel affordance. Cleared on the next `result`. */
  isQueued?: boolean
  /** Image attachments sent with this user message. Only the on-disk
   *  path + media type live in the slice — bytes would balloon the
   *  state event payload. The renderer lazy-fetches each path via the
   *  jsonClaude:readAttachmentImage IPC to render thumbnails in the
   *  chat history. The path is also embedded in the user message that
   *  Claude sees ("(image attached at <path>)") so the model can
   *  Read/Bash/Write the file. */
  images?: Array<{ path: string; mediaType: string }>
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
  /** Slash command names (no leading `/`) advertised by Claude in the
   *  system/init message. Includes built-ins like 'clear'/'compact', the
   *  user's enabled Skills, plugin commands, and project-local
   *  `.claude/commands/*.md`. Empty until init lands. */
  slashCommands: string[]
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
      type: 'jsonClaude/assistantTextDelta'
      payload: { sessionId: string; entryId: string; textDelta: string }
    }
  | {
      type: 'jsonClaude/assistantThinkingDelta'
      payload: { sessionId: string; entryId: string; textDelta: string }
    }
  | {
      type: 'jsonClaude/assistantBlockAppended'
      payload: {
        sessionId: string
        entryId: string
        block: JsonClaudeMessageBlock
      }
    }
  | {
      type: 'jsonClaude/assistantEntryFinalized'
      payload: {
        sessionId: string
        entryId: string
        blocks: JsonClaudeMessageBlock[]
      }
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
  | {
      type: 'jsonClaude/userEntriesUnqueued'
      payload: { sessionId: string }
    }
  | {
      type: 'jsonClaude/entryRemoved'
      payload: { sessionId: string; entryId: string }
    }
  | {
      type: 'jsonClaude/slashCommandsChanged'
      payload: { sessionId: string; slashCommands: string[] }
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
      // Preserve entries + permissionMode + slashCommands if this
      // session id already exists (re-attach on reload or mode-change
      // respawn), reset exit bookkeeping.
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
            permissionMode: existing?.permissionMode ?? 'default',
            slashCommands: existing?.slashCommands ?? []
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
    case 'jsonClaude/assistantTextDelta': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { entryId, textDelta } = event.payload
      let changed = false
      const nextEntries = session.entries.map((entry) => {
        if (entry.entryId !== entryId) return entry
        const blocks = entry.blocks ?? []
        // Target the *last* text block. Messages can have
        // text→tool_use→text shape, and deltas always belong to the
        // most recently opened content block. Falling back to "first
        // text block" interleaves text 2's deltas into text 0.
        let lastTextIdx = -1
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].type === 'text') {
            lastTextIdx = i
            break
          }
        }
        if (lastTextIdx === -1) {
          changed = true
          return {
            ...entry,
            blocks: [...blocks, { type: 'text' as const, text: textDelta }]
          }
        }
        const nextBlocks = blocks.map((b, i) =>
          i === lastTextIdx ? { ...b, text: (b.text || '') + textDelta } : b
        )
        changed = true
        return { ...entry, blocks: nextBlocks }
      })
      if (!changed) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: nextEntries }
        }
      }
    }
    case 'jsonClaude/assistantThinkingDelta': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { entryId, textDelta } = event.payload
      let changed = false
      const nextEntries = session.entries.map((entry) => {
        if (entry.entryId !== entryId) return entry
        const blocks = entry.blocks ?? []
        // Target the *last* thinking block — same rationale as
        // assistantTextDelta: deltas always belong to the most recently
        // opened content block of that type.
        let lastThinkingIdx = -1
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].type === 'thinking') {
            lastThinkingIdx = i
            break
          }
        }
        if (lastThinkingIdx === -1) {
          // Defensive: content_block_start should have created a
          // thinking placeholder before any deltas land. If it didn't,
          // append one so the delta isn't dropped on the floor.
          changed = true
          return {
            ...entry,
            blocks: [...blocks, { type: 'thinking' as const, text: textDelta }]
          }
        }
        const nextBlocks = blocks.map((b, i) =>
          i === lastThinkingIdx ? { ...b, text: (b.text || '') + textDelta } : b
        )
        changed = true
        return { ...entry, blocks: nextBlocks }
      })
      if (!changed) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: nextEntries }
        }
      }
    }
    case 'jsonClaude/assistantBlockAppended': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { entryId, block } = event.payload
      let changed = false
      const nextEntries = session.entries.map((entry) => {
        if (entry.entryId !== entryId) return entry
        changed = true
        return { ...entry, blocks: [...(entry.blocks ?? []), block] }
      })
      if (!changed) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: nextEntries }
        }
      }
    }
    case 'jsonClaude/assistantEntryFinalized': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { entryId, blocks } = event.payload
      let found = false
      const nextEntries = session.entries.map((entry) => {
        if (entry.entryId !== entryId) return entry
        found = true
        const { isPartial: _drop, ...rest } = entry
        void _drop
        return { ...rest, blocks }
      })
      if (!found) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: nextEntries }
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
    case 'jsonClaude/userEntriesUnqueued': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      let changed = false
      const nextEntries = session.entries.map((entry) => {
        if (!entry.isQueued) return entry
        changed = true
        const { isQueued: _drop, ...rest } = entry
        void _drop
        return rest
      })
      if (!changed) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: nextEntries }
        }
      }
    }
    case 'jsonClaude/entryRemoved': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const next = session.entries.filter(
        (e) => e.entryId !== event.payload.entryId
      )
      if (next.length === session.entries.length) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: next }
        }
      }
    }
    case 'jsonClaude/slashCommandsChanged': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            slashCommands: event.payload.slashCommands
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
