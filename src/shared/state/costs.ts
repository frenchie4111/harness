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

export interface SessionUsage {
  sessionId: string
  transcriptPath: string
  /** Per-model accumulator. A single session can span multiple models
   *  if the user runs `/model` mid-session. */
  byModel: Record<string, ModelTally>
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
