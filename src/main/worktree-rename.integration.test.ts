import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'
import { join } from 'path'

import { renameWorktreeBranch } from './worktree'

// REAL git, no mocks. A freshly created worktree tracks the base it was cut
// from (origin/main) thanks to git's default branch.autoSetupMerge, which is
// NOT the same thing as having been published.

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
}

let tmp: string
let clone: string

beforeAll(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'wt-rename-'))

  const seed = join(tmp, 'seed')
  fs.mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'config', 'user.email', 't@t.t')
  git(seed, 'config', 'user.name', 'T')
  fs.writeFileSync(join(seed, 'seed.txt'), 'seed\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-q', '-m', 'seed')

  const origin = join(tmp, 'origin.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, origin], { stdio: 'pipe' })

  clone = join(tmp, 'clone')
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'pipe' })
  git(clone, 'config', 'user.email', 't@t.t')
  git(clone, 'config', 'user.name', 'T')
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A worktree cut from origin/main, exactly as addWorktree creates one. */
function makeWorktree(branch: string): string {
  const path = join(tmp, branch.replace(/\//g, '-'))
  git(clone, 'worktree', 'add', '-q', path, '-b', branch, 'origin/main')
  return path
}

function upstreamOf(cwd: string): string {
  try {
    return git(cwd, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}').trim()
  } catch {
    return ''
  }
}

function headOf(cwd: string): string {
  return git(cwd, 'symbolic-ref', '--short', 'HEAD').trim()
}

describe('renameWorktreeBranch (real git)', () => {
  it('renames a fresh worktree branch even though it tracks origin/main', async () => {
    const worktree = makeWorktree('fresh')
    expect(upstreamOf(worktree)).toBe('origin/main')

    const result = await renameWorktreeBranch(worktree, 'fresh-renamed')

    expect(result).toEqual({
      ok: true,
      oldBranch: 'fresh',
      branch: 'fresh-renamed',
      renamed: true
    })
    expect(headOf(worktree)).toBe('fresh-renamed')
  })

  it('renames a branch whose name contains a slash', async () => {
    const worktree = makeWorktree('fix/login')

    const result = await renameWorktreeBranch(worktree, 'fix/logout')

    expect(result.ok).toBe(true)
    expect(headOf(worktree)).toBe('fix/logout')
  })

  it('refuses once the branch has been pushed with -u', async () => {
    const worktree = makeWorktree('pushed-tracking')
    git(worktree, 'push', '-q', '-u', 'origin', 'pushed-tracking')

    const result = await renameWorktreeBranch(worktree, 'pushed-tracking-renamed')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('origin/pushed-tracking')
    expect(headOf(worktree)).toBe('pushed-tracking')
  })

  it('refuses after a plain push that left the upstream on origin/main', async () => {
    const worktree = makeWorktree('pushed-plain')
    git(worktree, 'push', '-q', 'origin', 'pushed-plain')
    expect(upstreamOf(worktree)).toBe('origin/main')

    const result = await renameWorktreeBranch(worktree, 'pushed-plain-renamed')

    expect(result.ok).toBe(false)
    expect(headOf(worktree)).toBe('pushed-plain')
  })

  it('refuses a published branch whose name contains a slash', async () => {
    const worktree = makeWorktree('feat/published')
    git(worktree, 'push', '-q', '-u', 'origin', 'feat/published')

    const result = await renameWorktreeBranch(worktree, 'feat/renamed')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('origin/feat/published')
  })

  it('reports the existing branch by name when the target is taken', async () => {
    const worktree = makeWorktree('collides')
    git(clone, 'branch', 'taken')

    const result = await renameWorktreeBranch(worktree, 'taken')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('"taken" already exists')
  })
})
