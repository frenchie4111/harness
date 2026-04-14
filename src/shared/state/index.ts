import {
  initialSettings,
  settingsReducer,
  type SettingsEvent,
  type SettingsState
} from './settings'
import {
  initialPRs,
  prsReducer,
  type PRsEvent,
  type PRsState
} from './prs'

export type { SettingsState, SettingsEvent }
export type { PRsState, PRsEvent, PRStatus, CheckStatus, PRReview } from './prs'

export interface AppState {
  settings: SettingsState
  prs: PRsState
}

export type StateEvent = SettingsEvent | PRsEvent

export const initialState: AppState = {
  settings: initialSettings,
  prs: initialPRs
}

export function rootReducer(state: AppState, event: StateEvent): AppState {
  if (event.type.startsWith('settings/')) {
    return {
      ...state,
      settings: settingsReducer(state.settings, event as SettingsEvent)
    }
  }
  if (event.type.startsWith('prs/')) {
    return { ...state, prs: prsReducer(state.prs, event as PRsEvent) }
  }
  return state
}

export interface StateSnapshot {
  state: AppState
  seq: number
}
