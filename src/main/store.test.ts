import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Store } from './store'
import { initialState, type StateEvent } from '../shared/state'
import { perfLog } from './perf-log'

vi.mock('./perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

describe('Store', () => {
  it('returns the initial snapshot with seq=0', () => {
    const store = new Store()
    const snap = store.getSnapshot()
    expect(snap.seq).toBe(0)
    expect(snap.state).toEqual(initialState)
  })

  it('applies dispatched events through the reducer', () => {
    const store = new Store()
    store.dispatch({ type: 'settings/themeChanged', payload: 'solarized' })
    expect(store.getSnapshot().state.settings.theme).toBe('solarized')
  })

  it('increments seq monotonically per dispatch', () => {
    const store = new Store()
    store.dispatch({ type: 'settings/themeChanged', payload: 'a' })
    expect(store.getSnapshot().seq).toBe(1)
    store.dispatch({ type: 'settings/themeChanged', payload: 'b' })
    expect(store.getSnapshot().seq).toBe(2)
    store.dispatch({ type: 'settings/nameClaudeSessionsChanged', payload: true })
    expect(store.getSnapshot().seq).toBe(3)
  })

  it('notifies subscribers on dispatch with (event, seq)', () => {
    const store = new Store()
    const spy = vi.fn()
    store.subscribe(spy)
    const event: StateEvent = { type: 'settings/themeChanged', payload: 'c' }
    store.dispatch(event)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(event, 1)
  })

  it('fans out to multiple subscribers', () => {
    const store = new Store()
    const a = vi.fn()
    const b = vi.fn()
    store.subscribe(a)
    store.subscribe(b)
    store.dispatch({ type: 'settings/themeChanged', payload: 'd' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe removes the listener', () => {
    const store = new Store()
    const spy = vi.fn()
    const unsubscribe = store.subscribe(spy)
    unsubscribe()
    store.dispatch({ type: 'settings/themeChanged', payload: 'e' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not mutate the previous snapshot object after dispatch', () => {
    const store = new Store()
    const before = store.getSnapshot().state
    store.dispatch({ type: 'settings/themeChanged', payload: 'mutated?' })
    // The old reference should still hold the old theme — proves we're
    // producing new objects through the reducer, not mutating in place.
    expect(before.settings.theme).not.toBe('mutated?')
  })

  it('accepts a custom initial state', () => {
    const store = new Store({
      ...initialState,
      settings: { ...initialState.settings, theme: 'preseeded' }
    })
    expect(store.getSnapshot().state.settings.theme).toBe('preseeded')
    expect(store.getSnapshot().seq).toBe(0)
  })
})

describe('Store cascade detection', () => {
  beforeEach(() => {
    vi.mocked(perfLog).mockClear()
  })

  function cascadeCalls(): unknown[][] {
    return vi.mocked(perfLog).mock.calls.filter((c) => c[0] === 'cascade')
  }

  it('does not log a cascade for a plain dispatch with no nested dispatches', () => {
    const store = new Store()
    store.dispatch({ type: 'settings/themeChanged', payload: 'a' })
    expect(cascadeCalls()).toHaveLength(0)
  })

  it('logs a cascade when a subscriber fires more than the threshold of nested dispatches', () => {
    const store = new Store()
    let fired = false
    store.subscribe((event) => {
      if (event.type === 'settings/themeChanged' && !fired) {
        fired = true
        for (let i = 0; i < 16; i++) {
          store.dispatch({ type: 'settings/nameClaudeSessionsChanged', payload: i % 2 === 0 })
        }
      }
    })
    store.dispatch({ type: 'settings/themeChanged', payload: 'root' })
    const calls = cascadeCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toContain('settings/themeChanged')
    expect(calls[0][1]).toContain('16 nested dispatches')
    expect(calls[0][2]).toEqual({ rootEvent: 'settings/themeChanged', childCount: 16 })
  })

  it('does not log when nested dispatches stay at or below the threshold', () => {
    const store = new Store()
    let fired = false
    store.subscribe((event) => {
      if (event.type === 'settings/themeChanged' && !fired) {
        fired = true
        for (let i = 0; i < 10; i++) {
          store.dispatch({ type: 'settings/nameClaudeSessionsChanged', payload: true })
        }
      }
    })
    store.dispatch({ type: 'settings/themeChanged', payload: 'root' })
    expect(cascadeCalls()).toHaveLength(0)
  })

  it('treats sequential top-level dispatches independently', () => {
    const store = new Store()
    let cascadeOnNext = false
    let fired = false
    store.subscribe((event) => {
      if (cascadeOnNext && event.type === 'settings/themeChanged' && !fired) {
        fired = true
        for (let i = 0; i < 16; i++) {
          store.dispatch({ type: 'settings/nameClaudeSessionsChanged', payload: true })
        }
      }
    })
    store.dispatch({ type: 'settings/themeChanged', payload: 'first' })
    expect(cascadeCalls()).toHaveLength(0)
    cascadeOnNext = true
    store.dispatch({ type: 'settings/themeChanged', payload: 'second' })
    const calls = cascadeCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0][2]).toEqual({ rootEvent: 'settings/themeChanged', childCount: 16 })
  })
})
