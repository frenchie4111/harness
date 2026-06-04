import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import { join } from 'path'

import { WorktreeWatcher } from './worktree-watcher'

// REAL fs.watch + REAL git, no mocks. Proves the watcher fires changed-files
// invalidations for a LINKED worktree (the gitlink-file case that used to be
// silently dead).

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

let cleanup: (() => void)[] = []
afterEach(() => {
  cleanup.forEach((fn) => fn())
  cleanup = []
})

function makeRepoWithLinkedWorktree(): { main: string; linked: string } {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'wtw-int-'))
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

function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve(true)
      if (Date.now() - start > timeoutMs) return resolve(false)
      setTimeout(tick, 25)
    }
    tick()
  })
}

describe('WorktreeWatcher integration (real fs.watch + git)', () => {
  it('resolves a linked worktree to its real gitdir under .git/worktrees/<name>', () => {
    const { main, linked } = makeRepoWithLinkedWorktree()
    const gitdir = WorktreeWatcher.resolveGitdir(linked)
    expect(gitdir).toBe(fs.realpathSync(join(main, '.git', 'worktrees', 'linked')))
  })

  it('fires a changed-files invalidation when a file is staged in a LINKED worktree', async () => {
    const { linked } = makeRepoWithLinkedWorktree()
    const watcher = new WorktreeWatcher()
    cleanup.push(() => watcher.shutdown())

    let fired = 0
    watcher.subscribe(linked, () => {
      fired++
    })

    fs.writeFileSync(join(linked, 'change.txt'), 'hello\n')
    git(linked, 'add', 'change.txt')

    const ok = await waitFor(() => fired > 0)
    expect(ok).toBe(true)
  })

  it('fires again on commit in a LINKED worktree', async () => {
    const { linked } = makeRepoWithLinkedWorktree()
    const watcher = new WorktreeWatcher()
    cleanup.push(() => watcher.shutdown())

    fs.writeFileSync(join(linked, 'change.txt'), 'hello\n')
    git(linked, 'add', 'change.txt')

    let fired = 0
    watcher.subscribe(linked, () => {
      fired++
    })

    // Let the stage event settle, then commit and expect a fresh invalidation.
    await waitFor(() => fired > 0)
    const afterStage = fired
    git(linked, 'commit', '-q', '-m', 'change')

    const ok = await waitFor(() => fired > afterStage)
    expect(ok).toBe(true)
  })
})
