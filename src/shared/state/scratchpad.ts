export interface ScratchpadState {
  /** Per-worktree freeform notes, keyed by worktree path (the same value
   *  the renderer uses as `activeWorktreeId`). Empty strings are never
   *  stored — `textChanged` with `''` deletes the entry. */
  byWorktreePath: Record<string, string>
}

export type ScratchpadEvent =
  | { type: 'scratchpad/loaded'; payload: Record<string, string> }
  | { type: 'scratchpad/textChanged'; payload: { worktreePath: string; text: string } }
  | { type: 'scratchpad/worktreeRemoved'; payload: string }

export const initialScratchpad: ScratchpadState = {
  byWorktreePath: {}
}

export function scratchpadReducer(
  state: ScratchpadState,
  event: ScratchpadEvent
): ScratchpadState {
  switch (event.type) {
    case 'scratchpad/loaded':
      return { ...state, byWorktreePath: event.payload }
    case 'scratchpad/textChanged': {
      const { worktreePath, text } = event.payload
      if (text === '') {
        if (!(worktreePath in state.byWorktreePath)) return state
        const next = { ...state.byWorktreePath }
        delete next[worktreePath]
        return { ...state, byWorktreePath: next }
      }
      if (state.byWorktreePath[worktreePath] === text) return state
      return {
        ...state,
        byWorktreePath: { ...state.byWorktreePath, [worktreePath]: text }
      }
    }
    case 'scratchpad/worktreeRemoved': {
      if (!(event.payload in state.byWorktreePath)) return state
      const next = { ...state.byWorktreePath }
      delete next[event.payload]
      return { ...state, byWorktreePath: next }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
