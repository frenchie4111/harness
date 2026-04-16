export type HooksConsent = 'pending' | 'accepted' | 'declined'

export interface HooksState {
  /** User's choice about installing Harness's status hooks at user scope
   *  (~/.claude/settings.json, ~/.codex/hooks.json). The hook command is
   *  env-gated on $HARNESS_TERMINAL_ID, so sessions outside Harness aren't
   *  affected. Main seeds this on boot from config.hooksConsent; the accept
   *  / decline / uninstall IPC handlers keep the persisted copy in sync. */
  consent: HooksConsent
}

export type HooksEvent =
  | { type: 'hooks/consentChanged'; payload: HooksConsent }

export const initialHooks: HooksState = {
  consent: 'pending'
}

export function hooksReducer(state: HooksState, event: HooksEvent): HooksState {
  switch (event.type) {
    case 'hooks/consentChanged':
      return { ...state, consent: event.payload }
  }
  return state
}
