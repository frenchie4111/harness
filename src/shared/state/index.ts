import {
  initialSettings,
  settingsReducer,
  type SettingsEvent,
  type SettingsState
} from './settings'

export type { SettingsState, SettingsEvent }

export interface AppState {
  settings: SettingsState
}

export type StateEvent = SettingsEvent

export const initialState: AppState = {
  settings: initialSettings
}

export function rootReducer(state: AppState, event: StateEvent): AppState {
  return {
    ...state,
    settings: settingsReducer(state.settings, event)
  }
}

export interface StateSnapshot {
  state: AppState
  seq: number
}
