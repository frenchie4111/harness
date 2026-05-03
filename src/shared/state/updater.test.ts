import { describe, it, expect } from 'vitest'
import { initialUpdater, updaterReducer } from './updater'

describe('updaterReducer', () => {
  it('starts with null status', () => {
    expect(initialUpdater.status).toBeNull()
  })

  it('statusChanged sets the status', () => {
    const next = updaterReducer(initialUpdater, {
      type: 'updater/statusChanged',
      payload: { state: 'checking' }
    })
    expect(next.status).toEqual({ state: 'checking' })
  })

  it('walks through the full updater state machine', () => {
    let state = initialUpdater
    state = updaterReducer(state, {
      type: 'updater/statusChanged',
      payload: { state: 'checking' }
    })
    expect(state.status?.state).toBe('checking')
    state = updaterReducer(state, {
      type: 'updater/statusChanged',
      payload: { state: 'available', version: '1.13.0' }
    })
    expect(state.status).toEqual({ state: 'available', version: '1.13.0' })
    state = updaterReducer(state, {
      type: 'updater/statusChanged',
      payload: { state: 'downloading', percent: 42.5 }
    })
    expect(state.status).toEqual({ state: 'downloading', percent: 42.5 })
    state = updaterReducer(state, {
      type: 'updater/statusChanged',
      payload: { state: 'downloaded', version: '1.13.0' }
    })
    expect(state.status).toEqual({ state: 'downloaded', version: '1.13.0' })
  })

  it('error state preserves the message', () => {
    const next = updaterReducer(initialUpdater, {
      type: 'updater/statusChanged',
      payload: { state: 'error', error: 'no internet' }
    })
    expect(next.status).toEqual({ state: 'error', error: 'no internet' })
  })

  it('returns a new object reference', () => {
    const next = updaterReducer(initialUpdater, {
      type: 'updater/statusChanged',
      payload: { state: 'not-available' }
    })
    expect(next).not.toBe(initialUpdater)
  })

  it('available carries optional releaseUrl + manualInstallRequired', () => {
    const next = updaterReducer(initialUpdater, {
      type: 'updater/statusChanged',
      payload: {
        state: 'available',
        version: '2.8.0',
        releaseUrl: 'https://github.com/example/harness/releases/tag/v2.8.0',
        manualInstallRequired: true
      }
    })
    expect(next.status).toEqual({
      state: 'available',
      version: '2.8.0',
      releaseUrl: 'https://github.com/example/harness/releases/tag/v2.8.0',
      manualInstallRequired: true
    })
  })
})
