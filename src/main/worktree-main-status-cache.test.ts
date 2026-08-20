import { describe, it, expect, beforeEach, afterEach } from 'vitest'
/* These spawn real git. Under a full parallel suite run a handful of spawns
 * can blow past vitest's 5s default, so every case here sets its own budget —
 * a timeout in this file would otherwise read as a caching regression. */
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getMainWorktreeStatus, invalidateMainWorktreeStatus } from './worktree'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  }).toString()
}

const TIMEOUT = 60_000

describe('getMainWorktreeStatus caching', () => {
  let repo: string

  beforeEach(() => {
    invalidateMainWorktreeStatus()
    repo = mkdtempSync(join(tmpdir(), 'harness-mainstatus-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', 'f.txt'])
    git(repo, ['commit', '-q', '-m', 'base'])
  })

  afterEach(() => {
    invalidateMainWorktreeStatus()
    rmSync(repo, { recursive: true, force: true })
  })

  // The switch-time shape: the panel asks directly while worktree:previewMerge
  // asks internally, at the same instant. One underlying read, not two.
  it('collapses concurrent callers onto a single read', async () => {
    const [a, b] = await Promise.all([
      getMainWorktreeStatus(repo),
      getMainWorktreeStatus(repo)
    ])
    expect(a).toBe(b)
  }, TIMEOUT)

  it('serves a later caller from cache within the TTL', async () => {
    const first = await getMainWorktreeStatus(repo)
    expect(await getMainWorktreeStatus(repo)).toBe(first)
  }, TIMEOUT)

  it('re-reads after an explicit invalidation', async () => {
    const first = await getMainWorktreeStatus(repo)
    invalidateMainWorktreeStatus(repo)
    const second = await getMainWorktreeStatus(repo)
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  }, TIMEOUT)

  it('re-reads when forced, and picks up a change the cache would have hidden', async () => {
    const clean = await getMainWorktreeStatus(repo)
    expect(clean.isDirty).toBe(false)
    expect(clean.ready).toBe(true)

    writeFileSync(join(repo, 'f.txt'), 'dirty\n')
    // Unforced within the TTL still reports the stale answer — that's the
    // trade the TTL makes, and why the merge gate forces.
    expect((await getMainWorktreeStatus(repo)).isDirty).toBe(false)

    const forced = await getMainWorktreeStatus(repo, { force: true })
    expect(forced.isDirty).toBe(true)
    expect(forced.ready).toBe(false)
  }, TIMEOUT)

  it("keys by repo, so a second repo is not served the first one's answer", async () => {
    const other = mkdtempSync(join(tmpdir(), 'harness-mainstatus-b-'))
    try {
      // `master` rather than an arbitrary name: getLocalBaseBranch only
      // recognises main/master, and falls back to the literal 'main' for
      // anything else — which would mask a key collision instead of exposing it.
      git(other, ['init', '-q', '-b', 'master'])
      git(other, ['config', 'commit.gpgsign', 'false'])
      writeFileSync(join(other, 'g.txt'), 'x\n')
      git(other, ['add', 'g.txt'])
      git(other, ['commit', '-q', '-m', 'x'])

      const a = await getMainWorktreeStatus(repo)
      const b = await getMainWorktreeStatus(other)
      expect(a.path).not.toBe(b.path)
      expect(a.baseBranch).toBe('main')
      expect(b.baseBranch).toBe('master')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  }, TIMEOUT)

  it('does not cache a failure', async () => {
    const missing = join(tmpdir(), 'harness-mainstatus-does-not-exist')
    await expect(getMainWorktreeStatus(missing)).rejects.toThrow()
    // A cached rejection here would poison the repo for the whole TTL.
    await expect(getMainWorktreeStatus(missing)).rejects.toThrow()
  }, TIMEOUT)
})
