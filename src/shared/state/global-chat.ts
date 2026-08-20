// App-scoped chat session. The conversation itself lives in the
// jsonClaude slice like any other Chat tab — this slice only holds what
// makes an app-scoped session findable without a pane to hang it off:
// which session id is the app's, the Ness-owned directory it runs in,
// and whether Claude Code is authenticated at all.
//
// The auth field is here rather than derived in the renderer because a
// fresh install shares an empty ~/.claude/ with the bundled binary, and
// the global session cannot usefully spawn until that's fixed. Main
// resolves it (reading ~/.claude.json + the configured env vars) and
// every window mirrors the answer.

export type GlobalChatAuth = 'unknown' | 'ok' | 'required'

export interface GlobalChatState {
  /** Session id of the app-scoped chat, or null before one is minted.
   *  Doubles as the jsonClaude slice key, same as a Chat tab's id. */
  sessionId: string | null
  /** cwd the subprocess runs in. Ness-owned, not a worktree — that's
   *  what makes the transcript path and slash-command probe resolve
   *  without the session belonging to any repo. */
  cwd: string
  auth: GlobalChatAuth
}

export type GlobalChatEvent =
  | {
      type: 'globalChat/sessionAssigned'
      payload: { sessionId: string; cwd: string }
    }
  | { type: 'globalChat/authChanged'; payload: GlobalChatAuth }

export const initialGlobalChat: GlobalChatState = {
  sessionId: null,
  cwd: '',
  auth: 'unknown'
}

export function globalChatReducer(
  state: GlobalChatState,
  event: GlobalChatEvent
): GlobalChatState {
  switch (event.type) {
    case 'globalChat/sessionAssigned': {
      const { sessionId, cwd } = event.payload
      if (state.sessionId === sessionId && state.cwd === cwd) return state
      return { ...state, sessionId, cwd }
    }
    case 'globalChat/authChanged': {
      if (state.auth === event.payload) return state
      return { ...state, auth: event.payload }
    }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
