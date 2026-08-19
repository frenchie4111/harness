// Point-in-time occupancy of an agent's context window, sourced from the
// Claude Code session jsonl. Written to only by the main-side
// ContextTracker (renderer never mutates), so there's no IPC mutation
// handler — data flows jsonl -> main -> renderer.
//
// Distinct from the `costs` slice, which is cumulative and denominated in
// dollars ("where did my money go all session"). This one is
// point-in-time and denominated in tokens ("what is in the window right
// now"), so it follows only the live message chain: everything after the
// last compaction, excluding subagent sidechains.

/** Token attribution across the things occupying the window. Sums to
 *  `usedTokens`. See src/main/context-window.ts for how each is derived —
 *  the top-line total is exact (read off the last turn's usage record),
 *  the per-category split is anchored to measured per-turn token deltas
 *  and divided within each turn by char proportion. */
export interface ContextCategories {
  /** System prompt + tool schemas. Measured as the residual between the
   *  first turn's prompt size and the content preceding it, so it
   *  includes anything else the harness injects before the conversation
   *  starts. */
  systemAndTools: number
  /** CLAUDE.md files, sized from disk and carved out of systemAndTools.
   *  Estimated (they're part of the system block, not separately
   *  reported by the API). */
  memoryFiles: number
  /** The continuation summary carried across a compaction. Exact when the
   *  compact_boundary recorded postTokens. */
  carriedSummary: number
  /** Harness-injected context blocks: skill listings, agent listings,
   *  deferred-tool listings, todo reminders, @-mentioned files. */
  attachments: number
  userPrompts: number
  assistantText: number
  thinking: number
  /** JSON arguments the model passed to tools. */
  toolCalls: number
  /** Tool output replayed into context, keyed by tool name. Usually the
   *  largest and most prunable bucket. */
  toolResults: Record<string, number>
}

export const emptyCategories: ContextCategories = {
  systemAndTools: 0,
  memoryFiles: 0,
  carriedSummary: 0,
  attachments: 0,
  userPrompts: 0,
  assistantText: 0,
  thinking: 0,
  toolCalls: 0,
  toolResults: {}
}

export function cloneCategories(c: ContextCategories): ContextCategories {
  return { ...c, toolResults: { ...c.toolResults } }
}

/** Sum every category into a single token count. */
export function totalCategories(c: ContextCategories): number {
  return (
    c.systemAndTools +
    c.memoryFiles +
    c.carriedSummary +
    c.attachments +
    c.userPrompts +
    c.assistantText +
    c.thinking +
    c.toolCalls +
    Object.values(c.toolResults).reduce((a, b) => a + b, 0)
  )
}

export interface ContextSnapshot {
  sessionId: string
  transcriptPath: string
  /** Model driving the window size. Null before the first assistant turn. */
  model: string | null
  /** Total window for `model`, in tokens. */
  limit: number
  /** Tokens currently occupying the window. Exact as of the last
   *  assistant turn, plus a char estimate for anything appended since. */
  usedTokens: number
  categories: ContextCategories
  /** Token count at which this session is expected to auto-compact.
   *  Sourced from the session's own past compaction when it has one,
   *  otherwise AUTOCOMPACT_FRACTION of the limit. */
  autocompactAt: number
  /** How many times this session has already compacted. */
  compactions: number
  /** Tools whose schemas are NOT loaded but which the agent can pull in
   *  on demand — the "still discoverable" half of the picture. Populated
   *  from the transcript's deferred_tools_delta attachments. */
  discoverableTools: string[]
  /** True when at least one assistant turn carried a usage record, so
   *  `usedTokens` is anchored to a real number rather than all estimate. */
  measured: boolean
  updatedAt: number
}

export interface ContextWindowState {
  /** Keyed by terminal id (== tab id for both terminal and chat tabs). */
  byTerminal: Record<string, ContextSnapshot>
}

export type ContextWindowEvent =
  | {
      type: 'contextWindow/snapshotUpdated'
      payload: { terminalId: string; snapshot: ContextSnapshot }
    }
  | { type: 'contextWindow/terminalCleared'; payload: { terminalId: string } }

export const initialContextWindow: ContextWindowState = {
  byTerminal: {}
}

export function contextWindowReducer(
  state: ContextWindowState,
  event: ContextWindowEvent
): ContextWindowState {
  switch (event.type) {
    case 'contextWindow/snapshotUpdated':
      return {
        ...state,
        byTerminal: {
          ...state.byTerminal,
          [event.payload.terminalId]: event.payload.snapshot
        }
      }
    case 'contextWindow/terminalCleared': {
      if (!(event.payload.terminalId in state.byTerminal)) return state
      const next = { ...state.byTerminal }
      delete next[event.payload.terminalId]
      return { ...state, byTerminal: next }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
