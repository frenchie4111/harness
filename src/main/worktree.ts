import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { basename, join, resolve, relative, isAbsolute } from 'path'
import { existsSync, mkdirSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { log } from './debug'

const execFileAsync = promisify(execFile)

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
  isBare: boolean
  isMain: boolean
  /** Directory birthtime in ms since epoch; 0 if unavailable. */
  createdAt: number
  /** The repo this worktree belongs to. */
  repoRoot: string
}

function getCreatedAt(path: string): number {
  try {
    const s = statSync(path)
    return s.birthtimeMs || s.ctimeMs || 0
  } catch {
    return 0
  }
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
          isMain: current.path === repoRoot,
          createdAt: getCreatedAt(current.path),
          repoRoot
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

/**
 * Resolve a base ref to fork/branch from, optionally fetching origin first.
 * Matches the same logic addWorktree and continueWorktree share:
 * explicit baseBranch wins; else if fetchRemote, fetch origin's default
 * branch and use origin/<default>; else return undefined (caller uses HEAD).
 */
async function resolveBaseRef(
  repoRoot: string,
  options: { baseBranch?: string; fetchRemote?: boolean }
): Promise<string | undefined> {
  if (options.baseBranch) return options.baseBranch
  if (!options.fetchRemote) return undefined
  try {
    const defaultRef = await getDefaultBaseRef(repoRoot)
    const remoteBranch = defaultRef.startsWith('origin/')
      ? defaultRef.slice('origin/'.length)
      : defaultRef
    if (remoteBranch && remoteBranch !== 'HEAD') {
      log('worktree', `fetching origin ${remoteBranch}`)
      await execFileAsync('git', ['fetch', '--quiet', 'origin', remoteBranch], { cwd: repoRoot })
    }
    const resolvedRef = await getDefaultBaseRef(repoRoot)
    if (resolvedRef && resolvedRef !== 'HEAD') return resolvedRef
  } catch (err) {
    log('worktree', `remote fetch failed, falling back to local HEAD`, err instanceof Error ? err.message : err)
  }
  return undefined
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
  const baseRef = await resolveBaseRef(repoRoot, options)

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

export interface ContinueWorktreeResult {
  worktree: WorktreeInfo
  /** Dirty files were stashed and successfully re-applied. */
  stashReapplied: boolean
  /** Dirty files are still in the stash because pop conflicted. */
  stashConflict: boolean
}

/**
 * Reuse an existing worktree path and re-point it at a brand new branch
 * forked from the repo's default base (optionally fetching origin first).
 * If the worktree has uncommitted changes, they are stashed before the
 * checkout and popped afterward so the user's in-progress work carries
 * over to the fresh branch.
 */
export async function continueWorktree(
  repoRoot: string,
  worktreePath: string,
  newBranchName: string,
  options: AddWorktreeOptions = {}
): Promise<ContinueWorktreeResult> {
  const baseRef = await resolveBaseRef(repoRoot, options)
  log(
    'worktree',
    `continuing worktree: path=${worktreePath} newBranch=${newBranchName} base=${baseRef || 'HEAD'}`
  )

  const dirty = await isWorktreeDirty(worktreePath)
  let stashed = false
  if (dirty) {
    const stashMsg = `harness-continue ${newBranchName} ${Date.now()}`
    await execFileAsync('git', ['stash', 'push', '--include-untracked', '-m', stashMsg], {
      cwd: worktreePath
    })
    stashed = true
  }

  const checkoutArgs = ['checkout', '-b', newBranchName]
  if (baseRef) checkoutArgs.push(baseRef)

  try {
    await execFileAsync('git', checkoutArgs, { cwd: worktreePath })
  } catch (err) {
    if (stashed) {
      // Best-effort: try to restore dirty state so user isn't stranded
      try {
        await execFileAsync('git', ['stash', 'pop'], { cwd: worktreePath })
      } catch {}
    }
    throw err
  }

  let stashReapplied = false
  let stashConflict = false
  if (stashed) {
    try {
      await execFileAsync('git', ['stash', 'pop'], { cwd: worktreePath })
      stashReapplied = true
    } catch {
      // Pop left changes in a conflict state; stash entry is preserved.
      stashConflict = true
    }
  }

  const trees = await listWorktrees(repoRoot)
  const updated = trees.find((t) => t.path === worktreePath)
  if (!updated) throw new Error(`Failed to locate worktree ${worktreePath} after continue`)
  return { worktree: updated, stashReapplied, stashConflict }
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

export interface BranchCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  relativeDate: string
  timestamp: number
}

/** Get commits unique to this branch (i.e. base..HEAD). */
export async function getBranchCommits(worktreePath: string): Promise<BranchCommit[]> {
  const base = await getDefaultBaseRef(worktreePath)
  if (base === 'HEAD') return []
  try {
    const sep = '\x1f'
    const { stdout } = await execFileAsync(
      'git',
      ['log', `${base}..HEAD`, `--pretty=format:%H${sep}%h${sep}%s${sep}%an${sep}%ar${sep}%at`, '--max-count=200'],
      { cwd: worktreePath }
    )
    const out: BranchCommit[] = []
    for (const line of stdout.split('\n')) {
      if (!line) continue
      const [hash, shortHash, subject, author, relativeDate, ts] = line.split(sep)
      out.push({
        hash,
        shortHash,
        subject,
        author,
        relativeDate,
        timestamp: Number(ts) || 0
      })
    }
    return out
  } catch {
    return []
  }
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

export interface CommitDiff {
  hash: string
  shortHash: string
  author: string
  authorEmail: string
  date: string
  subject: string
  body: string
  diff: string
}

/** Get a single commit's metadata + full diff. */
export async function getCommitDiff(
  worktreePath: string,
  hash: string
): Promise<CommitDiff | null> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return null
  try {
    const sep = '\x1f'
    const end = '\x1e'
    const { stdout: meta } = await execFileAsync(
      'git',
      ['show', '-s', `--pretty=format:%H${sep}%h${sep}%an${sep}%ae${sep}%aI${sep}%s${sep}%b${end}`, hash],
      { cwd: worktreePath }
    )
    const cleaned = meta.endsWith(end) ? meta.slice(0, -1) : meta
    const [fullHash, shortHash, author, authorEmail, date, subject, body = ''] = cleaned.split(sep)
    const { stdout: diff } = await execFileAsync(
      'git',
      ['show', '--no-color', '--pretty=format:', hash],
      { cwd: worktreePath, maxBuffer: 32 * 1024 * 1024 }
    )
    return {
      hash: fullHash,
      shortHash,
      author,
      authorEmail,
      date,
      subject,
      body,
      diff: diff.replace(/^\n+/, '')
    }
  } catch {
    return null
  }
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

export type MergeStrategy = 'squash' | 'merge-commit' | 'fast-forward'

export interface MainWorktreeStatus {
  path: string
  currentBranch: string
  baseBranch: string
  isOnBase: boolean
  isDirty: boolean
  /** True when the worktree is ready to accept a merge without any fixups */
  ready: boolean
}

/** Resolve the local base branch name (no remote prefix) — "main" or "master". */
async function getLocalBaseBranch(repoRoot: string): Promise<string> {
  const ref = await getDefaultBaseRef(repoRoot)
  const name = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref
  if (!name || name === 'HEAD') return 'main'
  return name
}

/** Get the current branch of a worktree, or empty string if detached. */
async function getCurrentBranch(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: worktreePath
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

/** Report status of the main worktree for a local merge. */
export async function getMainWorktreeStatus(repoRoot: string): Promise<MainWorktreeStatus> {
  const trees = await listWorktrees(repoRoot)
  const main = trees.find((t) => t.isMain) || trees[0]
  const mainPath = main?.path || repoRoot
  const baseBranch = await getLocalBaseBranch(repoRoot)
  const currentBranch = await getCurrentBranch(mainPath)
  const isDirty = await isWorktreeDirty(mainPath)
  const isOnBase = currentBranch === baseBranch
  return {
    path: mainPath,
    currentBranch,
    baseBranch,
    isOnBase,
    isDirty,
    ready: isOnBase && !isDirty
  }
}

/** Stash and/or checkout base in the main worktree so a merge can proceed.
 * Stashing is auto-labeled so the user can find it later via `git stash list`. */
export async function prepareMainForMerge(repoRoot: string): Promise<MainWorktreeStatus> {
  const status = await getMainWorktreeStatus(repoRoot)
  if (status.isDirty) {
    log('worktree', `stashing dirty changes in main worktree ${status.path}`)
    await execFileAsync(
      'git',
      ['stash', 'push', '--include-untracked', '-m', 'harness: auto-stash before local merge'],
      { cwd: status.path }
    )
  }
  if (!status.isOnBase) {
    log('worktree', `checking out ${status.baseBranch} in main worktree ${status.path}`)
    await execFileAsync('git', ['checkout', status.baseBranch], { cwd: status.path })
  }
  return getMainWorktreeStatus(repoRoot)
}

export interface MergeLocalResult {
  ok: true
  strategy: MergeStrategy
  mergedBranch: string
  baseBranch: string
  mainPath: string
}

/** Merge a worktree's branch into the local base branch inside the main worktree.
 * Requires the main worktree to already be on base and clean — caller should
 * run prepareMainForMerge first if needed. On conflict, aborts and throws. */
export async function mergeWorktreeLocally(
  repoRoot: string,
  sourceBranch: string,
  strategy: MergeStrategy
): Promise<MergeLocalResult> {
  const status = await getMainWorktreeStatus(repoRoot)
  if (!status.ready) {
    throw new Error(
      `Main worktree is not ready: ${status.isDirty ? 'has uncommitted changes' : `on ${status.currentBranch || 'detached HEAD'}, not ${status.baseBranch}`}`
    )
  }
  if (sourceBranch === status.baseBranch) {
    throw new Error(`Cannot merge ${sourceBranch} into itself`)
  }

  log('worktree', `merging ${sourceBranch} into ${status.baseBranch} (${strategy}) at ${status.path}`)

  try {
    if (strategy === 'squash') {
      await execFileAsync('git', ['merge', '--squash', sourceBranch], { cwd: status.path })
      // --squash stages the changes without committing. Commit them now.
      await execFileAsync(
        'git',
        ['commit', '-m', `${sourceBranch} (squashed)`],
        { cwd: status.path }
      )
    } else if (strategy === 'merge-commit') {
      await execFileAsync(
        'git',
        ['merge', '--no-ff', '-m', `Merge branch '${sourceBranch}'`, sourceBranch],
        { cwd: status.path }
      )
    } else {
      await execFileAsync('git', ['merge', '--ff-only', sourceBranch], { cwd: status.path })
    }
  } catch (err) {
    // Extract stderr from the execFile error — it's where git's actual
    // failure reason lives, and err.message only carries the command line.
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr || '').trim()
        : ''
    const stdout =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout: unknown }).stdout || '').trim()
        : ''
    const baseMessage = err instanceof Error ? err.message : String(err)
    const detail = stderr || stdout || baseMessage

    log('worktree', `merge failed: ${detail}`)

    // Abort any partial merge/squash state so the user is left clean.
    try {
      await execFileAsync('git', ['merge', '--abort'], { cwd: status.path })
    } catch {}
    // For --squash the failure is typically at the `git commit` step (e.g.
    // nothing to commit because the branch is equivalent to base). In that
    // case `merge --abort` is a no-op, so also reset any staged changes.
    try {
      await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: status.path })
    } catch {}

    // Friendlier message for the common "nothing to commit" case on squash
    if (strategy === 'squash' && /nothing to commit/i.test(detail)) {
      throw new Error(
        `Nothing to merge — ${sourceBranch} has no changes relative to ${status.baseBranch}.`
      )
    }
    throw new Error(`Merge failed and was aborted: ${detail}`)
  }

  return {
    ok: true,
    strategy,
    mergedBranch: sourceBranch,
    baseBranch: status.baseBranch,
    mainPath: status.path
  }
}

export interface MergeConflictPreview {
  hasConflict: boolean
  files: string[]
  /** True if git merge-tree isn't supported by the installed git (pre-2.38). */
  unsupported?: boolean
}

/** Preview a three-way merge of `sourceBranch` into `baseBranch` in-memory
 * via `git merge-tree --write-tree`. Doesn't touch the working tree or any
 * refs. Returns the list of conflicted file paths on conflict. */
export async function previewMergeConflicts(
  repoRoot: string,
  sourceBranch: string,
  baseBranch: string
): Promise<MergeConflictPreview> {
  try {
    await execFileAsync(
      'git',
      ['merge-tree', '--write-tree', '--name-only', baseBranch, sourceBranch],
      { cwd: repoRoot }
    )
    return { hasConflict: false, files: [] }
  } catch (err) {
    if (err && typeof err === 'object') {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string }
      // git merge-tree prints the tree OID on line 1, then conflicted file
      // paths on subsequent lines (with --name-only). Exit code 1 = conflicts.
      if (e.code === 1) {
        const lines = String(e.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
        // Drop the first line (tree OID) — the rest are file paths.
        const files = lines.slice(1)
        return { hasConflict: true, files }
      }
      // "unknown switch" / unsupported → older git
      const stderr = String(e.stderr || e.message || '')
      if (/unknown (option|switch)|usage: git merge-tree/i.test(stderr)) {
        return { hasConflict: false, files: [], unsupported: true }
      }
    }
    // Unknown error — treat as "can't tell", don't block the user
    return { hasConflict: false, files: [], unsupported: true }
  }
}

/** Resolve a branch ref to its current SHA, or null if it doesn't exist. */
export async function getBranchSha(repoRoot: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: repoRoot
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** True if `branch` is an ancestor of `base` (i.e. non-squash merged). */
export async function isBranchAncestorOfBase(
  repoRoot: string,
  branch: string,
  base: string
): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', branch, base], { cwd: repoRoot })
    return true
  } catch {
    return false
  }
}

/** Sum of added/removed lines and touched files for committed work on this
 *  branch vs its default base. Returns zeros if the base can't be resolved. */
export async function getBranchDiffStats(
  worktreePath: string
): Promise<{ added: number; removed: number; files: number }> {
  try {
    const base = await getDefaultBaseRef(worktreePath)
    if (!base || base === 'HEAD') return { added: 0, removed: 0, files: 0 }
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--numstat', `${base}...HEAD`],
      { cwd: worktreePath, maxBuffer: 8 * 1024 * 1024 }
    )
    let added = 0
    let removed = 0
    let files = 0
    for (const line of stdout.split('\n')) {
      if (!line) continue
      const [a, r] = line.split('\t')
      // Binary files show "-\t-" — skip line counts but still count the file.
      if (a !== '-') added += parseInt(a, 10) || 0
      if (r !== '-') removed += parseInt(r, 10) || 0
      files++
    }
    return { added, removed, files }
  } catch {
    return { added: 0, removed: 0, files: 0 }
  }
}

/** List every tracked-or-untracked-but-not-ignored file in the worktree, as repo-relative paths. */
export async function listAllFiles(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: worktreePath, maxBuffer: 32 * 1024 * 1024 }
    )
    const files = stdout.split('\n').filter((l) => l.length > 0)
    files.sort((a, b) => a.localeCompare(b))
    return files
  } catch (err) {
    log('worktree', `listAllFiles failed: ${(err as Error).message}`)
    return []
  }
}

const MAX_FILE_READ_BYTES = 2 * 1024 * 1024

export interface FileReadResult {
  content: string | null
  size: number
  binary: boolean
  truncated: boolean
  error?: string
}

/** Read a single file from within a worktree. Rejects paths that escape the worktree. */
export async function readWorktreeFile(
  worktreePath: string,
  filePath: string
): Promise<FileReadResult> {
  const base = resolve(worktreePath)
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { content: null, size: 0, binary: false, truncated: false, error: 'Path escapes worktree' }
  }
  try {
    const st = statSync(target)
    if (!st.isFile()) {
      return { content: null, size: 0, binary: false, truncated: false, error: 'Not a regular file' }
    }
    const truncated = st.size > MAX_FILE_READ_BYTES
    const buf = await readFile(target)
    const slice = truncated ? buf.subarray(0, MAX_FILE_READ_BYTES) : buf
    // Heuristic binary check: NUL byte in the first 8KB.
    const sniff = slice.subarray(0, Math.min(slice.length, 8192))
    let binary = false
    for (let i = 0; i < sniff.length; i++) {
      if (sniff[i] === 0) {
        binary = true
        break
      }
    }
    if (binary) {
      return { content: null, size: st.size, binary: true, truncated, error: undefined }
    }
    return { content: slice.toString('utf8'), size: st.size, binary: false, truncated }
  } catch (err) {
    return {
      content: null,
      size: 0,
      binary: false,
      truncated: false,
      error: (err as Error).message
    }
  }
}

export interface WorktreeScriptResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}

/** Run a user-configured setup/teardown command via a login zsh shell so
 * homebrew/nvm paths resolve, with cwd set to the worktree and HARNESS_*
 * env vars exposing the worktree context. */
export async function runWorktreeScript(
  kind: 'setup' | 'teardown',
  command: string,
  ctx: { worktreePath: string; branch: string; repoRoot: string },
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
): Promise<WorktreeScriptResult> {
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: true, exitCode: 0, stdout: '', stderr: '' }
  }
  log('worktree', `running ${kind} script for ${ctx.worktreePath}`)
  return new Promise((resolve) => {
    try {
      const child = spawn('/bin/zsh', ['-ilc', trimmed], {
        cwd: ctx.worktreePath,
        env: {
          ...process.env,
          HARNESS_WORKTREE_PATH: ctx.worktreePath,
          HARNESS_BRANCH: ctx.branch,
          HARNESS_REPO_ROOT: ctx.repoRoot
        }
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d) => {
        const chunk = d.toString()
        stdout += chunk
        onOutput?.('stdout', chunk)
      })
      child.stderr?.on('data', (d) => {
        const chunk = d.toString()
        stderr += chunk
        onOutput?.('stderr', chunk)
      })
      child.on('error', (err) => {
        log('worktree', `${kind} script spawn error: ${err.message}`)
        resolve({ ok: false, exitCode: -1, stdout, stderr, error: err.message })
      })
      child.on('close', (code) => {
        const exitCode = code ?? -1
        const ok = exitCode === 0
        log(
          'worktree',
          `${kind} script finished exit=${exitCode}${stderr ? ` stderr=${stderr.trim().slice(0, 200)}` : ''}`
        )
        resolve({ ok, exitCode, stdout, stderr })
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log('worktree', `${kind} script failed to start: ${msg}`)
      resolve({ ok: false, exitCode: -1, stdout: '', stderr: '', error: msg })
    }
  })
}

export async function removeWorktree(repoRoot: string, path: string, force?: boolean): Promise<void> {
  log('worktree', `removing worktree: path=${path} force=${force}`)
  const args = ['worktree', 'remove', path]
  if (force) args.push('--force')
  await execFileAsync('git', args, { cwd: repoRoot })
}
