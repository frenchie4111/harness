import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseCommitShas,
  resolveCommitSha,
  loadWorktreeCommits,
  getCachedWorktreeCommits,
  __resetWorktreeCommitCache
} from './terminal-commit-links'

describe('parseCommitShas', () => {
  it('matches an abbreviated SHA in git-log output', () => {
    const [m] = parseCommitShas('ba6421d Merge pull request #119')
    expect(m.sha).toBe('ba6421d')
    expect(m.start).toBe(0)
    expect(m.length).toBe(7)
  })

  it('matches a full 40-char SHA', () => {
    const full = '73ed66b6b98812f3c38b899294919e5100426fbe'
    const [m] = parseCommitShas(`commit ${full}`)
    expect(m.sha).toBe(full)
    expect(m.start).toBe('commit '.length)
  })

  it('finds multiple SHAs on one line', () => {
    const matches = parseCommitShas('range ba6421d..73ed66b shown')
    expect(matches.map((m) => m.sha)).toEqual(['ba6421d', '73ed66b'])
  })

  it('ignores hex runs shorter than 7 chars', () => {
    expect(parseCommitShas('color #abc123 and id abc12')).toHaveLength(0)
  })

  it('does not match a slice of a longer hex string (e.g. sha256)', () => {
    const sha256 = 'e'.repeat(64)
    expect(parseCommitShas(`digest ${sha256}`)).toHaveLength(0)
  })

  it('does not match uppercase hex (git SHAs are lowercase)', () => {
    expect(parseCommitShas('ABCDEF1234')).toHaveLength(0)
  })

  it('does not match non-hex words', () => {
    expect(parseCommitShas('the quick brown fox jumped')).toHaveLength(0)
  })
})

describe('resolveCommitSha', () => {
  const sorted = [
    '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '73ed66b6b98812f3c38b899294919e5100426fbe',
    'ba6421db9007b8b7c34f29c61aecaea9fe9407c7'
  ]

  it('resolves an abbreviated prefix to the full SHA', () => {
    expect(resolveCommitSha('ba6421d', sorted)).toBe(
      'ba6421db9007b8b7c34f29c61aecaea9fe9407c7'
    )
    expect(resolveCommitSha('73ed66b', sorted)).toBe(
      '73ed66b6b98812f3c38b899294919e5100426fbe'
    )
  })

  it('resolves an exact full SHA', () => {
    expect(resolveCommitSha('73ed66b6b98812f3c38b899294919e5100426fbe', sorted)).toBe(
      '73ed66b6b98812f3c38b899294919e5100426fbe'
    )
  })

  it('returns null for a prefix that matches no commit', () => {
    expect(resolveCommitSha('deadbee', sorted)).toBeNull()
  })

  it('returns null against an empty set', () => {
    expect(resolveCommitSha('ba6421d', [])).toBeNull()
  })
})

describe('worktree commit cache', () => {
  beforeEach(() => __resetWorktreeCommitCache())

  it('loads, sorts, and serves the commit set synchronously', async () => {
    const cwd = '/repo'
    expect(getCachedWorktreeCommits(cwd)).toBeNull()
    await loadWorktreeCommits(
      cwd,
      async () => ['ba6421db9007b8b7c34f29c61aecaea9fe9407c7', '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      { now: 1000 }
    )
    const set = getCachedWorktreeCommits(cwd)
    expect(set?.[0]).toBe('1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(resolveCommitSha('ba6421d', set!)).toBe(
      'ba6421db9007b8b7c34f29c61aecaea9fe9407c7'
    )
  })

  it('skips a reload within the refresh window but reloads when forced', async () => {
    const cwd = '/repo'
    let calls = 0
    const list = async (): Promise<string[]> => {
      calls++
      return ['ba6421db9007b8b7c34f29c61aecaea9fe9407c7']
    }
    await loadWorktreeCommits(cwd, list, { now: 1000 })
    await loadWorktreeCommits(cwd, list, { now: 1500 }) // within 5s window → skipped
    expect(calls).toBe(1)
    await loadWorktreeCommits(cwd, list, { now: 1500, force: true })
    expect(calls).toBe(2)
    await loadWorktreeCommits(cwd, list, { now: 99999 }) // window elapsed → reload
    expect(calls).toBe(3)
  })
})
