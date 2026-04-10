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

export interface AddWorktreeOptions {
  /** Explicit base branch to fork from. Overrides fetchRemote detection. */
  baseBranch?: string
  /** If true, fetch the default branch from origin before creating so the
   * new worktree starts at the tip of the latest remote main. Falls back
   * to local HEAD if the fetch fails (e.g. offline). */
  fetchRemote?: boolean
}

export async function addWorktree(
  repoRoot: string,
  worktreeDir: string,
  branchName: string,
  options: AddWorktreeOptions = {}
): Promise<WorktreeInfo> {
  // Ensure worktree directory exists
  if (!existsSync(worktreeDir)) {
    mkdirSync(worktreeDir, { recursive: true })
  }

  const worktreePath = join(worktreeDir, branchName)

  // Determine the base ref.
  // 1. Explicit baseBranch wins.
  // 2. Otherwise if fetchRemote is set, fetch origin/<default> and use it.
  // 3. Otherwise leave unset → git uses HEAD.
  let baseRef: string | undefined = options.baseBranch
  if (!baseRef && options.fetchRemote) {
    try {
      const defaultRef = await getDefaultBaseRef(repoRoot)
      // defaultRef is something like "origin/main" — extract just the branch
      // name and fetch it explicitly (shallow, quiet).
      const remoteBranch = defaultRef.startsWith('origin/') ? defaultRef.slice('origin/'.length) : defaultRef
      if (remoteBranch && remoteBranch !== 'HEAD') {
        log('worktree', `fetching origin ${remoteBranch} before creating worktree`)
        await execFileAsync('git', ['fetch', '--quiet', 'origin', remoteBranch], { cwd: repoRoot })
      }
      // Re-resolve in case origin/HEAD wasn't known until after fetch.
      const resolvedRef = await getDefaultBaseRef(repoRoot)
      if (resolvedRef && resolvedRef !== 'HEAD') {
        baseRef = resolvedRef
      }
    } catch (err) {
      log('worktree', `remote fetch failed, falling back to local HEAD`, err instanceof Error ? err.message : err)
    }
  }

  log('worktree', `creating worktree: branch=${branchName} path=${worktreePath} base=${baseRef || 'HEAD'}`)

  const args = ['worktree', 'add', worktreePath, '-b', branchName]
  if (baseRef) {
    args.push(baseRef)
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

export type ChangedFilesMode = 'working' | 'branch'

/** Detect the repo's default base branch (e.g. "main" or "master"). */
export async function getDefaultBaseRef(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: worktreePath }
    )
    const ref = stdout.trim()
    if (ref) return ref
  } catch {}
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', candidate], { cwd: worktreePath })
      return candidate
    } catch {}
  }
  return 'HEAD'
}

function mapNameStatus(code: string): ChangedFile['status'] {
  const c = code[0]
  if (c === 'A') return 'added'
  if (c === 'D') return 'deleted'
  if (c === 'R') return 'renamed'
  if (c === 'C') return 'renamed'
  return 'modified'
}

/** Get changed files (staged, unstaged, and untracked) in a worktree */
export async function getChangedFiles(
  worktreePath: string,
  mode: ChangedFilesMode = 'working'
): Promise<ChangedFile[]> {
  if (mode === 'branch') {
    const base = await getDefaultBaseRef(worktreePath)
    if (base === 'HEAD') return []
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-status', `${base}...HEAD`],
        { cwd: worktreePath }
      )
      const out: ChangedFile[] = []
      for (const line of stdout.split('\n')) {
        if (!line) continue
        const parts = line.split('\t')
        const code = parts[0]
        // Renamed/copied entries have form "R100\told\tnew"
        const filePath = parts[parts.length - 1]
        out.push({ path: filePath, status: mapNameStatus(code), staged: false })
      }
      return out
    } catch {
      return []
    }
  }

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
export async function getFileDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  mode: ChangedFilesMode = 'working'
): Promise<string> {
  if (mode === 'branch') {
    const base = await getDefaultBaseRef(worktreePath)
    if (base === 'HEAD') return ''
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--no-color', `${base}...HEAD`, '--', filePath],
        { cwd: worktreePath }
      )
      return stdout
    } catch {
      return ''
    }
  }

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

export async function removeWorktree(repoRoot: string, path: string, force?: boolean): Promise<void> {
  log('worktree', `removing worktree: path=${path} force=${force}`)
  const args = ['worktree', 'remove', path]
  if (force) args.push('--force')
  await execFileAsync('git', args, { cwd: repoRoot })
}
