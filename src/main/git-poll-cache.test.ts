import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cachedGitRead, resetGitPollCache } from './git-poll-cache'

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

describe('cachedGitRead', () => {
  let root: string
  let repo: string
  let linked: string

  beforeEach(() => {
    resetGitPollCache()
    root = mkdtempSync(join(tmpdir(), 'harness-pollcache-'))
    repo = join(root, 'r')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', 'f.txt'])
    git(repo, ['commit', '-q', '-m', 'base'])
    // Harness's normal topology: a linked worktree, whose gitdir holds HEAD
    // while refs/ and packed-refs live back in the main repo's common dir.
    linked = join(root, 'wt')
    git(repo, ['worktree', 'add', '-q', '-b', 'feature', linked])
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** Counting reader: returns how many times it was actually invoked. */
  function counter(): { read: () => Promise<number>; calls: () => number } {
    let calls = 0
    return {
      read: async () => ++calls,
      calls: () => calls
    }
  }

  it('reads on a cold cache, then skips while the fingerprint holds still', async () => {
    const c = counter()
    const opts = { key: 'k', worktreePath: linked, fingerprintable: true, read: c.read }

    expect(await cachedGitRead(opts)).toEqual({ value: 1, cached: false })
    expect(await cachedGitRead(opts)).toEqual({ value: 1, cached: true })
    expect(c.calls()).toBe(1)
  })

  it('re-reads after a commit moves the branch ref', async () => {
    const c = counter()
    const opts = { key: 'k', worktreePath: linked, fingerprintable: true, read: c.read }

    await cachedGitRead(opts)
    writeFileSync(join(linked, 'f.txt'), 'changed\n')
    git(linked, ['add', 'f.txt'])
    git(linked, ['commit', '-q', '-m', 'next'])
    const after = await cachedGitRead(opts)

    expect(after).toEqual({ value: 2, cached: false })
  })

  it('re-reads after a checkout moves HEAD', async () => {
    const c = counter()
    const opts = { key: 'k', worktreePath: linked, fingerprintable: true, read: c.read }

    await cachedGitRead(opts)
    git(linked, ['checkout', '-q', '-b', 'other'])
    const after = await cachedGitRead(opts)

    expect(after.cached).toBe(false)
  })

  it('re-reads when the base ref moves in the common dir', async () => {
    // The regression this guards: base...HEAD reads depend on origin/<base>,
    // which lives in the common dir, not the linked worktree's gitdir. If the
    // fingerprint only spanned the gitdir, a fetch moving origin/main would
    // never invalidate and the branch view would go permanently stale.
    const head = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['update-ref', 'refs/remotes/origin/main', head])

    const c = counter()
    const opts = {
      key: 'k',
      worktreePath: linked,
      fingerprintable: true,
      baseRef: 'origin/main',
      read: c.read
    }

    await cachedGitRead(opts)
    expect((await cachedGitRead(opts)).cached).toBe(true)

    writeFileSync(join(repo, 'f.txt'), 'upstream\n')
    git(repo, ['add', 'f.txt'])
    git(repo, ['commit', '-q', '-m', 'upstream'])
    git(repo, ['update-ref', 'refs/remotes/origin/main', git(repo, ['rev-parse', 'HEAD']).trim()])

    expect((await cachedGitRead(opts)).cached).toBe(false)
  })

  it('never fingerprint-skips a non-fingerprintable read', async () => {
    // Working-tree reads see untracked/unstaged edits, which leave no trace
    // under .git — skipping them would blind the Changed Files panel.
    const c = counter()
    const opts = { key: 'k', worktreePath: linked, fingerprintable: false, read: c.read }

    await cachedGitRead(opts)
    await cachedGitRead(opts)
    await cachedGitRead(opts)

    expect(c.calls()).toBe(3)
  })

  it('serves the cached value while an operation is in flight', async () => {
    const c = counter()
    const opts = { key: 'k', worktreePath: linked, fingerprintable: false, read: c.read }

    await cachedGitRead(opts)
    const gitDir = join(repo, '.git', 'worktrees', 'wt')
    writeFileSync(join(gitDir, 'index.lock'), '')

    const during = await cachedGitRead(opts)
    expect(during).toEqual({ value: 1, cached: true })
    expect(c.calls()).toBe(1)

    unlinkSync(join(gitDir, 'index.lock'))
    expect((await cachedGitRead(opts)).cached).toBe(false)
  })

  it('forces a read once the consecutive-skip cap is hit', async () => {
    // A stale index.lock left by a crashed git must not freeze the panel for
    // the rest of the session.
    const c = counter()
    const opts = { key: 'k', worktreePath: linked, fingerprintable: false, read: c.read }

    await cachedGitRead(opts)
    writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'index.lock'), '')

    for (let i = 0; i < 10; i++) {
      expect((await cachedGitRead(opts)).cached).toBe(true)
    }
    expect((await cachedGitRead(opts)).cached).toBe(false)
    expect(c.calls()).toBe(2)
  })
})
