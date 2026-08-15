import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import { join } from 'path'

import { getChangedFiles } from './worktree'
import { WorktreeWatcher } from './worktree-watcher'

// REAL git, no mocks. GIT_OPTIONAL_LOCKS=0 suppresses the index write-back for
// `status` and `diff --cached`, but NOT for the unstaged worktree-vs-index
// `git diff` — the write lands in the gitdir WorktreeWatcher watches and
// retriggers the very refresh that caused it. These tests pin that down.
//
// The fix is to run that one read through `diff-files` — the plumbing
// equivalent, which does no opportunistic refresh. These tests are
// deliberately mechanism-agnostic: they assert the index doesn't move and the
// counts stay correct, not how that is achieved.
//
// The write-back only happens for a tracked file that is touched-but-CLEAN
// (mtime moved, content identical): that's the entry git wants to record as
// clean so it needn't re-hash next time. A file whose content actually differs
// has no clean stat entry worth persisting. Every probe below therefore
// touches an unmodified tracked file, and sleeps past git's 1-second
// racy-clean window first.

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

let cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.forEach((fn) => fn())
  cleanup = []
})

function makeRepoWithLinkedWorktree(): { main: string; linked: string } {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'gis-int-'))
  cleanup.push(() => fs.rmSync(tmp, { recursive: true, force: true }))
  const main = join(tmp, 'main')
  fs.mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  git(main, 'config', 'user.email', 't@t.t')
  git(main, 'config', 'user.name', 'T')
  fs.writeFileSync(join(main, 'seed.txt'), 'seed\n')
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'seed')
  const linked = join(tmp, 'linked')
  git(main, 'worktree', 'add', '-q', '-b', 'feature', linked)
  return { main, linked }
}

function indexPath(worktreePath: string): string {
  const gitdir = WorktreeWatcher.resolveGitdir(worktreePath)
  if (!gitdir) throw new Error(`no gitdir for ${worktreePath}`)
  return join(gitdir, 'index')
}

function indexStamp(worktreePath: string): string {
  const s = fs.statSync(indexPath(worktreePath))
  return `${s.mtimeMs}:${s.size}`
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Make a tracked file touched-but-clean, past the racy-clean window. */
async function touchClean(worktreePath: string): Promise<void> {
  const now = new Date()
  fs.utimesSync(join(worktreePath, 'seed.txt'), now, now)
  await sleep(1100)
}

describe('unstaged diff index write-back (real git)', () => {
  it('leaves .git/index untouched when getChangedFiles runs in working mode', async () => {
    const { linked } = makeRepoWithLinkedWorktree()
    // Settle any write-back the worktree-add left pending.
    await getChangedFiles(linked, 'working')

    await touchClean(linked)
    const before = indexStamp(linked)
    await getChangedFiles(linked, 'working')
    expect(indexStamp(linked)).toBe(before)
  }, 20000)

  it('still reports unstaged changes and their counts', async () => {
    const { linked } = makeRepoWithLinkedWorktree()
    fs.appendFileSync(join(linked, 'seed.txt'), 'unstaged change\n')

    const files = await getChangedFiles(linked, 'working')
    const seed = files.find((f) => f.path === 'seed.txt')
    expect(seed).toBeDefined()
    expect(seed!.staged).toBe(false)
    expect(seed!.additions).toBe(1)
  }, 20000)

  it('still reports staged changes and their counts', async () => {
    const { linked } = makeRepoWithLinkedWorktree()
    fs.writeFileSync(join(linked, 'added.txt'), 'a\nb\n')
    git(linked, 'add', 'added.txt')

    const files = await getChangedFiles(linked, 'working')
    const added = files.find((f) => f.path === 'added.txt')
    expect(added).toBeDefined()
    expect(added!.staged).toBe(true)
    expect(added!.additions).toBe(2)
  }, 20000)
})
