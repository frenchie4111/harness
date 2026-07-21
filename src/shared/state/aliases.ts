export interface AliasesState {
  byPath: Record<string, string>
}

export const initialAliases: AliasesState = {
  byPath: {}
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
