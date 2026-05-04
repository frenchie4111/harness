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

/** Tool names that the approval card groups under "Allow edits this
 *  session". Granting any of these grants all of them — every tool that
 *  can write to the file system. Kept as a single grant because the user
 *  intent ("I trust this agent to edit") doesn't decompose meaningfully
 *  across these four. */
export const EDIT_TOOL_NAMES = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit'
] as const

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
  kind: 'user' | 'assistant' | 'system' | 'error' | 'tool_result' | 'compact'
  blocks?: JsonClaudeMessageBlock[]
  text?: string
  timestamp: number
  /** For kind === 'compact'. Whether the user invoked /compact ('manual')
   *  or claude autocompacted near the context limit ('auto'). Sourced
   *  from the system/compact_boundary record's compactMetadata.trigger. */
  compactTrigger?: 'auto' | 'manual'
  /** For kind === 'compact'. Token count just before compaction —
   *  rendered in the banner so the user can see roughly how much was
   *  rolled up. From compactMetadata.preTokens. */
  compactPreTokens?: number
  /** For kind === 'compact'. Token count immediately after compaction.
   *  From compactMetadata.postTokens — only present once compaction
   *  finishes (live stream may emit before the post count is known). */
  compactPostTokens?: number
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
  /** For kind === 'assistant'. When this assistant message was emitted
   *  by a sub-agent spawned via the Task tool, this is the tool_use id
   *  of the parent Task call. The renderer's grouping pre-pass uses it
   *  to nest sub-agent activity inside the parent Task card instead of
   *  flattening it chronologically into the top-level transcript. */
  parentToolUseId?: string
  /** For kind === 'error'. Categorizes the error so the renderer can pick
   *  the right card variant (Restart, Re-auth, Retry). */
  errorKind?: 'subprocess-exit' | 'rate-limit' | 'auth-failure'
  /** For kind === 'error'. Human-readable detail (exitReason, rate-limit
   *  retry-at timestamp, etc.). */
  errorMessage?: string
  /** For kind === 'error' with errorKind === 'subprocess-exit'. Whether the
   *  exit was clean (user closed the tab) or unexpected (crash). */
  exitWasClean?: boolean
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
  /** --permission-mode flag passed to claude at spawn time. Mid-session
   *  changes are applied via a stdin control_request (subtype
   *  'set_permission_mode') so the in-flight turn is not aborted; the
   *  spawn-time flag is still consulted on the next respawn. */
  permissionMode: JsonClaudePermissionMode
  /** Slash command names (no leading `/`) advertised by Claude in the
   *  system/init message. Includes built-ins like 'clear'/'compact', the
   *  user's enabled Skills, plugin commands, and project-local
   *  `.claude/commands/*.md`. Empty until init lands. */
  slashCommands: string[]
  /** Audit map of tool calls that were auto-approved by the LLM-based
   *  reviewer (instead of going through the user UI). Keyed by toolUseId
   *  so the per-tool card can render a small "auto-approved" badge.
   *  Only populated when settings.autoApprovePermissions is on. */
  autoApprovedDecisions: Record<
    string,
    { model: string; reason: string; timestamp: number }
  >
  /** Tool names the user has granted "allow this session" for. The bridge
   *  consults this set before surfacing an approval card and resolves
   *  matching requests directly. Survives kill+respawn (permission-mode
   *  toggles) but is intentionally not persisted across app restarts. */
  sessionToolApprovals: string[]
  /** Audit map of tool calls auto-resolved because their tool name was in
   *  sessionToolApprovals. Keyed by toolUseId, parallel to
   *  autoApprovedDecisions, so the per-tool card can render a small
   *  "allowed by session policy" badge. */
  sessionAllowedDecisions: Record<
    string,
    { toolName: string; timestamp: number }
  >
}

/** Status of the LLM-based auto-reviewer for a single pending approval.
 *  Set on the pending entry only when settings.autoApprovePermissions is
 *  on. The renderer reads this to draw a small "asking auto-approver"
 *  spinner while pending and a muted "auto-approver: <reason>" line
 *  once the reviewer has decided to ask. We never see a finished
 *  'approve' here in practice — that path resolves the approval and
 *  drops the entry from pendingApprovals before the renderer can
 *  observe it. */
export interface AutoReviewStatus {
  state: 'pending' | 'finished'
  decision?: 'approve' | 'ask'
  reason?: string
  model?: string
}

export interface JsonClaudePendingApproval {
  requestId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId?: string
  timestamp: number
  autoReview?: AutoReviewStatus
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
      payload: {
        sessionId: string
        worktreePath: string
        /** Permission mode applied only when this session id has no
         *  prior slice entry (fresh tab). When the session already
         *  exists (resume / re-attach / mode-change respawn), the
         *  reducer preserves the existing mode and ignores this. */
        defaultPermissionMode?: JsonClaudePermissionMode
      }
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
      type: 'jsonClaude/entriesSeeded'
      payload: { sessionId: string; entries: JsonClaudeChatEntry[] }
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
      type: 'jsonClaude/approvalAutoApproved'
      payload: {
        sessionId: string
        toolUseId: string
        model: string
        reason: string
        timestamp: number
      }
    }
  | {
      type: 'jsonClaude/approvalAutoReviewFinished'
      payload: {
        requestId: string
        decision: 'approve' | 'ask'
        reason: string
        model?: string
      }
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
  | {
      type: 'jsonClaude/compactBoundaryReceived'
      payload: {
        sessionId: string
        entryId: string
        trigger?: 'auto' | 'manual'
        preTokens?: number
        postTokens?: number
        timestamp: number
      }
    }
  | {
      type: 'jsonClaude/sessionToolApprovalsGranted'
      payload: { sessionId: string; toolNames: string[] }
    }
  | {
      type: 'jsonClaude/sessionToolApprovalsCleared'
      payload: { sessionId: string; toolNames?: string[] }
    }
  | {
      type: 'jsonClaude/approvalSessionAllowed'
      payload: {
        sessionId: string
        toolUseId: string
        toolName: string
        timestamp: number
      }
    }

export const initialJsonClaude: JsonClaudeState = {
  sessions: {},
  pendingApprovals: {}
}

/** Returns a shallow copy of `state` with every session's `entries` array
 *  replaced by `[]`. Used by transports to elide chat history from the
 *  initial snapshot — the wire payload is otherwise unbounded in proportion
 *  to how many sessions × turns × deltas the user has accumulated. The
 *  renderer fetches entries per session on first mount via
 *  `jsonClaude:getEntries`, which dispatches `entriesSeeded` to fill them
 *  back in. */
export function stripJsonClaudeEntries(state: JsonClaudeState): JsonClaudeState {
  const sessions: Record<string, JsonClaudeSession> = {}
  for (const [id, session] of Object.entries(state.sessions)) {
    sessions[id] = session.entries.length === 0 ? session : { ...session, entries: [] }
  }
  return { ...state, sessions }
}

function appendBlocksToEntry(
  entries: JsonClaudeChatEntry[],
  entry: JsonClaudeChatEntry
): JsonClaudeChatEntry[] {
  return [...entries, entry]
}

function findLastBlockIdx(
  blocks: JsonClaudeMessageBlock[],
  type: JsonClaudeMessageBlock['type']
): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === type) return i
  }
  return -1
}

// Targeted delta update. The naive .map(entry => ...) over session.entries
// allocates an O(N) array AND fires a JS callback per entry on every
// 30ms-coalesced delta — at hundreds of deltas per turn with extended
// thinking on, that pins CPU. Instead: locate the entry by index, slice +
// patch only that one. The .slice() is still O(N) but it's a flat memcpy
// of pointers, an order of magnitude cheaper than .map(callback).
function applyBlockTextDelta(
  state: JsonClaudeState,
  sessionId: string,
  entryId: string,
  textDelta: string,
  blockType: 'text' | 'thinking'
): JsonClaudeState {
  if (textDelta === '') return state
  const session = state.sessions[sessionId]
  if (!session) return state
  const entryIdx = session.entries.findIndex((e) => e.entryId === entryId)
  if (entryIdx === -1) return state
  const entry = session.entries[entryIdx]
  const blocks = entry.blocks ?? []
  const lastIdx = findLastBlockIdx(blocks, blockType)
  // No matching block-of-this-type — happens when entries haven't been
  // lazy-loaded yet on a renderer. content_block_start dispatches
  // assistantBlockAppended which creates the placeholder; if that never
  // landed for this entry on this client, the delta is correctly dropped
  // and re-materialized via getEntries when the user opens the tab.
  if (lastIdx === -1) return state
  const nextBlocks = blocks.slice()
  const b = nextBlocks[lastIdx]
  nextBlocks[lastIdx] = { ...b, text: (b.text ?? '') + textDelta }
  const nextEntries = session.entries.slice()
  nextEntries[entryIdx] = { ...entry, blocks: nextBlocks }
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [session.sessionId]: { ...session, entries: nextEntries }
    }
  }
}

export function jsonClaudeReducer(
  state: JsonClaudeState,
  event: JsonClaudeEvent
): JsonClaudeState {
  switch (event.type) {
    case 'jsonClaude/sessionStarted': {
      const { sessionId, worktreePath } = event.payload
      // Preserve entries + permissionMode + slashCommands +
      // sessionToolApprovals + sessionAllowedDecisions if this session
      // id already exists (re-attach on reload or mode-change respawn).
      // The session-allow set is a user grant that should outlive a
      // kill+respawn the same way permissionMode does. Reset exit
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
            permissionMode:
              existing?.permissionMode ??
              event.payload.defaultPermissionMode ??
              'default',
            slashCommands: existing?.slashCommands ?? [],
            autoApprovedDecisions: existing?.autoApprovedDecisions ?? {},
            sessionToolApprovals: existing?.sessionToolApprovals ?? [],
            sessionAllowedDecisions: existing?.sessionAllowedDecisions ?? {}
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
    case 'jsonClaude/entriesSeeded': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, entries: event.payload.entries }
        }
      }
    }
    case 'jsonClaude/assistantTextDelta': {
      // Target the *last* text block. Messages can have
      // text→tool_use→text shape, and deltas always belong to the
      // most recently opened content block.
      return applyBlockTextDelta(
        state,
        event.payload.sessionId,
        event.payload.entryId,
        event.payload.textDelta,
        'text'
      )
    }
    case 'jsonClaude/assistantThinkingDelta': {
      return applyBlockTextDelta(
        state,
        event.payload.sessionId,
        event.payload.entryId,
        event.payload.textDelta,
        'thinking'
      )
    }
    case 'jsonClaude/assistantBlockAppended': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { entryId, block } = event.payload
      const i = session.entries.findIndex((e) => e.entryId === entryId)
      if (i === -1) return state
      const entry = session.entries[i]
      const patched = { ...entry, blocks: [...(entry.blocks ?? []), block] }
      const nextEntries = [
        ...session.entries.slice(0, i),
        patched,
        ...session.entries.slice(i + 1)
      ]
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
      const i = session.entries.findIndex((e) => e.entryId === entryId)
      if (i === -1) return state
      const { isPartial: _drop, ...rest } = session.entries[i]
      void _drop
      const patched = { ...rest, blocks }
      const nextEntries = [
        ...session.entries.slice(0, i),
        patched,
        ...session.entries.slice(i + 1)
      ]
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
    case 'jsonClaude/approvalAutoApproved': {
      const { sessionId, toolUseId, model, reason, timestamp } = event.payload
      const session = state.sessions[sessionId]
      if (!session) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            autoApprovedDecisions: {
              ...session.autoApprovedDecisions,
              [toolUseId]: { model, reason, timestamp }
            }
          }
        }
      }
    }
    case 'jsonClaude/approvalAutoReviewFinished': {
      const { requestId, decision, reason, model } = event.payload
      const existing = state.pendingApprovals[requestId]
      if (!existing) return state
      return {
        ...state,
        pendingApprovals: {
          ...state.pendingApprovals,
          [requestId]: {
            ...existing,
            autoReview: { state: 'finished', decision, reason, model }
          }
        }
      }
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
      if (!session.entries.some((e) => e.isQueued)) return state
      const nextEntries = session.entries.map((entry) => {
        if (!entry.isQueued) return entry
        const { isQueued: _drop, ...rest } = entry
        void _drop
        return rest
      })
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
    case 'jsonClaude/compactBoundaryReceived': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { entryId, trigger, preTokens, postTokens, timestamp } =
        event.payload
      const entry: JsonClaudeChatEntry = {
        entryId,
        kind: 'compact',
        timestamp,
        ...(trigger ? { compactTrigger: trigger } : {}),
        ...(typeof preTokens === 'number' ? { compactPreTokens: preTokens } : {}),
        ...(typeof postTokens === 'number'
          ? { compactPostTokens: postTokens }
          : {})
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            entries: [...session.entries, entry]
          }
        }
      }
    }
    case 'jsonClaude/sessionToolApprovalsGranted': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const existing = new Set(session.sessionToolApprovals)
      let added = false
      for (const name of event.payload.toolNames) {
        if (!existing.has(name)) {
          existing.add(name)
          added = true
        }
      }
      if (!added) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            sessionToolApprovals: Array.from(existing)
          }
        }
      }
    }
    case 'jsonClaude/sessionToolApprovalsCleared': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { toolNames } = event.payload
      if (!toolNames) {
        if (session.sessionToolApprovals.length === 0) return state
        return {
          ...state,
          sessions: {
            ...state.sessions,
            [session.sessionId]: { ...session, sessionToolApprovals: [] }
          }
        }
      }
      const drop = new Set(toolNames)
      const next = session.sessionToolApprovals.filter((n) => !drop.has(n))
      if (next.length === session.sessionToolApprovals.length) return state
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: { ...session, sessionToolApprovals: next }
        }
      }
    }
    case 'jsonClaude/approvalSessionAllowed': {
      const session = state.sessions[event.payload.sessionId]
      if (!session) return state
      const { toolUseId, toolName, timestamp } = event.payload
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [session.sessionId]: {
            ...session,
            sessionAllowedDecisions: {
              ...session.sessionAllowedDecisions,
              [toolUseId]: { toolName, timestamp }
            }
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
