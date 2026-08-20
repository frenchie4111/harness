import { describe, expect, it } from 'vitest'
import type { DiscoveredSession } from './session-scanner'
import { buildSessionTree, resolveRepoRoot } from './session-tree'

function session(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    sessionId: over.sessionId ?? 'sid',
    transcriptPath: '/tmp/x.jsonl',
    cwd: '/Users/x/repo',
    gitBranch: 'main',
    title: 'A title',
    titleSource: 'ai',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    firstTimestamp: 1000,
    lastTimestamp: 1000,
    userTurns: 1,
    userTurnsExact: true,
    sizeBytes: 1024,
    mtimeMs: 1000,
    cliVersion: '2.1.126',
    ...over
  }
}

describe('resolveRepoRoot', () => {
  it('matches a known repo root', () => {
    expect(resolveRepoRoot('/Users/x/repo', ['/Users/x/repo'])).toBe('/Users/x/repo')
  })

  it('matches a path nested inside a known root', () => {
    expect(resolveRepoRoot('/Users/x/repo/src/main', ['/Users/x/repo'])).toBe('/Users/x/repo')
  })

  it('prefers the longest matching root for nested repos', () => {
    const roots = ['/Users/x', '/Users/x/repo']
    expect(resolveRepoRoot('/Users/x/repo/src', roots)).toBe('/Users/x/repo')
  })

  it('does not match a sibling with a shared prefix', () => {
    expect(resolveRepoRoot('/Users/x/repo-other', ['/Users/x/repo'])).toBeNull()
  })

  it('derives the repo from the -worktrees convention', () => {
    expect(resolveRepoRoot('/Users/x/apps/ness-worktrees/feature-a', [])).toBe('/Users/x/apps/ness')
  })

  it('returns null for a loose path', () => {
    expect(resolveRepoRoot('/private/tmp/scratch', [])).toBeNull()
  })

  it('tolerates a trailing slash on a known root', () => {
    expect(resolveRepoRoot('/Users/x/repo/src', ['/Users/x/repo/'])).toBe('/Users/x/repo')
  })
})

describe('buildSessionTree', () => {
  it('keeps every session — nothing is filtered out', () => {
    const sessions = [
      session({ sessionId: 'a', cwd: '/' }),
      session({ sessionId: 'b', cwd: '/private/tmp/sandbox' }),
      session({ sessionId: 'c', cwd: '/Users/x/repo' })
    ]
    const tree = buildSessionTree(sessions, ['/Users/x/repo'])
    const total = tree.reduce((n, g) => n + g.sessionCount, 0)
    expect(total).toBe(3)
  })

  it('groups worktrees of one repo under a single node', () => {
    const sessions = [
      session({ sessionId: 'a', cwd: '/Users/x/ness', gitBranch: 'main' }),
      session({ sessionId: 'b', cwd: '/Users/x/ness-worktrees/feat', gitBranch: 'feat' })
    ]
    const tree = buildSessionTree(sessions, ['/Users/x/ness'])
    expect(tree).toHaveLength(1)
    expect(tree[0].label).toBe('ness')
    expect(tree[0].branches.map((b) => b.branch).sort()).toEqual(['feat', 'main'])
  })

  it('sorts real repos above loose locations regardless of recency', () => {
    // The noisy bucket is the most recent; it must still sort below a repo.
    const sessions = [
      session({ sessionId: 'noise', cwd: '/', lastTimestamp: 9999 }),
      session({ sessionId: 'work', cwd: '/Users/x/repo', lastTimestamp: 1 })
    ]
    const tree = buildSessionTree(sessions, ['/Users/x/repo'])
    expect(tree.map((g) => g.kind)).toEqual(['repo', 'location'])
    expect(tree[0].label).toBe('repo')
  })

  it('sorts by recency within a band', () => {
    const sessions = [
      session({ sessionId: 'old', cwd: '/Users/x/a', lastTimestamp: 10 }),
      session({ sessionId: 'new', cwd: '/Users/x/b', lastTimestamp: 20 })
    ]
    const tree = buildSessionTree(sessions, ['/Users/x/a', '/Users/x/b'])
    expect(tree.map((g) => g.label)).toEqual(['b', 'a'])
  })

  it('orders branches and sessions newest first', () => {
    const sessions = [
      session({ sessionId: 's1', gitBranch: 'old-branch', lastTimestamp: 10 }),
      session({ sessionId: 's2', gitBranch: 'new-branch', lastTimestamp: 30 }),
      session({ sessionId: 's3', gitBranch: 'new-branch', lastTimestamp: 40 })
    ]
    const tree = buildSessionTree(sessions, ['/Users/x/repo'])
    expect(tree[0].branches.map((b) => b.branch)).toEqual(['new-branch', 'old-branch'])
    expect(tree[0].branches[0].sessions.map((s) => s.sessionId)).toEqual(['s3', 's2'])
  })

  it('counts sessions and PRs per branch and per group', () => {
    const sessions = [
      session({ sessionId: 's1', gitBranch: 'a', prNumber: 1 }),
      session({ sessionId: 's2', gitBranch: 'a', prNumber: null }),
      session({ sessionId: 's3', gitBranch: 'b', prNumber: 2 })
    ]
    const tree = buildSessionTree(sessions, ['/Users/x/repo'])
    expect(tree[0].sessionCount).toBe(3)
    expect(tree[0].prCount).toBe(2)
    const branchA = tree[0].branches.find((b) => b.branch === 'a')
    expect(branchA?.sessionCount).toBe(2)
    expect(branchA?.prCount).toBe(1)
  })

  it('buckets sessions with no branch under a placeholder', () => {
    const tree = buildSessionTree([session({ gitBranch: null })], ['/Users/x/repo'])
    expect(tree[0].branches[0].branch).toBeNull()
    expect(tree[0].branches[0].sessionCount).toBe(1)
  })

  it('buckets sessions with no cwd as unknown, sorted last', () => {
    const sessions = [
      session({ sessionId: 'nowhere', cwd: null, lastTimestamp: 9999 }),
      session({ sessionId: 'loose', cwd: '/private/tmp', lastTimestamp: 1 })
    ]
    const tree = buildSessionTree(sessions, [])
    expect(tree.map((g) => g.kind)).toEqual(['location', 'unknown'])
    expect(tree[1].label).toBe('Unknown location')
  })

  it('falls back to mtime when a session has no timestamps', () => {
    const tree = buildSessionTree(
      [session({ lastTimestamp: null, mtimeMs: 555 })],
      ['/Users/x/repo']
    )
    expect(tree[0].latestTimestamp).toBe(555)
  })

  it('produces stable distinct keys per group and branch', () => {
    const sessions = [
      session({ sessionId: 's1', cwd: '/Users/x/a', gitBranch: 'main' }),
      session({ sessionId: 's2', cwd: '/Users/x/b', gitBranch: 'main' })
    ]
    const tree = buildSessionTree(sessions, ['/Users/x/a', '/Users/x/b'])
    const keys = tree.flatMap((g) => [g.key, ...g.branches.map((b) => b.key)])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('returns an empty tree for no sessions', () => {
    expect(buildSessionTree([], [])).toEqual([])
  })

  it('coalesces sandbox paths into one temporary group', () => {
    const sessions = [
      session({ sessionId: 'a', cwd: '/private/var/folders/5c/abc/T/x' }),
      session({ sessionId: 'b', cwd: '/private/var/folders/5c/def/T/y' }),
      session({ sessionId: 'c', cwd: '/tmp/scratch' })
    ]
    const tree = buildSessionTree(sessions, [])
    expect(tree).toHaveLength(1)
    expect(tree[0].kind).toBe('temporary')
    expect(tree[0].label).toBe('Temporary locations')
    expect(tree[0].sessionCount).toBe(3)
  })

  it('sorts temporary below loose locations but above unknown', () => {
    const sessions = [
      session({ sessionId: 'u', cwd: null }),
      session({ sessionId: 't', cwd: '/tmp/x' }),
      session({ sessionId: 'l', cwd: '/opt/thing' })
    ]
    const tree = buildSessionTree(sessions, [])
    expect(tree.map((g) => g.kind)).toEqual(['location', 'temporary', 'unknown'])
  })

  it('abbreviates the home directory in loose-location labels', () => {
    const tree = buildSessionTree(
      [session({ cwd: '/Users/mike/scratch/thing' })],
      [],
      '/Users/mike'
    )
    expect(tree[0].label).toBe('~/scratch/thing')
  })

  it('does not treat a repo under a temp path as temporary', () => {
    const tree = buildSessionTree([session({ cwd: '/tmp/checkout' })], ['/tmp/checkout'])
    expect(tree[0].kind).toBe('repo')
  })
})
