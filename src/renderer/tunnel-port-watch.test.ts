// Regression tests for the resync storm the port watcher caused in
// production: the backend chip strip flickered continuously and the log
// filled with `transport reconnect` at tens of events per minute.
//
// One connection accumulates several bootstrap entries over its
// lifetime (`boot-`, `hydrate-`, `reconnect-`), each pinned to whatever
// local port it bound. The watcher compared every one of them against a
// single per-connection guard, so two entries with different ports
// overwrote each other's guard on every local-store event and took
// turns kicking a rebuild — forever.

import { describe, it, expect, vi } from 'vitest'
import { watchForTunnelPortChanges, type TunnelPortWatchDeps } from './store'
import type { BootstrapProgress } from '../shared/state/ssh-bootstrap'

function entry(over: Partial<BootstrapProgress> & { bootstrapId: string }): BootstrapProgress {
  return {
    label: 'remote',
    target: 'host',
    phase: 'connected',
    lines: [],
    updatedAt: 1,
    connectionId: 'c1',
    ...over
  } as BootstrapProgress
}

function harness(over: Partial<TunnelPortWatchDeps> = {}) {
  let byId: Record<string, BootstrapProgress> = {}
  const listeners: (() => void)[] = []
  const resync = vi.fn(async () => {})
  watchForTunnelPortChanges({
    subscribe: (cb) => {
      listeners.push(cb)
      return () => {}
    },
    getById: () => byId,
    hasConnection: () => true,
    getLivePort: () => 51239,
    resync,
    ...over
  })
  return {
    resync,
    /** Replace the slice contents and notify, as a dispatch would. */
    setById(next: Record<string, BootstrapProgress>) {
      byId = next
      for (const l of listeners) l()
    },
    /** An unrelated event: same slice reference, new store notification. */
    tick() {
      for (const l of listeners) l()
    }
  }
}

describe('watchForTunnelPortChanges', () => {
  it('rebuilds once when the tunnel comes back on a different port', () => {
    const h = harness()
    h.setById({ a: entry({ bootstrapId: 'a', localPort: 40000, updatedAt: 1 }) })
    expect(h.resync).toHaveBeenCalledExactlyOnceWith('c1')
  })

  it('does nothing when the live URL already points at the bound port', () => {
    const h = harness()
    h.setById({ a: entry({ bootstrapId: 'a', localPort: 51239, updatedAt: 1 }) })
    expect(h.resync).not.toHaveBeenCalled()
  })

  it('ignores stale entries and honours only the newest attempt', () => {
    // The production storm: `boot-` bound 51186, `hydrate-` bound 51239
    // (which is what the persisted URL points at). Only the newest
    // describes reality, so nothing should be rebuilt.
    const h = harness()
    h.setById({
      'boot-c1': entry({ bootstrapId: 'boot-c1', localPort: 51186, updatedAt: 1 }),
      'hydrate-c1': entry({ bootstrapId: 'hydrate-c1', localPort: 51239, updatedAt: 2 })
    })
    expect(h.resync).not.toHaveBeenCalled()
  })

  it('does not ping-pong between two entries on repeated events', () => {
    const h = harness({ getLivePort: () => 51186 })
    const byId = {
      'boot-c1': entry({ bootstrapId: 'boot-c1', localPort: 51186, updatedAt: 1 }),
      'hydrate-c1': entry({ bootstrapId: 'hydrate-c1', localPort: 51239, updatedAt: 2 })
    }
    h.setById(byId)
    // Newest (51239) disagrees with the live URL (51186), so exactly one
    // rebuild is right. Everything after must be silent.
    expect(h.resync).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 25; i++) h.setById({ ...byId })
    expect(h.resync).toHaveBeenCalledTimes(1)
  })

  it('is inert for events that do not touch the slice', () => {
    // The subscription fires on every local-store event — terminal
    // statuses, PR polls, streaming tokens. An unchanged slice reference
    // must cost nothing.
    const getById = vi.fn(() => ({}) as Record<string, BootstrapProgress>)
    const h = harness({ getById })
    for (let i = 0; i < 50; i++) h.tick()
    expect(h.resync).not.toHaveBeenCalled()
  })

  it('does not start a second rebuild while one is still running', async () => {
    let release: () => void = () => {}
    const resync = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r
        })
    )
    const h = harness({ resync })
    h.setById({ a: entry({ bootstrapId: 'a', localPort: 40000, updatedAt: 1 }) })
    expect(resync).toHaveBeenCalledTimes(1)
    // A rebuild dispatches into this very slice; those events must not
    // re-enter while the first is in flight.
    h.setById({ a: entry({ bootstrapId: 'a', localPort: 40001, updatedAt: 2 }) })
    expect(resync).toHaveBeenCalledTimes(1)
    release()
    await Promise.resolve()
  })

  it('skips connections the registry does not know about', () => {
    const h = harness({ hasConnection: () => false })
    h.setById({ a: entry({ bootstrapId: 'a', localPort: 40000, updatedAt: 1 }) })
    expect(h.resync).not.toHaveBeenCalled()
  })

  it('ignores attempts that have not reached connected', () => {
    const h = harness()
    h.setById({
      a: entry({ bootstrapId: 'a', localPort: 40000, phase: 'reconnecting', updatedAt: 1 })
    })
    expect(h.resync).not.toHaveBeenCalled()
  })
})
