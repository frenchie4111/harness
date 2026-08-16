import { describe, it, expect } from 'vitest'
import { computeFlags, THRESHOLDS } from './renderer-perf'
import type { RendererPerfSample } from '../shared/perf-types'

function bucket(overrides: Partial<RendererPerfSample> = {}): Omit<RendererPerfSample, 'flags'> {
  const { flags: _flags, ...rest } = {
    t: 0,
    longTasks: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: 0,
    blockingMs: 0,
    slowEvents: 0,
    slowEventMaxMs: 0,
    slowEventName: null,
    heapUsedMB: 100,
    heapTotalMB: 200,
    heapLimitMB: 4096,
    heapGrowthMB: 0,
    heapReclaimedMB: 0,
    reactCommits: 0,
    reactTotalMs: 0,
    reactMaxMs: 0,
    flags: [],
    ...overrides,
  }
  return rest
}

describe('computeFlags', () => {
  it('flags nothing for an idle bucket', () => {
    expect(computeFlags(bucket())).toEqual([])
  })

  it('flags sustained blocking time', () => {
    expect(computeFlags(bucket({ blockingMs: THRESHOLDS.blockingMs }))).toContain('blocking')
  })

  it('flags a single long stall', () => {
    expect(computeFlags(bucket({ longTaskMaxMs: 250 }))).toContain('longtask')
  })

  it('flags heavy input latency', () => {
    expect(computeFlags(bucket({ slowEvents: 1, slowEventMaxMs: 180 }))).toContain('input')
  })

  it('flags allocate-and-collect churn', () => {
    expect(computeFlags(bucket({ heapReclaimedMB: 300 }))).toContain('gc')
  })

  // The regression this instrumentation exists for: the old per-commit gate
  // was 16ms, so a second made of many sub-16ms commits scored zero. The
  // aggregate has to catch it.
  it('flags death by a thousand sub-frame commits', () => {
    const manySmallCommits = bucket({ reactCommits: 40, reactTotalMs: 180, reactMaxMs: 6 })
    expect(manySmallCommits.reactMaxMs).toBeLessThan(16)
    expect(computeFlags(manySmallCommits)).toContain('react')
  })

  it('does not flag a quiet second with one cheap commit', () => {
    expect(computeFlags(bucket({ reactCommits: 1, reactTotalMs: 3, reactMaxMs: 3 }))).toEqual([])
  })

  it('reports every tripped threshold, not just the first', () => {
    const bad = bucket({
      blockingMs: 400,
      longTaskMaxMs: 300,
      reactTotalMs: 200,
      slowEventMaxMs: 250,
      slowEvents: 3,
      heapReclaimedMB: 120,
    })
    expect(computeFlags(bad).sort()).toEqual(['blocking', 'gc', 'input', 'longtask', 'react'])
  })
})
