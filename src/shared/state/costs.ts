// Per-terminal token usage + estimated cost, sourced from Claude Code
// session jsonl transcripts. Written to only by the main-side
// CostTracker (renderer never mutates this slice), so there's no IPC
// mutation handler for it — data flows jsonl -> main -> renderer.

export interface ModelTally {
  messages: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** Estimated dollar attribution of a session's total cost across the
 *  content categories that drove it. All fields are dollars and sum to
 *  (roughly) the session total. The split is computed by char-length
 *  proportion within each turn — exact per-block token counts aren't
 *  in the Anthropic usage field, so this is an estimate. Good enough
 *  for a "where are my tokens going" bar chart; not an accounting
 *  receipt.
 *
 *  Output side (what Claude produced this turn):
 *    text         — assistant text replies to the user
 *    thinking     — extended-thinking blocks
 *    toolUse      — the JSON args passed to tool calls
 *
 *  Input side (what was fed back in as context on this turn). A single
 *  tool_result or user prompt contributes to every subsequent turn's
 *  input cost — a big Read output early in a long session is "doubly
 *  expensive" because it gets re-paid on every cached turn after. The
 *  input-side attribution captures that amortized cost naturally.
 *    userPrompt     — things the user typed
 *    assistantEcho  — prior assistant messages replayed in context
 *    toolResults    — stdout of tool calls, keyed by tool name
 */
export interface ContentBreakdown {
  text: number
  thinking: number
  toolUse: number
  userPrompt: number
  assistantEcho: number
  toolResults: Record<string, number>
}

export const emptyBreakdown: ContentBreakdown = {
  text: 0,
  thinking: 0,
  toolUse: 0,
  userPrompt: 0,
  assistantEcho: 0,
  toolResults: {}
}

export interface SessionUsage {
  sessionId: string
  transcriptPath: string
  /** Per-model accumulator. A single session can span multiple models
   *  if the user runs `/model` mid-session. */
  byModel: Record<string, ModelTally>
  /** Dollar attribution across content categories (see ContentBreakdown). */
  breakdown: ContentBreakdown
  /** Most recently seen assistant-message model — drives the "right now"
   *  badge in the UI. */
  currentModel: string | null
  updatedAt: number
}

export interface CostsState {
  /** Keyed by terminal id. Entries persist across terminal death so
   *  worktree-level totals survive restarts. */
  byTerminal: Record<string, SessionUsage>
}

export type CostsEvent =
  | { type: 'costs/usageUpdated'; payload: { terminalId: string; usage: SessionUsage } }
  | { type: 'costs/terminalCleared'; payload: { terminalId: string } }
  | { type: 'costs/hydrated'; payload: CostsState }

export const initialCosts: CostsState = {
  byTerminal: {}
}

export const emptyTally: ModelTally = {
  messages: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0
}

export function costsReducer(state: CostsState, event: CostsEvent): CostsState {
  switch (event.type) {
    case 'costs/usageUpdated':
      return {
        ...state,
        byTerminal: {
          ...state.byTerminal,
          [event.payload.terminalId]: event.payload.usage
        }
      }
    case 'costs/terminalCleared': {
      if (!(event.payload.terminalId in state.byTerminal)) return state
      const next = { ...state.byTerminal }
      delete next[event.payload.terminalId]
      return { ...state, byTerminal: next }
    }
    case 'costs/hydrated':
      return event.payload
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

/** Sum two breakdowns into `target` in place. No-ops if `src` is missing —
 * persisted SessionUsage records from before ContentBreakdown was added lack
 * the field, and we don't want CostPanel to crash on old state. */
export function addBreakdown(target: ContentBreakdown, src: ContentBreakdown | undefined): void {
  if (!src) return
  target.text += src.text
  target.thinking += src.thinking
  target.toolUse += src.toolUse
  target.userPrompt += src.userPrompt
  target.assistantEcho += src.assistantEcho
  for (const [k, v] of Object.entries(src.toolResults)) {
    target.toolResults[k] = (target.toolResults[k] ?? 0) + v
  }
}

export function cloneBreakdown(b: ContentBreakdown): ContentBreakdown {
  return {
    text: b.text,
    thinking: b.thinking,
    toolUse: b.toolUse,
    userPrompt: b.userPrompt,
    assistantEcho: b.assistantEcho,
    toolResults: { ...b.toolResults }
  }
}

/** Sum one session's per-model tallies into a single ModelTally-shaped
 *  total. Convenience for UI aggregation. */
export function totalForSession(usage: SessionUsage): ModelTally {
  const total: ModelTally = { ...emptyTally }
  for (const t of Object.values(usage.byModel)) {
    total.messages += t.messages
    total.input += t.input
    total.output += t.output
    total.cacheRead += t.cacheRead
    total.cacheWrite += t.cacheWrite
    total.cost += t.cost
  }
  return total
}
