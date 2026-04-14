export type HooksConsent = 'pending' | 'accepted' | 'declined'

export interface HooksState {
  /** User's choice about installing the Claude Code status hooks into each
   * worktree's .claude/settings.local.json. On boot, main auto-detects this
   * as 'accepted' if any known worktree already has the hooks installed;
   * otherwise it stays 'pending' until the user clicks Accept/Decline. */
  consent: HooksConsent
  /** Flipped to true right after a bulk install so the renderer can show a
   * "just installed" confirmation. Never resets until the app restarts. */
  justInstalled: boolean
}

export type HooksEvent =
  | { type: 'hooks/consentChanged'; payload: HooksConsent }
  | { type: 'hooks/justInstalledChanged'; payload: boolean }

export const initialHooks: HooksState = {
  consent: 'pending',
  justInstalled: false
}

export function hooksReducer(state: HooksState, event: HooksEvent): HooksState {
  switch (event.type) {
    case 'hooks/consentChanged':
      return { ...state, consent: event.payload }
    case 'hooks/justInstalledChanged':
      return { ...state, justInstalled: event.payload }
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
