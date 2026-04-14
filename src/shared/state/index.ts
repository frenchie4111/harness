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
import {
  initialOnboarding,
  onboardingReducer,
  type OnboardingEvent,
  type OnboardingState
} from './onboarding'
import {
  initialHooks,
  hooksReducer,
  type HooksEvent,
  type HooksState
} from './hooks'
import {
  initialWorktrees,
  worktreesReducer,
  type WorktreesEvent,
  type WorktreesState
} from './worktrees'

export type { SettingsState, SettingsEvent }
export type { PRsState, PRsEvent, PRStatus, CheckStatus, PRReview } from './prs'
export type { OnboardingState, OnboardingEvent, QuestStep } from './onboarding'
export type { HooksState, HooksEvent, HooksConsent } from './hooks'
export type {
  WorktreesState,
  WorktreesEvent,
  Worktree,
  PendingWorktree,
  PendingStatus
} from './worktrees'

export interface AppState {
  settings: SettingsState
  prs: PRsState
  onboarding: OnboardingState
  hooks: HooksState
  worktrees: WorktreesState
}

export type StateEvent =
  | SettingsEvent
  | PRsEvent
  | OnboardingEvent
  | HooksEvent
  | WorktreesEvent

export const initialState: AppState = {
  settings: initialSettings,
  prs: initialPRs,
  onboarding: initialOnboarding,
  hooks: initialHooks,
  worktrees: initialWorktrees
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
  if (event.type.startsWith('onboarding/')) {
    return {
      ...state,
      onboarding: onboardingReducer(state.onboarding, event as OnboardingEvent)
    }
  }
  if (event.type.startsWith('hooks/')) {
    return { ...state, hooks: hooksReducer(state.hooks, event as HooksEvent) }
  }
  if (event.type.startsWith('worktrees/')) {
    return {
      ...state,
      worktrees: worktreesReducer(state.worktrees, event as WorktreesEvent)
    }
  }
  return state
}

export interface StateSnapshot {
  state: AppState
  seq: number
}
