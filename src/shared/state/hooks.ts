export type HooksConsent = 'pending' | 'accepted' | 'declined'

export interface HooksState {
  /** User's choice about installing Codex status hooks at user scope
   *  (~/.codex/hooks.json). Claude no longer requires consent — its
   *  hooks ship as a plugin loaded via --plugin-dir on every spawn, so
   *  no user file is touched. The Codex hook command is env-gated on
   *  $HARNESS_TERMINAL_ID, so sessions outside Harness aren't affected.
   *  Main seeds this on boot from config.hooksConsent; the accept /
   *  decline / uninstall IPC handlers keep the persisted copy in sync. */
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
