import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { basename, join, resolve, relative, isAbsolute } from 'path'
import {
  existsSync,
  mkdirSync,
  statSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { log } from './debug'
import { perfLog } from './perf-log'
import { resolveUserShell, loginShellCommandArgs } from './user-shell'
import type { Worktree } from '../shared/state/worktrees'

const execFileAsync = promisify(execFile)

type ExecOpts = NonNullable<Parameters<typeof execFileAsync>[2]>

async function tracedExec(
  args: string[],
  opts: ExecOpts
): Promise<{ stdout: string; execMs: number; outputBytes: number }> {
  const t0 = performance.now()
  const { stdout } = await execFileAsync('git', args, opts)
  const execMs = performance.now() - t0
  const text = typeof stdout === 'string' ? stdout : stdout.toString()
  return { stdout: text, execMs, outputBytes: text.length }
}

// Alias so existing imports of WorktreeInfo keep working; the canonical
// shape now lives in src/shared/state/worktrees.ts.
export type WorktreeInfo = Worktree

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
  /** Lines added. Undefined for binary files (numstat reports `-`) and
   * untracked files (no diff baseline yet). */
  additions?: number
  /** Lines deleted. Undefined for binary files and untracked files. */
  deletions?: number
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
  pushed: boolean
}

/** Hashes of commits on this branch not yet reachable from origin/<branch>.
 * Empty set if the branch has no remote tracking ref (all commits are local). */
async function getUnpushedHashes(worktreePath: string): Promise<Set<string> | null> {
  const branch = await getCurrentBranch(worktreePath)
  if (!branch) return null
  const remoteRef = `refs/remotes/origin/${branch}`
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', remoteRef], {
      cwd: worktreePath
    })
  } catch {
    return null
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', `origin/${branch}..HEAD`, '--pretty=format:%H', '--max-count=500'],
      { cwd: worktreePath }
    )
    return new Set(stdout.split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

/** Get commits unique to this branch (i.e. base..HEAD). */
export async function getBranchCommits(worktreePath: string): Promise<BranchCommit[]> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result: BranchCommit[] = []

  const tBase = performance.now()
  const base = await getDefaultBaseRef(worktreePath)
  const baseMs = performance.now() - tBase
  walledExec += baseMs
  cumExec += baseMs
  execParts.push(baseMs)

  if (base !== 'HEAD') {
    try {
      const sep = '\x1f'
      const tA = performance.now()
      const [logRes, unpushed] = await Promise.all([
        tracedExec(
          [
            'log',
            `${base}..HEAD`,
            `--pretty=format:%H${sep}%h${sep}%s${sep}%an${sep}%ar${sep}%at`,
            '--max-count=200'
          ],
          { cwd: worktreePath }
        ),
        getUnpushedHashes(worktreePath)
      ])
      walledExec += performance.now() - tA
      cumExec += logRes.execMs
      execParts.push(logRes.execMs)
      outputBytes += logRes.outputBytes

      for (const line of logRes.stdout.split('\n')) {
        if (!line) continue
        const [hash, shortHash, subject, author, relativeDate, ts] = line.split(sep)
        const pushed = unpushed === null ? false : !unpushed.has(hash)
        result.push({
          hash,
          shortHash,
          subject,
          author,
          relativeDate,
          timestamp: Number(ts) || 0,
          pushed
        })
      }
    } catch {
      result = []
    }
  }

  logGitOp('getBranchCommits', {}, t0, walledExec, cumExec, outputBytes, execParts)
  return result
}

function mapNameStatus(code: string): ChangedFile['status'] {
  const c = code[0]
  if (c === 'A') return 'added'
  if (c === 'D') return 'deleted'
  if (c === 'R') return 'renamed'
  if (c === 'C') return 'renamed'
  return 'modified'
}

type NumstatCounts = { additions: number; deletions: number } | null

/** Parse `git diff --numstat -z` output. Rename rows look like
 * `add\tdel\t\0oldpath\0newpath\0` and are keyed by the destination path.
 * Binary files report `-` for both counts and map to null. */
function parseNumstatZ(stdout: string): Map<string, NumstatCounts> {
  const map = new Map<string, NumstatCounts>()
  const tokens = stdout.split('\0')
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    if (!tok) { i++; continue }
    const tabs = tok.split('\t')
    if (tabs.length < 3) { i++; continue }
    const [addStr, delStr, pathField] = tabs
    const counts: NumstatCounts =
      addStr === '-' || delStr === '-'
        ? null
        : { additions: Number(addStr), deletions: Number(delStr) }
    if (pathField === '') {
      // Rename: next two NUL-separated tokens are old then new path.
      const newPath = tokens[i + 2] ?? ''
      if (newPath) map.set(newPath, counts)
      i += 3
    } else {
      map.set(pathField, counts)
      i++
    }
  }
  return map
}

async function numstatExec(
  worktreePath: string,
  args: string[]
): Promise<{ stdout: string; execMs: number; outputBytes: number }> {
  try {
    return await tracedExec(['diff', '--numstat', '-z', ...args], {
      cwd: worktreePath,
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return { stdout: '', execMs: 0, outputBytes: 0 }
  }
}

function logGitOp(
  name: string,
  ctx: Record<string, unknown>,
  t0: number,
  walledExec: number,
  cumExec: number,
  outputBytes: number,
  execParts: number[]
): void {
  const total = performance.now() - t0
  const postMs = Math.max(0, total - walledExec)
  perfLog(
    'git-op',
    `${name} exec=${cumExec.toFixed(0)}ms post=${postMs.toFixed(0)}ms bytes=${outputBytes}`,
    {
      name,
      ...ctx,
      execMs: +cumExec.toFixed(1),
      postMs: +postMs.toFixed(1),
      outputBytes,
      execParts: execParts.map((n) => +n.toFixed(1))
    }
  )
}

/** Renamed entries from `git status --porcelain` are stored as
 * "old -> new" — match numstat by the destination path. */
function destOf(p: string): string {
  const idx = p.indexOf(' -> ')
  return idx >= 0 ? p.slice(idx + 4) : p
}

function applyCounts(file: ChangedFile, counts: NumstatCounts | undefined): void {
  if (!counts) return
  file.additions = counts.additions
  file.deletions = counts.deletions
}

/** Get changed files (staged, unstaged, and untracked) in a worktree */
export async function getChangedFiles(
  worktreePath: string,
  mode: ChangedFilesMode = 'working'
): Promise<ChangedFile[]> {
  const t0 = performance.now()
  const result = await getChangedFilesImpl(worktreePath, mode)
  const ms = performance.now() - t0
  perfLog(
    'changed-files',
    `mode=${mode} path=${basename(worktreePath)} took=${ms.toFixed(0)}ms files=${result.length}`,
    { worktreePath, mode, ms: +ms.toFixed(1), fileCount: result.length }
  )
  return result
}

async function getChangedFilesImpl(
  worktreePath: string,
  mode: ChangedFilesMode
): Promise<ChangedFile[]> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result: ChangedFile[] = []

  if (mode === 'branch') {
    const tBase = performance.now()
    const base = await getDefaultBaseRef(worktreePath)
    const baseMs = performance.now() - tBase
    walledExec += baseMs
    cumExec += baseMs
    execParts.push(baseMs)

    if (base !== 'HEAD') {
      try {
        const tA = performance.now()
        const [diff, ns] = await Promise.all([
          tracedExec(['diff', '--name-status', `${base}...HEAD`], { cwd: worktreePath }),
          numstatExec(worktreePath, [`${base}...HEAD`])
        ])
        walledExec += performance.now() - tA
        cumExec += diff.execMs + ns.execMs
        execParts.push(diff.execMs, ns.execMs)
        outputBytes += diff.outputBytes + ns.outputBytes

        const counts = parseNumstatZ(ns.stdout)
        for (const line of diff.stdout.split('\n')) {
          if (!line) continue
          const parts = line.split('\t')
          const code = parts[0]
          const filePath = parts[parts.length - 1]
          const file: ChangedFile = { path: filePath, status: mapNameStatus(code), staged: false }
          applyCounts(file, counts.get(filePath))
          result.push(file)
        }
      } catch {
        result = []
      }
    }
  } else {
    try {
      const tA = performance.now()
      const [status, stagedNs, unstagedNs] = await Promise.all([
        tracedExec(['status', '--porcelain', '-uall'], { cwd: worktreePath }),
        numstatExec(worktreePath, ['--cached']),
        numstatExec(worktreePath, [])
      ])
      walledExec += performance.now() - tA
      cumExec += status.execMs + stagedNs.execMs + unstagedNs.execMs
      execParts.push(status.execMs, stagedNs.execMs, unstagedNs.execMs)
      outputBytes += status.outputBytes + stagedNs.outputBytes + unstagedNs.outputBytes

      const stagedCounts = parseNumstatZ(stagedNs.stdout)
      const unstagedCounts = parseNumstatZ(unstagedNs.stdout)
      const seen = new Set<string>()
      for (const line of status.stdout.split('\n')) {
        if (!line) continue
        const x = line[0]
        const y = line[1]
        const filePath = line.slice(3)

        if (x !== ' ' && x !== '?') {
          const fStatus =
            x === 'A' ? 'added' : x === 'D' ? 'deleted' : x === 'R' ? 'renamed' : 'modified'
          const file: ChangedFile = { path: filePath, status: fStatus, staged: true }
          applyCounts(file, stagedCounts.get(destOf(filePath)))
          result.push(file)
          seen.add(filePath)
        }

        if (y !== ' ' && y !== '?') {
          const fStatus = y === 'D' ? 'deleted' : 'modified'
          if (!seen.has(filePath)) {
            const file: ChangedFile = { path: filePath, status: fStatus, staged: false }
            applyCounts(file, unstagedCounts.get(destOf(filePath)))
            result.push(file)
            seen.add(filePath)
          }
        }

        if (x === '?' && y === '?') {
          result.push({ path: filePath, status: 'untracked', staged: false })
        }
      }
    } catch {
      // status failure: fall through with empty result
    }
  }

  logGitOp('getChangedFiles', { mode }, t0, walledExec, cumExec, outputBytes, execParts)
  return result
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

export async function getCommitChangedFiles(
  worktreePath: string,
  hash: string
): Promise<ChangedFile[]> {
  const t0 = performance.now()
  const result = await getCommitChangedFilesImpl(worktreePath, hash)
  const ms = performance.now() - t0
  perfLog(
    'changed-files',
    `mode=commit path=${basename(worktreePath)} took=${ms.toFixed(0)}ms files=${result.length}`,
    { worktreePath, mode: 'commit', hash, ms: +ms.toFixed(1), fileCount: result.length }
  )
  return result
}

async function getCommitChangedFilesImpl(
  worktreePath: string,
  hash: string
): Promise<ChangedFile[]> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return []
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result: ChangedFile[] = []

  try {
    const tA = performance.now()
    const [nameStatus, ns] = await Promise.all([
      tracedExec(['diff-tree', '--no-commit-id', '-r', '--name-status', hash], {
        cwd: worktreePath
      }),
      numstatExec(worktreePath, [`${hash}^`, hash])
    ])
    walledExec += performance.now() - tA
    cumExec += nameStatus.execMs + ns.execMs
    execParts.push(nameStatus.execMs, ns.execMs)
    outputBytes += nameStatus.outputBytes + ns.outputBytes

    const counts = parseNumstatZ(ns.stdout)
    for (const line of nameStatus.stdout.split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      const code = parts[0]
      const filePath = parts[parts.length - 1]
      const file: ChangedFile = { path: filePath, status: mapNameStatus(code), staged: false }
      applyCounts(file, counts.get(filePath))
      result.push(file)
    }
  } catch {
    result = []
  }

  logGitOp('getCommitChangedFiles', { hash }, t0, walledExec, cumExec, outputBytes, execParts)
  return result
}

export async function getCommitFileDiffSides(
  worktreePath: string,
  hash: string,
  filePath: string
): Promise<FileDiffSides> {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    return { original: '', modified: '', originalExists: false, modifiedExists: false, modifiedBinary: false }
  }
  const original = await getFileAtRef(worktreePath, `${hash}^`, filePath)
  const modified = await getFileAtRef(worktreePath, hash, filePath)
  return {
    original: original ?? '',
    modified: modified ?? '',
    originalExists: original != null,
    modifiedExists: modified != null,
    modifiedBinary: false
  }
}

/** Get the diff for a single file in a worktree */
export async function getFileDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  mode: ChangedFilesMode = 'working'
): Promise<string> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result = ''

  const finish = (): string => {
    logGitOp('getFileDiff', { mode, staged }, t0, walledExec, cumExec, outputBytes, execParts)
    return result
  }

  if (mode === 'branch') {
    const tBase = performance.now()
    const base = await getDefaultBaseRef(worktreePath)
    const baseMs = performance.now() - tBase
    walledExec += baseMs; cumExec += baseMs; execParts.push(baseMs)

    if (base === 'HEAD') return finish()
    try {
      const tA = performance.now()
      const r = await tracedExec(
        ['diff', '--no-color', `${base}...HEAD`, '--', filePath],
        { cwd: worktreePath }
      )
      walledExec += performance.now() - tA
      cumExec += r.execMs
      execParts.push(r.execMs)
      outputBytes += r.outputBytes
      result = r.stdout
    } catch {
      // ignore
    }
    return finish()
  }

  const args = ['diff', '--no-color']
  if (staged) args.push('--cached')
  args.push('--', filePath)

  try {
    const tA = performance.now()
    const r = await tracedExec(args, { cwd: worktreePath })
    walledExec += performance.now() - tA
    cumExec += r.execMs
    execParts.push(r.execMs)
    outputBytes += r.outputBytes
    if (r.stdout) {
      result = r.stdout
      return finish()
    }
  } catch {
    // diff may exit non-zero for some edge cases, fall through
  }

  // For untracked files, show the full file content as an "add" diff
  try {
    const tA = performance.now()
    const r = await tracedExec(
      ['diff', '--no-color', '--no-index', '/dev/null', filePath],
      { cwd: worktreePath }
    )
    walledExec += performance.now() - tA
    cumExec += r.execMs
    execParts.push(r.execMs)
    outputBytes += r.outputBytes
    result = r.stdout
  } catch (err) {
    // git diff --no-index exits with 1 when there are differences (which is always the case here)
    if (err instanceof Error && 'stdout' in err) {
      const out = (err as Error & { stdout: string }).stdout || ''
      outputBytes += out.length
      result = out
    }
  }
  return finish()
}

export interface FileDiffSides {
  original: string
  modified: string
  originalExists: boolean
  modifiedExists: boolean
  modifiedBinary: boolean
  error?: string
}

async function getFileAtRef(
  worktreePath: string,
  ref: string,
  filePath: string
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${filePath}`], {
      cwd: worktreePath,
      maxBuffer: 16 * 1024 * 1024
    })
    return stdout
  } catch {
    return null
  }
}

async function getMergeBase(worktreePath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['merge-base', ref, 'HEAD'], {
      cwd: worktreePath
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** Resolve the two sides of a single-file diff as plain text, suitable for
 * feeding Monaco's DiffEditor. Semantics match getFileDiff: working vs
 * index (unstaged), HEAD vs index (staged), merge-base vs HEAD (branch). */
export async function getFileDiffSides(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  mode: ChangedFilesMode = 'working'
): Promise<FileDiffSides> {
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []

  const timed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const tA = performance.now()
    const r = await fn()
    const ms = performance.now() - tA
    walledExec += ms
    cumExec += ms
    execParts.push(ms)
    return r
  }

  const finish = (sides: FileDiffSides): FileDiffSides => {
    logGitOp('getFileDiffSides', { mode, staged }, t0, walledExec, cumExec, outputBytes, execParts)
    return sides
  }

  if (mode === 'branch') {
    const baseRef = await timed(() => getDefaultBaseRef(worktreePath))
    if (baseRef === 'HEAD') {
      return finish({ original: '', modified: '', originalExists: false, modifiedExists: false, modifiedBinary: false })
    }
    const mb = await timed(() => getMergeBase(worktreePath, baseRef))
    const original = mb ? await timed(() => getFileAtRef(worktreePath, mb, filePath)) : null
    if (original) outputBytes += original.length
    const modified = await timed(() => getFileAtRef(worktreePath, 'HEAD', filePath))
    if (modified) outputBytes += modified.length
    return finish({
      original: original ?? '',
      modified: modified ?? '',
      originalExists: original != null,
      modifiedExists: modified != null,
      modifiedBinary: false
    })
  }

  if (staged) {
    const original = await timed(() => getFileAtRef(worktreePath, 'HEAD', filePath))
    if (original) outputBytes += original.length
    const modified = await timed(() => getFileAtRef(worktreePath, ':0', filePath))
    if (modified) outputBytes += modified.length
    return finish({
      original: original ?? '',
      modified: modified ?? '',
      originalExists: original != null,
      modifiedExists: modified != null,
      modifiedBinary: false
    })
  }

  let original = await timed(() => getFileAtRef(worktreePath, ':0', filePath))
  if (original == null) original = await timed(() => getFileAtRef(worktreePath, 'HEAD', filePath))
  if (original) outputBytes += original.length
  const read = await timed(() => readWorktreeFile(worktreePath, filePath))
  if (read.content) outputBytes += read.content.length
  if (read.binary) {
    return finish({
      original: original ?? '',
      modified: '',
      originalExists: original != null,
      modifiedExists: true,
      modifiedBinary: true
    })
  }
  return finish({
    original: original ?? '',
    modified: read.content ?? '',
    originalExists: original != null,
    modifiedExists: read.content != null,
    modifiedBinary: false,
    error: read.error
  })
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
export async function getCurrentBranch(worktreePath: string): Promise<string> {
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
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  const execParts: number[] = []

  const t1 = performance.now()
  const trees = await listWorktrees(repoRoot)
  const ms1 = performance.now() - t1
  walledExec += ms1; cumExec += ms1; execParts.push(ms1)

  const main = trees.find((t) => t.isMain) || trees[0]
  const mainPath = main?.path || repoRoot

  const t2 = performance.now()
  const baseBranch = await getLocalBaseBranch(repoRoot)
  const ms2 = performance.now() - t2
  walledExec += ms2; cumExec += ms2; execParts.push(ms2)

  const t3 = performance.now()
  const currentBranch = await getCurrentBranch(mainPath)
  const ms3 = performance.now() - t3
  walledExec += ms3; cumExec += ms3; execParts.push(ms3)

  const t4 = performance.now()
  const isDirty = await isWorktreeDirty(mainPath)
  const ms4 = performance.now() - t4
  walledExec += ms4; cumExec += ms4; execParts.push(ms4)

  const isOnBase = currentBranch === baseBranch
  logGitOp('getMainWorktreeStatus', {}, t0, walledExec, cumExec, 0, execParts)
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
  const t0 = performance.now()
  let walledExec = 0
  let cumExec = 0
  let outputBytes = 0
  const execParts: number[] = []
  let result: string[] = []

  try {
    const tA = performance.now()
    const r = await tracedExec(
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: worktreePath, maxBuffer: 32 * 1024 * 1024 }
    )
    walledExec += performance.now() - tA
    cumExec += r.execMs
    execParts.push(r.execMs)
    outputBytes += r.outputBytes

    const files = r.stdout.split('\n').filter((l) => l.length > 0)
    files.sort((a, b) => a.localeCompare(b))
    result = files
  } catch (err) {
    log('worktree', `listAllFiles failed: ${(err as Error).message}`)
  }

  logGitOp('listAllFiles', {}, t0, walledExec, cumExec, outputBytes, execParts)
  return result
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

// Larger ceiling for binary viewers (images / PDFs) than the editor read
// path, which is meant for text editing.
const MAX_FILE_BINARY_READ_BYTES = 50 * 1024 * 1024

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  pdf: 'application/pdf'
}

export type FileBinaryReadResult =
  | { ok: true; base64: string; mime: string; size: number }
  | { ok: false; error: string }

// base64 keeps the bytes intact across both Electron IPC structured-clone
// and the JSON-only WebSocket transport, at ~33% size overhead.
export async function readWorktreeFileBinary(
  worktreePath: string,
  filePath: string
): Promise<FileBinaryReadResult> {
  const base = resolve(worktreePath)
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'Path escapes worktree' }
  }
  try {
    const st = statSync(target)
    if (!st.isFile()) {
      return { ok: false, error: 'Not a regular file' }
    }
    if (st.size > MAX_FILE_BINARY_READ_BYTES) {
      return { ok: false, error: `File too large (${st.size} bytes, max ${MAX_FILE_BINARY_READ_BYTES})` }
    }
    const buf = await readFile(target)
    const ext = (filePath.split('.').pop() || '').toLowerCase()
    const mime = EXT_TO_MIME[ext] ?? 'application/octet-stream'
    return {
      ok: true,
      base64: buf.toString('base64'),
      mime,
      size: st.size
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface FileWriteResult {
  ok: boolean
  error?: string
}

const MAX_FILE_WRITE_BYTES = 5 * 1024 * 1024

/** Write a single file within a worktree. Rejects paths that escape the
 * worktree and refuses symlinks. Last-write-wins — no concurrent-edit
 * detection in v1. */
export async function writeWorktreeFile(
  worktreePath: string,
  filePath: string,
  contents: string
): Promise<FileWriteResult> {
  const base = resolve(worktreePath)
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath)
  const rel = relative(base, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: 'Path escapes worktree' }
  }
  const byteLen = Buffer.byteLength(contents, 'utf8')
  if (byteLen > MAX_FILE_WRITE_BYTES) {
    return { ok: false, error: `File too large (${byteLen} bytes, max ${MAX_FILE_WRITE_BYTES})` }
  }
  try {
    // Refuse to clobber a symlink — the real file lives somewhere we
    // haven't validated.
    try {
      const lst = lstatSync(target)
      if (lst.isSymbolicLink()) {
        return { ok: false, error: 'Refusing to write through a symlink' }
      }
      if (lst.isDirectory()) {
        return { ok: false, error: 'Target is a directory' }
      }
    } catch {
      // Target may not exist yet — that's fine, we're creating it.
    }
    await writeFile(target, contents, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface WorktreeScriptResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}

/** Run a user-configured setup/teardown command via the user's login shell
 * so homebrew/nvm paths resolve, with cwd set to the worktree and HARNESS_*
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
      const child = spawn(resolveUserShell(), loginShellCommandArgs(trimmed), {
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

/** Point a worktree's `.claude/settings.local.json` at the main worktree's
 * copy via a symlink, so "Don't ask again" permissions granted in any
 * worktree apply to all of them. No-op if main has no settings.local.json
 * yet — we don't want to create one just to have something to symlink.
 * Idempotent: if the target is already a symlink, does nothing. If a
 * regular file already exists in the new worktree, it is merged into
 * main's copy (shallow merge) before being replaced with the symlink. */
export function symlinkClaudeSettings(mainWorktreePath: string, newWorktreePath: string): void {
  if (mainWorktreePath === newWorktreePath) return
  const mainSettingsPath = join(mainWorktreePath, '.claude', 'settings.local.json')
  if (!existsSync(mainSettingsPath)) return

  const newClaudeDir = join(newWorktreePath, '.claude')
  const newSettingsPath = join(newClaudeDir, 'settings.local.json')

  if (!existsSync(newClaudeDir)) mkdirSync(newClaudeDir, { recursive: true })

  if (existsSync(newSettingsPath)) {
    const stat = lstatSync(newSettingsPath)
    if (stat.isSymbolicLink()) return
    try {
      const mainSettings = JSON.parse(readFileSync(mainSettingsPath, 'utf-8'))
      const newSettings = JSON.parse(readFileSync(newSettingsPath, 'utf-8'))
      writeFileSync(mainSettingsPath, JSON.stringify({ ...mainSettings, ...newSettings }, null, 2))
    } catch {
      // If either file is corrupt JSON, fall through and let the symlink win.
    }
    unlinkSync(newSettingsPath)
  }

  symlinkSync(mainSettingsPath, newSettingsPath)
}

export async function removeWorktree(repoRoot: string, path: string, force?: boolean): Promise<void> {
  log('worktree', `removing worktree: path=${path} force=${force}`)
  const args = ['worktree', 'remove', path]
  if (force) args.push('--force')
  await execFileAsync('git', args, { cwd: repoRoot })
}
