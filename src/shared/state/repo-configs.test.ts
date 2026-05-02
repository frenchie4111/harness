import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RIGHT_PANEL_ORDER,
  effectiveHiddenRightPanels,
  effectiveRightPanelOrder,
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

  it('effectiveHiddenRightPanels migrates legacy hideMergePanel / hidePrPanel', () => {
    expect(effectiveHiddenRightPanels({ hideMergePanel: true })).toEqual({ merge: true })
    expect(effectiveHiddenRightPanels({ hidePrPanel: true })).toEqual({ pr: true })
    expect(
      effectiveHiddenRightPanels({
        hideMergePanel: true,
        hiddenRightPanels: { pr: true, commits: true }
      })
    ).toEqual({ merge: true, pr: true, commits: true })
  })

  it('effectiveHiddenRightPanels prefers new field over legacy', () => {
    // Legacy says "hide merge", new explicitly sets merge: false.
    // effectiveHiddenRightPanels only adds legacy when new is undefined.
    expect(
      effectiveHiddenRightPanels({
        hideMergePanel: true,
        hiddenRightPanels: { merge: false }
      })
    ).toEqual({ merge: false })
  })

  it('effectiveRightPanelOrder returns default when unset', () => {
    expect(effectiveRightPanelOrder(null)).toEqual(DEFAULT_RIGHT_PANEL_ORDER)
    expect(effectiveRightPanelOrder({})).toEqual(DEFAULT_RIGHT_PANEL_ORDER)
    expect(effectiveRightPanelOrder({ rightPanelOrder: [] })).toEqual(DEFAULT_RIGHT_PANEL_ORDER)
  })

  it('effectiveRightPanelOrder honors saved order', () => {
    expect(
      effectiveRightPanelOrder({
        rightPanelOrder: ['cost', 'pr', 'merge', 'todos', 'commits', 'changedFiles', 'allFiles']
      })
    ).toEqual(['cost', 'pr', 'merge', 'todos', 'commits', 'changedFiles', 'allFiles'])
  })

  it('effectiveRightPanelOrder fills in missing keys and drops unknown', () => {
    // Partial saved order — the missing keys get appended in canonical order
    const result = effectiveRightPanelOrder({
      rightPanelOrder: ['cost', 'pr'] as never
    })
    expect(result[0]).toBe('cost')
    expect(result[1]).toBe('pr')
    // Remaining keys in canonical order
    expect(result.slice(2)).toEqual(['merge', 'commits', 'changedFiles', 'allFiles', 'todos'])
    expect(result).toHaveLength(7)
  })

  it('effectiveRightPanelOrder deduplicates repeated keys', () => {
    const result = effectiveRightPanelOrder({
      rightPanelOrder: ['pr', 'pr', 'merge'] as never
    })
    expect(result.filter((k) => k === 'pr')).toHaveLength(1)
    expect(result).toHaveLength(7)
  })

  it('effectiveHiddenRightPanels handles null/empty config', () => {
    expect(effectiveHiddenRightPanels(null)).toEqual({})
    expect(effectiveHiddenRightPanels(undefined)).toEqual({})
    expect(effectiveHiddenRightPanels({})).toEqual({})
  })

  it('returns a new object reference on real changes', () => {
    const next = repoConfigsReducer(initialRepoConfigs, {
      type: 'repoConfigs/changed',
      payload: { repoRoot: '/a', config: {} }
    })
    expect(next).not.toBe(initialRepoConfigs)
  })
})
