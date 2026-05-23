import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const execFileAsync = promisify(execFile)

export interface InProgressOp {
  kind: 'rebase' | 'bisect' | 'cherry-pick'
  label: string
}

async function readGitDir(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: worktreePath
    })
    const out = stdout.trim()
    if (!out) return null
    return out
  } catch {
    return null
  }
}

function readTrim(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

async function resolveOntoName(worktreePath: string, sha: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', `--points-at=${sha}`, '--format=%(refname:short)'],
      { cwd: worktreePath }
    )
    const refs = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'HEAD' && !s.endsWith('/HEAD'))
    if (!refs.length) return null
    const remotes = refs.filter((r) => r.includes('/'))
    const pool = remotes.length ? remotes : refs
    pool.sort((a, b) => a.length - b.length || a.localeCompare(b))
    return pool[0] ?? null
  } catch {
    return null
  }
}

async function detectRebase(worktreePath: string, gitDir: string): Promise<InProgressOp | null> {
  const merge = join(gitDir, 'rebase-merge')
  const apply = join(gitDir, 'rebase-apply')
  let stepStr: string | null = null
  let totalStr: string | null = null
  let ontoSha: string | null = null

  if (existsSync(merge)) {
    stepStr = readTrim(join(merge, 'msgnum'))
    totalStr = readTrim(join(merge, 'end'))
    ontoSha = readTrim(join(merge, 'onto'))
    // newer git: onto_name; older preview: onto-name. Try both.
    const ontoNameFile =
      readTrim(join(merge, 'onto_name')) || readTrim(join(merge, 'onto-name'))
    const step = stepStr ? Number(stepStr) : NaN
    const total = totalStr ? Number(totalStr) : NaN
    let ontoLabel = ontoNameFile && ontoNameFile.length ? ontoNameFile : null
    if (!ontoLabel && ontoSha) {
      ontoLabel = await resolveOntoName(worktreePath, ontoSha)
    }
    if (Number.isFinite(step) && Number.isFinite(total) && total > 0) {
      const suffix = ontoLabel ? ` onto ${ontoLabel}` : ''
      return { kind: 'rebase', label: `rebasing ${step}/${total}${suffix}` }
    }
    const suffix = ontoLabel ? ` onto ${ontoLabel}` : ''
    return { kind: 'rebase', label: `rebasing${suffix}` }
  }

  if (existsSync(apply)) {
    stepStr = readTrim(join(apply, 'next'))
    totalStr = readTrim(join(apply, 'last'))
    const step = stepStr ? Number(stepStr) : NaN
    const total = totalStr ? Number(totalStr) : NaN
    if (Number.isFinite(step) && Number.isFinite(total) && total > 0) {
      return { kind: 'rebase', label: `rebasing ${step}/${total}` }
    }
    return { kind: 'rebase', label: 'rebasing' }
  }

  return null
}

async function detectBisect(worktreePath: string, gitDir: string): Promise<InProgressOp | null> {
  const logPath = join(gitDir, 'BISECT_LOG')
  if (!existsSync(logPath)) return null

  let steps = 0
  try {
    const log = readFileSync(logPath, 'utf8')
    for (const raw of log.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      if (/^git bisect (good|bad|new|old)\b/.test(line)) steps++
    }
  } catch {
    // fall through with steps=0
  }

  let remaining: number | null = null
  try {
    const { stdout } = await execFileAsync('git', ['bisect', 'visualize', '--oneline'], {
      cwd: worktreePath
    })
    const count = stdout.split('\n').filter((l) => l.trim().length > 0).length
    if (count > 0) remaining = count
  } catch {
    // visualize can fail when not enough info recorded yet
  }

  const stepPart = steps > 0 ? `${steps} step${steps === 1 ? '' : 's'}` : null
  const remainingPart = remaining != null ? `~${remaining} commit${remaining === 1 ? '' : 's'} left` : null
  const inside = [stepPart, remainingPart].filter(Boolean).join(', ')
  const label = inside ? `bisecting (${inside})` : 'bisecting'
  return { kind: 'bisect', label }
}

async function detectCherryPick(
  worktreePath: string,
  gitDir: string
): Promise<InProgressOp | null> {
  const headFile = join(gitDir, 'CHERRY_PICK_HEAD')
  if (!existsSync(headFile)) return null

  const seqDir = join(gitDir, 'sequencer')
  const seqHead = readTrim(join(seqDir, 'head'))
  const todoRaw = readTrim(join(seqDir, 'todo'))
  if (!seqHead || todoRaw == null) {
    return { kind: 'cherry-pick', label: 'cherry-picking' }
  }

  const todoLines = todoRaw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  let done = 0
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--count', `${seqHead}..HEAD`],
      { cwd: worktreePath }
    )
    const n = Number(stdout.trim())
    if (Number.isFinite(n) && n >= 0) done = n
  } catch {
    // fall through with done=0
  }

  const total = done + todoLines.length
  if (total <= 0) {
    return { kind: 'cherry-pick', label: 'cherry-picking' }
  }
  return { kind: 'cherry-pick', label: `cherry-picking ${done}/${total}` }
}

export async function detectInProgressOp(worktreePath: string): Promise<InProgressOp | null> {
  const gitDir = await readGitDir(worktreePath)
  if (!gitDir) return null

  const rebase = await detectRebase(worktreePath, gitDir)
  if (rebase) return rebase

  const cherry = await detectCherryPick(worktreePath, gitDir)
  if (cherry) return cherry

  const bisect = await detectBisect(worktreePath, gitDir)
  if (bisect) return bisect

  return null
}

const IN_PROGRESS_PREFIXES = ['rebasing', 'bisecting', 'cherry-picking']

export function isOnRealBranch(branch: string | undefined | null): boolean {
  if (!branch) return false
  if (branch === '(detached)') return false
  for (const prefix of IN_PROGRESS_PREFIXES) {
    if (branch === prefix || branch.startsWith(`${prefix} `) || branch.startsWith(`${prefix}(`)) {
      return false
    }
  }
  return true
}
