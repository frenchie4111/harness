import { describe, it, expect, beforeEach } from 'vitest'
import {
  runGitRead,
  gitLimiterStats,
  resetGitLimiter,
  MAX_CONCURRENT_GIT_READS
} from './git-limiter'

/** A promise plus its resolver, so a test can hold a git read open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Let the microtask queue drain so pending acquires settle. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('git-limiter', () => {
  beforeEach(() => {
    resetGitLimiter()
  })

  it('runs up to the cap concurrently', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_GIT_READS }, deferred)
    let started = 0
    const runs = gates.map((g) =>
      runGitRead('interactive', async () => {
        started++
        await g.promise
      })
    )
    await tick()

    expect(started).toBe(MAX_CONCURRENT_GIT_READS)
    gates.forEach((g) => g.resolve())
    await Promise.all(runs)
  })

  it('queues work past the cap', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_GIT_READS }, deferred)
    let started = 0
    const runs = gates.map((g) =>
      runGitRead('interactive', async () => {
        started++
        await g.promise
      })
    )
    const extra = runGitRead('interactive', async () => {
      started++
    })
    await tick()

    expect(started).toBe(MAX_CONCURRENT_GIT_READS)
    expect(gitLimiterStats().interactiveQueued).toBe(1)

    gates.forEach((g) => g.resolve())
    await Promise.all([...runs, extra])
    expect(started).toBe(MAX_CONCURRENT_GIT_READS + 1)
  })

  it('dequeues interactive work ahead of bulk work already waiting', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_GIT_READS }, deferred)
    const blockers = gates.map((g) => runGitRead('interactive', () => g.promise))
    await tick()

    const order: string[] = []
    // The queued items hold their own permit open, so freeing one permit at a
    // time makes the dequeue order directly observable.
    const bulkGate = deferred()
    const interactiveGate = deferred()
    // Bulk enqueues first, interactive second — priority must still win.
    const bulk = runGitRead('bulk', async () => {
      order.push('bulk')
      await bulkGate.promise
    })
    const interactive = runGitRead('interactive', async () => {
      order.push('interactive')
      await interactiveGate.promise
    })
    await tick()
    expect(order).toEqual([])

    gates[0].resolve()
    await tick()
    expect(order).toEqual(['interactive'])

    gates[1].resolve()
    await tick()
    expect(order).toEqual(['interactive', 'bulk'])

    gates.slice(2).forEach((g) => g.resolve())
    bulkGate.resolve()
    interactiveGate.resolve()
    await Promise.all([...blockers, bulk, interactive])
  })

  it('releases the permit when the operation throws', async () => {
    await expect(
      runGitRead('interactive', async () => {
        throw new Error('git exploded')
      })
    ).rejects.toThrow('git exploded')

    expect(gitLimiterStats().active).toBe(0)

    // A subsequent read still gets a permit rather than hanging.
    await expect(runGitRead('interactive', async () => 'ok')).resolves.toBe('ok')
  })

  it('drains bulk work once interactive work is done', async () => {
    const done: number[] = []
    const all = Array.from({ length: MAX_CONCURRENT_GIT_READS * 3 }, (_, i) =>
      runGitRead(i % 2 === 0 ? 'bulk' : 'interactive', async () => {
        done.push(i)
      })
    )
    await Promise.all(all)

    expect(done).toHaveLength(MAX_CONCURRENT_GIT_READS * 3)
    expect(gitLimiterStats()).toEqual({
      active: 0,
      interactiveQueued: 0,
      bulkQueued: 0
    })
  })
})
