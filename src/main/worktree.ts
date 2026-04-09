import { execFile } from 'child_process'
import { promisify } from 'util'
import { basename, join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { log } from './debug'

const execFileAsync = promisify(execFile)

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
  isBare: boolean
  isMain: boolean
}

/** Get a sensible default directory for worktrees: <repo>-worktrees/ alongside the repo */
export function defaultWorktreeDir(repoRoot: string): string {
  const repoName = basename(repoRoot)
  return join(repoRoot, '..', `${repoName}-worktrees`)
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot
  })

  const worktrees: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> = {}

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    } else if (line === 'bare') {
      current.isBare = true
    } else if (line === '') {
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch || '(detached)',
          head: current.head || '',
          isBare: current.isBare || false,
          isMain: current.path === repoRoot
        })
      }
      current = {}
    }
  }

  return worktrees
}

export async function listBranches(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['branch', '-a', '--format=%(refname:short)'],
    { cwd: repoRoot }
  )
  return stdout.trim().split('\n').filter(Boolean)
}

export async function addWorktree(
  repoRoot: string,
  worktreeDir: string,
  branchName: string,
  baseBranch?: string
): Promise<WorktreeInfo> {
  // Ensure worktree directory exists
  if (!existsSync(worktreeDir)) {
    mkdirSync(worktreeDir, { recursive: true })
  }

  const worktreePath = join(worktreeDir, branchName)
  log('worktree', `creating worktree: branch=${branchName} path=${worktreePath} base=${baseBranch || 'HEAD'}`)

  const args = ['worktree', 'add', worktreePath, '-b', branchName]
  if (baseBranch) {
    args.push(baseBranch)
  }

  try {
    await execFileAsync('git', args, { cwd: repoRoot })
  } catch (err) {
    // If branch already exists, try checking it out instead of creating
    if (err instanceof Error && err.message.includes('already exists')) {
      await execFileAsync('git', ['worktree', 'add', worktreePath, branchName], {
        cwd: repoRoot
      })
    } else {
      throw err
    }
  }

  const trees = await listWorktrees(repoRoot)
  const created = trees.find((t) => t.path === worktreePath)
  if (!created) throw new Error(`Failed to create worktree ${branchName}`)
  return created
}

/** Check if a worktree has uncommitted changes */
export async function isWorktreeDirty(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: path })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

/** Get changed files (staged, unstaged, and untracked) in a worktree */
export async function getChangedFiles(worktreePath: string): Promise<ChangedFile[]> {
  const files: ChangedFile[] = []
  const seen = new Set<string>()

  // Staged + unstaged changes via git status --porcelain
  const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-uall'], {
    cwd: worktreePath
  })

  for (const line of stdout.split('\n')) {
    if (!line) continue
    const x = line[0] // staged status
    const y = line[1] // unstaged status
    const filePath = line.slice(3)

    // Staged change
    if (x !== ' ' && x !== '?') {
      const status = x === 'A' ? 'added' : x === 'D' ? 'deleted' : x === 'R' ? 'renamed' : 'modified'
      files.push({ path: filePath, status, staged: true })
      seen.add(filePath)
    }

    // Unstaged change
    if (y !== ' ' && y !== '?') {
      const status = y === 'D' ? 'deleted' : 'modified'
      if (!seen.has(filePath)) {
        files.push({ path: filePath, status, staged: false })
        seen.add(filePath)
      }
    }

    // Untracked
    if (x === '?' && y === '?') {
      files.push({ path: filePath, status: 'untracked', staged: false })
    }
  }

  return files
}

/** Get the diff for a single file in a worktree */
export async function getFileDiff(worktreePath: string, filePath: string, staged: boolean): Promise<string> {
  const args = ['diff', '--no-color']
  if (staged) args.push('--cached')
  args.push('--', filePath)

  try {
    const { stdout } = await execFileAsync('git', args, { cwd: worktreePath })
    if (stdout) return stdout
  } catch {
    // diff may exit non-zero for some edge cases, fall through
  }

  // For untracked files, show the full file content as an "add" diff
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-color', '--no-index', '/dev/null', filePath], {
      cwd: worktreePath
    })
    return stdout
  } catch (err) {
    // git diff --no-index exits with 1 when there are differences (which is always the case here)
    if (err instanceof Error && 'stdout' in err) {
      return (err as Error & { stdout: string }).stdout || ''
    }
    return ''
  }
}

export interface CheckStatus {
  name: string
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'error'
  description: string
}

export interface PRStatus {
  number: number
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  url: string
  branch: string
  checks: CheckStatus[]
  checksOverall: 'success' | 'failure' | 'pending' | 'none'
}

/** Get PR status for the branch checked out in a worktree. Returns null if no PR. */
export async function getPRStatus(worktreePath: string): Promise<PRStatus | null> {
  try {
    // Get current branch
    const { stdout: branch } = await execFileAsync(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: worktreePath }
    )
    const branchName = branch.trim()
    if (!branchName || branchName === 'HEAD') return null

    // Use gh to find PR for this branch
    const { stdout: prJson } = await execFileAsync(
      'gh', ['pr', 'view', branchName, '--json', 'number,title,state,url,isDraft,statusCheckRollup'],
      { cwd: worktreePath }
    )

    const pr = JSON.parse(prJson)
    if (!pr.number) return null

    // Parse check statuses
    const checks: CheckStatus[] = (pr.statusCheckRollup || []).map(
      (c: { name: string; status: string; conclusion: string; state: string }) => {
        let state: CheckStatus['state']
        // statusCheckRollup items can be CheckRun (status/conclusion) or StatusContext (state)
        if (c.conclusion) {
          state = c.conclusion.toLowerCase() as CheckStatus['state']
        } else if (c.state) {
          const s = c.state.toLowerCase()
          state = s === 'expected' || s === 'pending' ? 'pending' : s as CheckStatus['state']
        } else if (c.status === 'COMPLETED') {
          state = 'success'
        } else {
          state = 'pending'
        }
        return { name: c.name || 'Unknown', state, description: '' }
      }
    )

    // Overall status
    let checksOverall: PRStatus['checksOverall'] = 'none'
    if (checks.length > 0) {
      if (checks.some((c) => c.state === 'failure' || c.state === 'error')) {
        checksOverall = 'failure'
      } else if (checks.some((c) => c.state === 'pending')) {
        checksOverall = 'pending'
      } else {
        checksOverall = 'success'
      }
    }

    const state = pr.isDraft ? 'draft' : (pr.state?.toLowerCase() as PRStatus['state']) || 'open'

    return {
      number: pr.number,
      title: pr.title,
      state,
      url: pr.url,
      branch: branchName,
      checks,
      checksOverall
    }
  } catch (err) {
    // gh pr view exits non-zero if no PR exists for the branch
    log('worktree', `getPRStatus failed (likely no PR)`, err instanceof Error ? err.message : err)
    return null
  }
}

export async function removeWorktree(repoRoot: string, path: string, force?: boolean): Promise<void> {
  log('worktree', `removing worktree: path=${path} force=${force}`)
  const args = ['worktree', 'remove', path]
  if (force) args.push('--force')
  await execFileAsync('git', args, { cwd: repoRoot })
}
