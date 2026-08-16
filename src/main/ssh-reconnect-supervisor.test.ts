import { describe, it, expect, vi } from 'vitest'
import {
  SshReconnectSupervisor,
  type SshReconnectSupervisorDeps
} from './ssh-reconnect-supervisor'

/** Manual clock: `setTimer` records the pending callback instead of
 *  arming a real timer, so a test can walk many backoff rounds without
 *  waiting 30 seconds. */
function fakeTimers() {
  const armed: {
    cb: () => void
    ms: number
    handle: number
    cleared: boolean
    fired?: boolean
  }[] = []
  let next = 1
  return {
    armed,
    setTimer: (cb: () => void, ms: number) => {
      const handle = next++
      armed.push({ cb, ms, handle, cleared: false })
      return handle
    },
    clearTimer: (handle: number | ReturnType<typeof setTimeout>) => {
      const found = armed.find((a) => a.handle === handle)
      if (found) found.cleared = true
    },
    /** Fire the most recently armed, still-pending timer. */
    async fire(): Promise<void> {
      const pending = armed.filter((a) => !a.cleared && !a.fired)
      const target = pending[pending.length - 1]
      if (!target) throw new Error('no timer armed')
      target.fired = true
      target.cb()
      await new Promise((r) => setImmediate(r))
    },
    delays: (): number[] => armed.map((a) => a.ms)
  }
}

function make(overrides: Partial<SshReconnectSupervisorDeps> = {}) {
  const timers = fakeTimers()
  const reconnect = vi.fn(async () => {})
  const deps: SshReconnectSupervisorDeps = {
    reconnect,
    connectionExists: () => true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    // Full jitter with random()=1 collapses to the deterministic
    // ceiling, so backoff growth is assertable.
    random: () => 1,
    ...overrides
  }
  return { sup: new SshReconnectSupervisor(deps), timers, reconnect, deps }
}

describe('SshReconnectSupervisor', () => {
  it('arms a retry on drop and reconnects when the timer fires', async () => {
    const { sup, timers, reconnect } = make()
    sup.notifyDropped('a')
    expect(sup.isRetrying('a')).toBe(true)
    expect(reconnect).not.toHaveBeenCalled()

    await timers.fire()
    expect(reconnect).toHaveBeenCalledExactlyOnceWith('a')
    // Success ends the loop — no lingering retry state.
    expect(sup.isRetrying('a')).toBe(false)
  })

  it('backs off exponentially to a 30s cap across failures', async () => {
    const reconnect = vi.fn(async () => {
      throw new Error('still down')
    })
    const { sup, timers } = make({ reconnect })
    sup.notifyDropped('a')
    for (let i = 0; i < 8; i++) await timers.fire()

    const delays = timers.delays()
    expect(delays[0]).toBe(1_000)
    expect(delays[1]).toBe(2_000)
    expect(delays[2]).toBe(4_000)
    expect(delays[3]).toBe(8_000)
    expect(delays[4]).toBe(16_000)
    // Capped from here on — retries never stop, they just stop growing.
    expect(delays.slice(5)).toEqual(delays.slice(5).map(() => 30_000))
    expect(sup.isRetrying('a')).toBe(true)
  })

  it('applies jitter rather than retrying in lockstep', async () => {
    // The first delay is always the 1s floor, so jitter only shows up
    // once the ceiling has grown past it. Two supervisors with different
    // random sources must diverge — that's the whole point, since a
    // laptop waking from sleep drops every tunnel simultaneously.
    const failing = async (): Promise<void> => {
      throw new Error('down')
    }
    const { sup: a, timers: ta } = make({ random: () => 0.25, reconnect: vi.fn(failing) })
    const { sup: b, timers: tb } = make({ random: () => 0.9, reconnect: vi.fn(failing) })
    a.notifyDropped('x')
    b.notifyDropped('x')
    for (let i = 0; i < 3; i++) {
      await ta.fire()
      await tb.fire()
    }
    expect(ta.delays().at(-1)).not.toBe(tb.delays().at(-1))
  })

  it('never schedules below the 1s floor even with random()=0', () => {
    const { sup, timers } = make({ random: () => 0 })
    sup.notifyDropped('a')
    expect(timers.delays()[0]).toBe(1_000)
  })

  it('ignores a repeat drop while a retry is already armed', () => {
    const { sup, timers } = make()
    sup.notifyDropped('a')
    sup.notifyDropped('a')
    sup.notifyDropped('a')
    expect(timers.armed).toHaveLength(1)
  })

  it('does not start retrying a backend that is not in the connections list', () => {
    const { sup, timers } = make({ connectionExists: () => false })
    sup.notifyDropped('gone')
    expect(sup.isRetrying('gone')).toBe(false)
    expect(timers.armed).toHaveLength(0)
  })

  it('cancel clears the armed timer and stops the loop', () => {
    const { sup, timers } = make()
    sup.notifyDropped('a')
    sup.cancel('a')
    expect(sup.isRetrying('a')).toBe(false)
    expect(timers.armed[0].cleared).toBe(true)
  })

  it('a cancelled loop does not reconnect even if its timer still fires', async () => {
    // clearTimer can lose a race against a callback already queued on
    // the event loop, so cancellation must also be checked inside the
    // attempt — otherwise removing a backend can still kick off an SSH
    // handshake for it.
    const { sup, timers, reconnect } = make()
    sup.notifyDropped('a')
    sup.cancel('a')
    timers.armed[0].cb()
    await new Promise((r) => setImmediate(r))
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('stops retrying once the backend disappears from the connections list', async () => {
    let exists = true
    const reconnect = vi.fn(async () => {
      throw new Error('down')
    })
    const { sup, timers } = make({ reconnect, connectionExists: () => exists })
    sup.notifyDropped('a')
    exists = false
    await timers.fire()
    expect(reconnect).not.toHaveBeenCalled()
    expect(sup.isRetrying('a')).toBe(false)
  })

  it('cancelAll drops every pending timer (clean app quit)', () => {
    const { sup, timers } = make()
    sup.notifyDropped('a')
    sup.notifyDropped('b')
    sup.cancelAll()
    expect(sup.isRetrying('a')).toBe(false)
    expect(sup.isRetrying('b')).toBe(false)
    expect(timers.armed.every((t) => t.cleared)).toBe(true)
  })

  it('reports disconnected-while-waiting then reconnecting-during-attempt', async () => {
    const onAttemptState = vi.fn()
    const reconnect = vi.fn(async () => {
      throw new Error('down')
    })
    const { sup, timers } = make({ reconnect, onAttemptState })
    sup.notifyDropped('a')
    expect(onAttemptState).toHaveBeenCalledWith('a', {
      phase: 'disconnected',
      attempt: 0,
      delayMs: 1_000
    })
    await timers.fire()
    expect(onAttemptState).toHaveBeenCalledWith('a', { phase: 'reconnecting', attempt: 0 })
    expect(onAttemptState).toHaveBeenCalledWith('a', {
      phase: 'disconnected',
      attempt: 1,
      delayMs: 2_000
    })
  })

  it('restarts backoff from 1s after a drop that follows a successful recovery', async () => {
    let fail = true
    const reconnect = vi.fn(async () => {
      if (fail) throw new Error('down')
    })
    const { sup, timers } = make({ reconnect })
    sup.notifyDropped('a')
    await timers.fire()
    await timers.fire()
    expect(timers.delays()).toEqual([1_000, 2_000, 4_000])

    fail = false
    await timers.fire()
    expect(sup.isRetrying('a')).toBe(false)

    sup.notifyDropped('a')
    expect(timers.delays().at(-1)).toBe(1_000)
  })
})
