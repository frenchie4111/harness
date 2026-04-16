import { describe, it, expect } from 'vitest'
import { initialHooks, hooksReducer, type HooksState } from './hooks'

describe('hooksReducer', () => {
  it('consentChanged transitions through all three states', () => {
    let state: HooksState = initialHooks
    expect(state.consent).toBe('pending')
    state = hooksReducer(state, { type: 'hooks/consentChanged', payload: 'accepted' })
    expect(state.consent).toBe('accepted')
    state = hooksReducer(state, { type: 'hooks/consentChanged', payload: 'declined' })
    expect(state.consent).toBe('declined')
    state = hooksReducer(state, { type: 'hooks/consentChanged', payload: 'pending' })
    expect(state.consent).toBe('pending')
  })

  it('returns a new object reference', () => {
    const next = hooksReducer(initialHooks, {
      type: 'hooks/consentChanged',
      payload: 'accepted'
    })
    expect(next).not.toBe(initialHooks)
    expect(initialHooks.consent).toBe('pending')
  })
})
