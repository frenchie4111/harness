export interface AliasesState {
  byPath: Record<string, string>
}

export const initialAliases: AliasesState = {
  byPath: {}
}

/** Maximum stored alias length (code units). The sidebar and pane header
 *  truncate visually beyond this, but the store keeps the full clamped
 *  string. Kept as a shared constant so the IPC handler, the MCP
 *  control-server dep, and the AliasEditor input's `maxLength` don't
 *  drift apart. */
export const ALIAS_MAX_LEN = 80

/** Trim and clamp a user-supplied alias to the storage shape.
 *  Returns `null` for empty-after-trim — callers should route to
 *  `aliases/cleared` in that case rather than storing an empty string.
 *  Callers should use this for BOTH the input side (before dispatch) and
 *  any echo/response so the two never disagree on what got stored. */
export function normalizeAlias(input: string): string | null {
  const trimmed = input.trim().slice(0, ALIAS_MAX_LEN)
  return trimmed ? trimmed : null
}

export type AliasesEvent =
  | { type: 'aliases/set'; payload: { path: string; alias: string } }
  | { type: 'aliases/cleared'; payload: { path: string } }

export function aliasesReducer(
  state: AliasesState,
  event: AliasesEvent
): AliasesState {
  switch (event.type) {
    case 'aliases/set': {
      const { path, alias } = event.payload
      if (state.byPath[path] === alias) return state
      return { ...state, byPath: { ...state.byPath, [path]: alias } }
    }
    case 'aliases/cleared': {
      const { path } = event.payload
      if (!(path in state.byPath)) return state
      const next = { ...state.byPath }
      delete next[path]
      return { ...state, byPath: next }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
