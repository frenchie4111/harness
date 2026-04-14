import { describe, it, expect } from 'vitest'
import {
  initialRepoConfigs,
  repoConfigsReducer,
  type RepoConfig,
  type RepoConfigsState
} from './repo-configs'

describe('repoConfigsReducer', () => {
  it('loaded replaces the whole map', () => {
    const start: RepoConfigsState = {
      byRepo: { '/old': { setupCommand: 'old' } }
    }
    const next = repoConfigsReducer(start, {
      type: 'repoConfigs/loaded',
      payload: { '/a': { setupCommand: 'a' }, '/b': {} }
    })
    expect(Object.keys(next.byRepo).sort()).toEqual(['/a', '/b'])
    expect(next.byRepo['/a']).toEqual({ setupCommand: 'a' })
  })

  it('changed merges a single repo without disturbing others', () => {
    const start: RepoConfigsState = {
      byRepo: {
        '/a': { setupCommand: 'a' },
        '/b': { mergeStrategy: 'squash' }
      }
    }
    const updated: RepoConfig = {
      setupCommand: 'a-updated',
      hideMergePanel: true
    }
    const next = repoConfigsReducer(start, {
      type: 'repoConfigs/changed',
      payload: { repoRoot: '/a', config: updated }
    })
    expect(next.byRepo['/a']).toEqual(updated)
    expect(next.byRepo['/b']).toBe(start.byRepo['/b'])
  })

  it('removed drops the matching entry', () => {
    const start: RepoConfigsState = {
      byRepo: { '/a': {}, '/b': {} }
    }
    const next = repoConfigsReducer(start, {
      type: 'repoConfigs/removed',
      payload: '/a'
    })
    expect(Object.keys(next.byRepo)).toEqual(['/b'])
  })

  it('removed on a missing key is a no-op (returns same reference)', () => {
    const start: RepoConfigsState = { byRepo: { '/a': {} } }
    const next = repoConfigsReducer(start, {
      type: 'repoConfigs/removed',
      payload: '/missing'
    })
    expect(next).toBe(start)
  })

  it('returns a new object reference on real changes', () => {
    const next = repoConfigsReducer(initialRepoConfigs, {
      type: 'repoConfigs/changed',
      payload: { repoRoot: '/a', config: {} }
    })
    expect(next).not.toBe(initialRepoConfigs)
  })
})
