import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const psb = vi.hoisted(() => {
  let nextId = 1
  const started = new Set<number>()
  return {
    start: vi.fn(() => {
      const id = nextId++
      started.add(id)
      return id
    }),
    stop: vi.fn((id: number) => {
      started.delete(id)
    }),
    isStarted: vi.fn((id: number) => started.has(id)),
    started,
    reset(): void {
      nextId = 1
      started.clear()
      this.start.mockClear()
      this.stop.mockClear()
      this.isStarted.mockClear()
    }
  }
})

vi.mock('electron', () => ({ powerSaveBlocker: psb }))
vi.mock('./debug', () => ({ log: () => {} }))

import { Store } from './store'
import { WakeLockController } from './wake-lock-controller'
import { initialState, type AppState } from '../shared/state'
import type { PreventSleepMode } from '../shared/state/settings'

const TERM = 't1'

function stateWith(mode: PreventSleepMode): AppState {
  return {
    ...initialState,
    settings: { ...initialState.settings, preventSleepMode: mode }
  }
}

function held(): boolean {
  return psb.started.size > 0
}

describe('WakeLockController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    psb.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('off mode never engages the blocker', () => {
    const ctrl = new WakeLockController(new Store(stateWith('off')))
    ctrl.start()
    expect(psb.start).not.toHaveBeenCalled()
    expect(held()).toBe(false)
    ctrl.stop()
  })

  it('always mode engages at start and releases on stop', () => {
    const ctrl = new WakeLockController(new Store(stateWith('always')))
    ctrl.start()
    expect(psb.start).toHaveBeenCalledTimes(1)
    expect(held()).toBe(true)
    ctrl.stop()
    expect(held()).toBe(false)
  })

  it('while-agents-running engages only while a terminal is processing', () => {
    const store = new Store(stateWith('while-agents-running'))
    const ctrl = new WakeLockController(store)
    ctrl.start()
    expect(held()).toBe(false)

    store.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: TERM, status: 'processing', pendingTool: null }
    })
    expect(held()).toBe(true)
    expect(psb.start).toHaveBeenCalledTimes(1)

    store.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: TERM, status: 'idle', pendingTool: null }
    })
    expect(held()).toBe(false)
    ctrl.stop()
  })

  it('keeps a single blocker across repeated processing events (no leak)', () => {
    const store = new Store(stateWith('while-agents-running'))
    const ctrl = new WakeLockController(store)
    ctrl.start()
    for (let i = 0; i < 5; i++) {
      store.dispatch({
        type: 'terminals/statusChanged',
        payload: { id: `t${i}`, status: 'processing', pendingTool: null }
      })
    }
    expect(psb.start).toHaveBeenCalledTimes(1)
    expect(psb.started.size).toBe(1)
    ctrl.stop()
  })

  it('engages immediately when the mode flips on while an agent is already processing', () => {
    const store = new Store(stateWith('off'))
    const ctrl = new WakeLockController(store)
    ctrl.start()
    store.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: TERM, status: 'processing', pendingTool: null }
    })
    expect(held()).toBe(false) // mode is off

    store.dispatch({ type: 'settings/preventSleepModeChanged', payload: 'while-agents-running' })
    expect(held()).toBe(true)
    ctrl.stop()
  })

  it('the temporary timer engages and auto-releases + clears on expiry', () => {
    const store = new Store(stateWith('off'))
    const ctrl = new WakeLockController(store)
    ctrl.start()

    const until = Date.now() + 60_000
    store.dispatch({ type: 'settings/preventSleepUntilChanged', payload: until })
    expect(held()).toBe(true)

    // Advance past the deadline; the 30s tick re-evaluates and expires it.
    vi.advanceTimersByTime(90_000)
    expect(held()).toBe(false)
    expect(store.getSnapshot().state.settings.preventSleepUntil).toBeNull()
    ctrl.stop()
  })

  it('seeds the processing-set from existing status at start (boot)', () => {
    // A terminal is already processing before the controller subscribes.
    const store = new Store(stateWith('while-agents-running'))
    store.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: TERM, status: 'processing', pendingTool: null }
    })
    const ctrl = new WakeLockController(store)
    ctrl.start()
    expect(held()).toBe(true) // reconciled from status, not just live events
    ctrl.stop()
  })
})
