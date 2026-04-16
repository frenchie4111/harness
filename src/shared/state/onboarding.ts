export type QuestStep = 'pick-agent' | 'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'

export interface OnboardingState {
  quest: QuestStep
}

export type OnboardingEvent = {
  type: 'onboarding/questChanged'
  payload: QuestStep
}

export const initialOnboarding: OnboardingState = {
  quest: 'hidden'
}

export function onboardingReducer(
  state: OnboardingState,
  event: OnboardingEvent
): OnboardingState {
  switch (event.type) {
    case 'onboarding/questChanged':
      return { ...state, quest: event.payload }
    default: {
      const _exhaustive: never = event.type
      void _exhaustive
      return state
    }
  }
}
