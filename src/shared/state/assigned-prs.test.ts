import { describe, it, expect } from 'vitest'
import {
  initialAssignedPRs,
  assignedPRsReducer,
  type AssignedPR,
  type AssignedPRsEvent,
  type AssignedPRsState
} from './assigned-prs'

function apply(state: AssignedPRsState, event: AssignedPRsEvent): AssignedPRsState {
  return assignedPRsReducer(state, event)
}

const samplePR: AssignedPR = {
  number: 42,
  title: 'Fix a thing',
  url: 'https://github.com/acme/repo/pull/42',
  branch: 'fix-a-thing',
  repoRoot: '/Users/me/code/repo',
  repoNameWithOwner: 'acme/repo',
  author: { login: 'contributor', avatarUrl: null as unknown as string },
  isDraft: false,
  updatedAt: '2026-07-20T10:00:00Z'
}

describe('assignedPRsReducer', () => {
  it('loadingChanged toggles the flag', () => {
    expect(initialAssignedPRs.loading).toBe(false)
    const on = apply(initialAssignedPRs, {
      type: 'assignedPRs/loadingChanged',
      payload: true
    })
    expect(on.loading).toBe(true)
    const off = apply(on, { type: 'assignedPRs/loadingChanged', payload: false })
    expect(off.loading).toBe(false)
  })

  it('loadingChanged is a no-op when unchanged (preserves reference)', () => {
    const same = apply(initialAssignedPRs, {
      type: 'assignedPRs/loadingChanged',
      payload: false
    })
    expect(same).toBe(initialAssignedPRs)
  })

  it('dataUpdated replaces byRepo and records fetchedAt', () => {
    const next = apply(initialAssignedPRs, {
      type: 'assignedPRs/dataUpdated',
      payload: {
        byRepo: { '/Users/me/code/repo': [samplePR] },
        fetchedAt: 1234
      }
    })
    expect(next.byRepo['/Users/me/code/repo']).toHaveLength(1)
    expect(next.byRepo['/Users/me/code/repo'][0].number).toBe(42)
    expect(next.lastFetchAt).toBe(1234)
  })

  it('cleared resets to empty', () => {
    const populated = apply(initialAssignedPRs, {
      type: 'assignedPRs/dataUpdated',
      payload: {
        byRepo: { '/Users/me/code/repo': [samplePR] },
        fetchedAt: 100
      }
    })
    const cleared = apply(populated, { type: 'assignedPRs/cleared' })
    expect(cleared.byRepo).toEqual({})
    expect(cleared.lastFetchAt).toBeNull()
    expect(cleared.loading).toBe(false)
  })

  it('cleared on already-empty state is a no-op (preserves reference)', () => {
    const same = apply(initialAssignedPRs, { type: 'assignedPRs/cleared' })
    expect(same).toBe(initialAssignedPRs)
  })
})
