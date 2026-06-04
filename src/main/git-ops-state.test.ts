import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectInProgressOp, isOnRealBranch } from './git-ops-state'

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

function tryGit(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(cwd, args) }
  } catch (err) {
    const stdout = (err as { stdout?: Buffer }).stdout?.toString() ?? ''
    return { ok: false, out: stdout }
  }
}

describe('detectInProgressOp', () => {
  let root: string
  let repo: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-gitops-'))
    repo = join(root, 'r')
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', 'f.txt'])
    git(repo, ['commit', '-q', '-m', 'base'])
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns null on a clean repo', async () => {
    const op = await detectInProgressOp(repo)
    expect(op).toBeNull()
  })

  describe('rebase', () => {
    function setupConflictingRebase(): void {
      // Build three commits on main that conflict with three on feature.
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(repo, 'f.txt'), `main-${i}\n`)
        git(repo, ['add', 'f.txt'])
        git(repo, ['commit', '-q', '-m', `main-${i}`])
      }
      git(repo, ['checkout', '-q', '-b', 'feature', 'HEAD~3'])
      for (let i = 1; i <= 4; i++) {
        writeFileSync(join(repo, 'f.txt'), `feat-${i}\n`)
        git(repo, ['add', 'f.txt'])
        git(repo, ['commit', '-q', '-m', `feat-${i}`])
      }
    }

    it('reports step/total and onto branch name', async () => {
      setupConflictingRebase()
      const { ok } = tryGit(repo, ['rebase', 'main'])
      expect(ok).toBe(false)
      const op = await detectInProgressOp(repo)
      expect(op?.kind).toBe('rebase')
      expect(op?.label).toMatch(/^rebasing 1\/4 onto main$/)
    })

    it('degrades to bare "rebasing" when msgnum is missing', async () => {
      setupConflictingRebase()
      tryGit(repo, ['rebase', 'main'])
      const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).trim()
      const msgnumPath = join(gitDir, 'rebase-merge', 'msgnum')
      if (existsSync(msgnumPath)) unlinkSync(msgnumPath)
      const op = await detectInProgressOp(repo)
      expect(op?.kind).toBe('rebase')
      expect(op?.label).toMatch(/^rebasing( onto main)?$/)
    })
  })

  describe('bisect', () => {
    it('reports step count and remaining range', async () => {
      for (let i = 1; i <= 6; i++) {
        writeFileSync(join(repo, 'f.txt'), `c-${i}\n`)
        git(repo, ['add', 'f.txt'])
        git(repo, ['commit', '-q', '-m', `c-${i}`])
      }
      git(repo, ['bisect', 'start'])
      git(repo, ['bisect', 'bad', 'HEAD'])
      git(repo, ['bisect', 'good', 'HEAD~5'])
      const op = await detectInProgressOp(repo)
      expect(op?.kind).toBe('bisect')
      expect(op?.label).toMatch(/^bisecting \(2 steps(, ~\d+ commits? left)?\)$/)
    })
  })

  describe('cherry-pick', () => {
    it('reports done/total for sequencer cherry-pick over a range', async () => {
      git(repo, ['checkout', '-q', '-b', 'picks'])
      // p-1 adds an unrelated file; p-2..p-4 mutate p.txt so the conflict
      // lands on p-2 after p-1 has already applied cleanly.
      writeFileSync(join(repo, 'unrelated.txt'), 'one\n')
      git(repo, ['add', 'unrelated.txt'])
      git(repo, ['commit', '-q', '-m', 'p-1'])
      for (let i = 2; i <= 4; i++) {
        writeFileSync(join(repo, 'p.txt'), `p-${i}\n`)
        git(repo, ['add', 'p.txt'])
        git(repo, ['commit', '-q', '-m', `p-${i}`])
      }
      git(repo, ['checkout', '-q', 'main'])
      writeFileSync(join(repo, 'p.txt'), 'conflict\n')
      git(repo, ['add', 'p.txt'])
      git(repo, ['commit', '-q', '-m', 'conflict'])
      const res = tryGit(repo, ['cherry-pick', 'picks~4..picks'])
      expect(res.ok).toBe(false)
      const op = await detectInProgressOp(repo)
      expect(op?.kind).toBe('cherry-pick')
      // p-1 applied, p-2 conflicting (current), p-3+p-4 still in todo →
      // done=1, todo=3, total=4.
      expect(op?.label).toBe('cherry-picking 1/4')
    })

    it('degrades to bare "cherry-picking" when only CHERRY_PICK_HEAD exists', async () => {
      git(repo, ['checkout', '-q', '-b', 'other'])
      writeFileSync(join(repo, 'g.txt'), 'g\n')
      git(repo, ['add', 'g.txt'])
      git(repo, ['commit', '-q', '-m', 'other'])
      git(repo, ['checkout', '-q', 'main'])
      writeFileSync(join(repo, 'g.txt'), 'conflict\n')
      git(repo, ['add', 'g.txt'])
      git(repo, ['commit', '-q', '-m', 'conflict'])
      const res = tryGit(repo, ['cherry-pick', 'other'])
      expect(res.ok).toBe(false)
      const op = await detectInProgressOp(repo)
      expect(op?.kind).toBe('cherry-pick')
      expect(op?.label).toBe('cherry-picking')
    })
  })
})

describe('isOnRealBranch', () => {
  it('returns true for ordinary branch names', () => {
    expect(isOnRealBranch('main')).toBe(true)
    expect(isOnRealBranch('feature/foo')).toBe(true)
  })

  it('returns false for detached, empty, or null', () => {
    expect(isOnRealBranch('(detached)')).toBe(false)
    expect(isOnRealBranch('')).toBe(false)
    expect(isOnRealBranch(undefined)).toBe(false)
    expect(isOnRealBranch(null)).toBe(false)
  })

  it('returns false for in-progress labels', () => {
    expect(isOnRealBranch('rebasing 5/20 onto main')).toBe(false)
    expect(isOnRealBranch('rebasing')).toBe(false)
    expect(isOnRealBranch('bisecting (3 steps, ~5 commits left)')).toBe(false)
    expect(isOnRealBranch('bisecting')).toBe(false)
    expect(isOnRealBranch('cherry-picking 2/7')).toBe(false)
    expect(isOnRealBranch('cherry-picking')).toBe(false)
  })
})
