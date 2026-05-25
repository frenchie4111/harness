import { describe, it, expect } from 'vitest'
import { initialOnboarding, onboardingReducer } from './onboarding'

describe('onboardingReducer', () => {
  it('questChanged sets the quest step', () => {
    const next = onboardingReducer(initialOnboarding, {
      type: 'onboarding/questChanged',
      payload: 'spawn-second'
    })
    expect(next.quest).toBe('spawn-second')
  })

  it('walks through every quest step', () => {
    const steps: Array<'hidden' | 'spawn-second' | 'switch-between' | 'finale' | 'done'> = [
      'hidden',
      'spawn-second',
      'switch-between',
      'finale',
      'done'
    ]
    let state = initialOnboarding
    for (const s of steps) {
      state = onboardingReducer(state, { type: 'onboarding/questChanged', payload: s })
      expect(state.quest).toBe(s)
    }
  })

  it('returns a new object reference', () => {
    const next = onboardingReducer(initialOnboarding, {
      type: 'onboarding/questChanged',
      payload: 'done'
    })
    expect(next).not.toBe(initialOnboarding)
    expect(initialOnboarding.quest).toBe('hidden')
  })
})
