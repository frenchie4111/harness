export interface SettingsState {
  theme: string
}

export type SettingsEvent = { type: 'settings/themeChanged'; payload: string }

export const initialSettings: SettingsState = {
  theme: 'dark'
}

export function settingsReducer(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case 'settings/themeChanged':
      return { ...state, theme: event.payload }
    default: {
      const _exhaustive: never = event.type
      void _exhaustive
      return state
    }
  }
}
