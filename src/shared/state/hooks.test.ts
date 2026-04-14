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

  it('justInstalledChanged toggles the flag', () => {
    const on = hooksReducer(initialHooks, {
      type: 'hooks/justInstalledChanged',
      payload: true
    })
    expect(on.justInstalled).toBe(true)
    const off = hooksReducer(on, {
      type: 'hooks/justInstalledChanged',
      payload: false
    })
    expect(off.justInstalled).toBe(false)
  })

  it('leaves unrelated fields untouched', () => {
    const start: HooksState = { consent: 'accepted', justInstalled: true }
    const next = hooksReducer(start, {
      type: 'hooks/consentChanged',
      payload: 'declined'
    })
    expect(next.consent).toBe('declined')
    expect(next.justInstalled).toBe(true)
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
