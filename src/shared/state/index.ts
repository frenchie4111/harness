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
import {
  initialTerminals,
  terminalsReducer,
  type TerminalsEvent,
  type TerminalsState
} from './terminals'
import {
  initialUpdater,
  updaterReducer,
  type UpdaterEvent,
  type UpdaterState
} from './updater'
import {
  initialRepoConfigs,
  repoConfigsReducer,
  type RepoConfigsEvent,
  type RepoConfigsState
} from './repo-configs'

export type { SettingsState, SettingsEvent }
export type { UpdaterState, UpdaterEvent, UpdaterStatus } from './updater'
export type {
  RepoConfigsState,
  RepoConfigsEvent,
  RepoConfig
} from './repo-configs'
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
export type {
  TerminalsState,
  TerminalsEvent,
  PtyStatus,
  PendingTool,
  ShellActivity,
  TerminalTab,
  WorkspacePane
} from './terminals'

export interface AppState {
  settings: SettingsState
  prs: PRsState
  onboarding: OnboardingState
  hooks: HooksState
  worktrees: WorktreesState
  terminals: TerminalsState
  updater: UpdaterState
  repoConfigs: RepoConfigsState
}

export type StateEvent =
  | SettingsEvent
  | PRsEvent
  | OnboardingEvent
  | HooksEvent
  | WorktreesEvent
  | TerminalsEvent
  | UpdaterEvent
  | RepoConfigsEvent

export const initialState: AppState = {
  settings: initialSettings,
  prs: initialPRs,
  onboarding: initialOnboarding,
  hooks: initialHooks,
  worktrees: initialWorktrees,
  terminals: initialTerminals,
  updater: initialUpdater,
  repoConfigs: initialRepoConfigs
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
  if (event.type.startsWith('terminals/')) {
    return {
      ...state,
      terminals: terminalsReducer(state.terminals, event as TerminalsEvent)
    }
  }
  if (event.type.startsWith('updater/')) {
    return { ...state, updater: updaterReducer(state.updater, event as UpdaterEvent) }
  }
  if (event.type.startsWith('repoConfigs/')) {
    return {
      ...state,
      repoConfigs: repoConfigsReducer(state.repoConfigs, event as RepoConfigsEvent)
    }
  }
  return state
}

export interface StateSnapshot {
  state: AppState
  seq: number
}
