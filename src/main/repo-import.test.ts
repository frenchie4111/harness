import { describe, expect, it } from 'vitest'
import type { DiscoveredSession } from '../shared/session-import-types'
import type { BranchInventoryEntry } from './worktree'
import { buildRepoImportPlan } from './repo-import'

const NOW = 1_000_000_000_000
const DAY = 24 * 60 * 60 * 1000

function session(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    sessionId: 'sid-1',
    transcriptPath: '/x.jsonl',
    cwd: '/work/repo',
    gitBranch: 'feature',
    title: 'Fix the thing',
    titleSource: 'ai',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    firstTimestamp: NOW - DAY,
    lastTimestamp: NOW - DAY,
    userTurns: 1,
    userTurnsExact: true,
    sizeBytes: 10,
    mtimeMs: NOW - DAY,
    cliVersion: '2.1.126',
    ...over
  }
}

function branch(over: Partial<BranchInventoryEntry> = {}): BranchInventoryEntry {
  return {
    name: 'feature',
    lastCommitMs: NOW - DAY,
    checkedOutAt: null,
    merged: false,
    ...over
  }
}

function plan(sessions: DiscoveredSession[], inventory: BranchInventoryEntry[], now = NOW) {
  return buildRepoImportPlan({ repoRoot: '/work/repo', sessions, inventory, now })
}

describe('buildRepoImportPlan', () => {
  it('turns a branch with chats into a candidate', () => {
    const result = plan([session()], [branch()])
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0].branch).toBe('feature')
    expect(result.candidates[0].sessionCount).toBe(1)
    expect(result.repoLabel).toBe('repo')
  })

  it('claims sessions that ran in the repo worktree layout', () => {
    // Ness parks checkouts at <repo>-worktrees/<branch>; those chats belong
    // to the repo even though their cwd is not under it.
    const result = plan(
      [session({ cwd: '/work/repo-worktrees/feature' })],
      [branch()]
    )
    expect(result.candidates).toHaveLength(1)
    expect(result.totalSessionCount).toBe(1)
  })

  it('ignores sessions from other repos', () => {
    const result = plan([session({ cwd: '/work/other' })], [branch()])
    expect(result.candidates).toHaveLength(0)
    expect(result.totalSessionCount).toBe(0)
  })

  it('strands chats whose branch no longer has a local ref', () => {
    const result = plan([session({ gitBranch: 'deleted' })], [branch()])
    expect(result.candidates).toHaveLength(0)
    expect(result.strandedSessionCount).toBe(1)
    // Still counted in the total, so the number the user sees never shrinks
    // without explanation.
    expect(result.totalSessionCount).toBe(1)
  })

  it('counts branchless chats in the total but makes no candidate', () => {
    const result = plan([session({ gitBranch: null })], [branch()])
    expect(result.totalSessionCount).toBe(1)
    expect(result.candidates).toHaveLength(0)
    expect(result.strandedSessionCount).toBe(0)
  })

  it('groups every chat on a branch into one candidate', () => {
    const result = plan(
      [
        session({ sessionId: 'a', lastTimestamp: NOW - DAY }),
        session({ sessionId: 'b', lastTimestamp: NOW - 2 * DAY })
      ],
      [branch()]
    )
    expect(result.candidates[0].sessionCount).toBe(2)
    // Most recent first, so [0] is where the user left off.
    expect(result.candidates[0].sessionIds).toEqual(['a', 'b'])
  })

  it('recommends a recent, unmerged, unclaimed branch', () => {
    const result = plan([session({ lastTimestamp: NOW - DAY })], [branch()])
    expect(result.candidates[0].recommended).toBe(true)
    expect(result.recommendedCount).toBe(1)
  })

  it('does not recommend a branch already checked out somewhere', () => {
    const result = plan(
      [session()],
      [branch({ checkedOutAt: '/work/repo-worktrees/feature' })]
    )
    expect(result.candidates[0].recommended).toBe(false)
    expect(result.candidates[0].checkedOutAt).toBe('/work/repo-worktrees/feature')
  })

  it('does not recommend a merged branch', () => {
    const result = plan([session()], [branch({ merged: true })])
    expect(result.candidates[0].recommended).toBe(false)
  })

  it('does not recommend a branch whose chats went quiet', () => {
    const result = plan([session({ lastTimestamp: NOW - 30 * DAY })], [branch()])
    expect(result.candidates[0].recommended).toBe(false)
  })

  it('keeps stale and merged branches in the list, just unchecked', () => {
    // The user rejected hidden filtering: everything stays reachable.
    const result = plan(
      [
        session({ sessionId: 'a', gitBranch: 'old', lastTimestamp: NOW - 90 * DAY }),
        session({ sessionId: 'b', gitBranch: 'landed' })
      ],
      [
        branch({ name: 'old', lastCommitMs: NOW - 90 * DAY }),
        branch({ name: 'landed', merged: true })
      ]
    )
    expect(result.candidates).toHaveLength(2)
    expect(result.recommendedCount).toBe(0)
  })

  it('ranks branches by chat recency, not commit date', () => {
    const result = plan(
      [
        session({ sessionId: 'a', gitBranch: 'stale-chat', lastTimestamp: NOW - 10 * DAY }),
        session({ sessionId: 'b', gitBranch: 'fresh-chat', lastTimestamp: NOW - DAY })
      ],
      [
        branch({ name: 'stale-chat', lastCommitMs: NOW }),
        branch({ name: 'fresh-chat', lastCommitMs: NOW - 60 * DAY })
      ]
    )
    expect(result.candidates.map((c) => c.branch)).toEqual(['fresh-chat', 'stale-chat'])
  })

  it('surfaces the latest chat title as the where-I-left-off hint', () => {
    const result = plan(
      [
        session({ sessionId: 'a', title: 'Newest', lastTimestamp: NOW - DAY }),
        session({ sessionId: 'b', title: 'Older', lastTimestamp: NOW - 5 * DAY })
      ],
      [branch()]
    )
    expect(result.candidates[0].latestTitle).toBe('Newest')
  })

  it('carries a PR number from whichever chat recorded it', () => {
    const result = plan(
      [
        session({ sessionId: 'a', prNumber: null, lastTimestamp: NOW - DAY }),
        session({ sessionId: 'b', prNumber: 214, lastTimestamp: NOW - 5 * DAY })
      ],
      [branch()]
    )
    expect(result.candidates[0].prNumber).toBe(214)
  })

  it('falls back to file mtime when a chat has no timestamps', () => {
    const result = plan(
      [session({ lastTimestamp: null, mtimeMs: NOW - DAY })],
      [branch()]
    )
    expect(result.candidates[0].latestActivityMs).toBe(NOW - DAY)
    expect(result.candidates[0].recommended).toBe(true)
  })

  it('reports a missing commit date as null rather than epoch zero', () => {
    const result = plan([session()], [branch({ lastCommitMs: 0 })])
    expect(result.candidates[0].lastCommitMs).toBeNull()
  })
})
