// Main-side worktree transfer. See src/shared/transfer.ts for the wire
// types and the copy-not-move rationale.
//
// The payload is a single gzipped tar staged on disk, never held in
// memory: the export side builds it and the caller pulls it back in
// TRANSFER_CHUNK_BYTES slices, the import side writes those slices back
// into a file and untars. Layout inside the tar:
//
//   meta.json     branch, base sha, stash sha, lochy ref
//   code.bundle   git bundle, thin — commits from the merge base up
//   lochy/        a lochy store containing exactly one saved bundle
//
// The bundle is thin on purpose. A full-history bundle of a real repo
// is the entire packfile; the destination already has the repo (we
// `git worktree add` into an existing repoRoot), so all it needs is the
// commits unique to this branch. The cost is that the destination must
// have the merge base — meta.json records it so a missing base fails
// with a sentence instead of a git error about a broken bundle.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, open, realpath } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir, homedir } from 'os'
import { randomUUID } from 'crypto'
import { log } from './debug'
import { resolveUserShell } from './user-shell'
import { addWorktree, defaultWorktreeDir, localBranchExists, getDefaultBaseRef } from './worktree'
import {
  TRANSFER_CHUNK_BYTES,
  type TransferCapability,
  type TransferExport,
  type TransferImport,
  type TransferImportedSession,
  type TransferSessionSummary,
  type TranscriptPathCheck
} from '../shared/transfer'

const execFileAsync = promisify(execFile)

// BSD tar archives xattrs as separate AppleDouble `._name` members, which
// GNU tar on the destination restores as literal junk files sitting next to
// every transferred file. COPYFILE_DISABLE suppresses them; it's inert on
// GNU tar, so this is unconditional rather than platform-gated.
const TAR_ENV = { env: { ...process.env, COPYFILE_DISABLE: '1' } }

/** Ref namespace for the `git stash create` commit. Lives under refs/
 *  rather than in a branch so it can ride the bundle without looking
 *  like something the user should see, and is deleted on both sides
 *  once the objects have been copied. */
const STASH_REF = 'refs/harness-transfer/stash'

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024
  })
  return stdout.toString().trim()
}

// lochy installs to ~/.local/bin, which isn't on the PATH an Electron
// app inherits from Finder. path-fix merges the login shell's PATH at
// boot, but that runs before the user may have installed lochy, so
// resolve through a login shell once and cache the absolute path —
// then exec it directly, so no user-supplied path is ever concatenated
// into a shell string.
let lochyPath: string | null | undefined

async function resolveLochy(): Promise<string | null> {
  if (lochyPath !== undefined) return lochyPath
  try {
    const { stdout } = await execFileAsync(resolveUserShell(), ['-lc', 'command -v lochy'], {
      timeout: 10_000
    })
    const found = stdout.toString().trim().split('\n').pop()?.trim() ?? ''
    lochyPath = found && existsSync(found) ? found : null
  } catch {
    lochyPath = null
  }
  return lochyPath
}

/** Run a lochy subcommand in --json mode. Per lochy's contract exactly
 *  one document lands on stdout; empty or unparseable output means no
 *  process ran, which we surface as a thrown error rather than an
 *  empty result the caller would misread as success. */
async function lochyJson(args: string[]): Promise<Record<string, unknown>> {
  const bin = await resolveLochy()
  if (!bin) throw new Error('lochy is not installed on this machine')
  const { stdout } = await execFileAsync(bin, [...args, '--json'], {
    maxBuffer: 64 * 1024 * 1024
  })
  const text = stdout.toString().trim()
  if (!text) throw new Error(`lochy ${args[0]} produced no output`)
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`lochy ${args[0]} produced unparseable output`)
  }
  if (doc.ok !== true) {
    throw new Error(String(doc.error ?? `lochy ${args[0]} failed`))
  }
  return doc
}

export async function probeTransfer(): Promise<TransferCapability> {
  const [lochy, gitOk] = await Promise.all([
    resolveLochy().then(
      (bin) => !!bin,
      () => false
    ),
    execFileAsync('git', ['--version']).then(
      () => true,
      () => false
    )
  ])
  return { lochy, git: gitOk, platform: process.platform }
}

interface ExportEntry {
  dir: string
  payloadPath: string
  totalBytes: number
}

interface ImportEntry {
  dir: string
  payloadPath: string
  repoRoot: string
  branchName: string
  chunkCount: number
  totalBytes: number
}

const exports = new Map<string, ExportEntry>()
const imports = new Map<string, ImportEntry>()

interface PayloadMeta {
  branchName: string
  baseSha: string
  stashSha: string | null
  hasUntracked: boolean
  lochyRef: string | null
  originWorktreePath: string
}

export async function exportWorktree(params: { worktreePath: string }): Promise<TransferExport> {
  const { worktreePath } = params
  if (!existsSync(worktreePath)) throw new Error(`No such worktree: ${worktreePath}`)

  const gitCommonDir = await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const repoRoot = dirname(gitCommonDir)
  const branchName = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branchName === 'HEAD') throw new Error('Cannot transfer a detached HEAD worktree')

  const baseRef = await getDefaultBaseRef(worktreePath)
  const baseSha = await git(worktreePath, ['merge-base', baseRef, 'HEAD'])

  // `stash create` writes a commit capturing the dirty state and prints
  // its sha without touching the index or working tree — the whole
  // reason the source worktree survives the transfer untouched. Empty
  // output means the worktree was clean.
  //
  // It covers tracked files only. Unlike `git stash push`, `stash
  // create` takes no `-u`: the flag is silently parsed as the stash
  // message, so it looks accepted and does nothing. Untracked files —
  // which a worktree mid-feature is usually full of — are tarred
  // separately below.
  const stashSha = (await git(worktreePath, ['stash', 'create'])) || null

  const dir = await mkdtemp(join(tmpdir(), 'harness-export-'))
  const stage = join(dir, 'stage')
  await mkdir(stage, { recursive: true })

  try {
    if (stashSha) await git(repoRoot, ['update-ref', STASH_REF, stashSha])
    try {
      const bundleArgs = [
        'bundle',
        'create',
        join(stage, 'code.bundle'),
        `^${baseSha}`,
        branchName
      ]
      if (stashSha) bundleArgs.push(STASH_REF)
      await git(worktreePath, bundleArgs)
    } finally {
      if (stashSha) await git(repoRoot, ['update-ref', '-d', STASH_REF]).catch(() => {})
    }

    // --exclude-standard keeps gitignored paths (node_modules, build
    // output) out, so this is the new source files the user hasn't
    // committed yet, not the whole tree.
    // Deliberately not via `git()`: that trims its output, and a
    // filename may legally begin or end with a space. Read raw.
    const { stdout: untracked } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      { cwd: worktreePath, maxBuffer: 64 * 1024 * 1024 }
    )
    const hasUntracked = untracked.length > 0
    if (hasUntracked) {
      const listFile = join(dir, 'untracked.list')
      await writeFile(listFile, untracked)
      await execFileAsync(
        'tar',
        [
          'czf',
          join(stage, 'untracked.tar.gz'),
          '-C',
          worktreePath,
          '--null',
          '-T',
          listFile
        ],
        TAR_ENV
      )
    }

    let sessions: TransferSessionSummary[] = []
    let redacted = 0
    let lochyRef: string | null = null
    let transcriptsSkipped: string | null = null

    try {
      const saved = await lochyJson([
        'save',
        '--cwd',
        worktreePath,
        '--store',
        join(stage, 'lochy')
      ])
      lochyRef = typeof saved.ref === 'string' ? saved.ref : null
      redacted = typeof saved.redacted === 'number' ? saved.redacted : 0
      sessions = (Array.isArray(saved.sessions) ? saved.sessions : []).map((s) => {
        const row = s as Record<string, unknown>
        return {
          sessionId: String(row.sessionId ?? ''),
          branch: typeof row.branch === 'string' ? row.branch : null,
          bytes: 0,
          redactions: (row.redactions as Record<string, number>) ?? {}
        }
      })
    } catch (err) {
      transcriptsSkipped = err instanceof Error ? err.message : String(err)
      log('transfer', `transcripts skipped: ${transcriptsSkipped}`)
    }

    const meta: PayloadMeta = {
      branchName,
      baseSha,
      stashSha,
      hasUntracked,
      lochyRef,
      originWorktreePath: worktreePath
    }
    await writeFile(join(stage, 'meta.json'), JSON.stringify(meta, null, 2))

    const payloadPath = join(dir, 'payload.tar.gz')
    await execFileAsync('tar', ['czf', payloadPath, '-C', stage, '.'], TAR_ENV)

    const { size } = await stat(payloadPath)
    const handle = randomUUID()
    exports.set(handle, { dir, payloadPath, totalBytes: size })

    log(
      'transfer',
      `exported ${branchName} handle=${handle} bytes=${size} sessions=${sessions.length} stash=${!!stashSha}`
    )

    return {
      handle,
      repoRoot,
      branchName,
      worktreePath,
      stashSha,
      lochyRef,
      totalBytes: size,
      chunkCount: Math.max(1, Math.ceil(size / TRANSFER_CHUNK_BYTES)),
      sessions,
      redacted,
      transcriptsSkipped
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
}

export async function readChunk(handle: string, index: number): Promise<string> {
  const entry = exports.get(handle)
  if (!entry) throw new Error(`Unknown export handle ${handle}`)
  const offset = index * TRANSFER_CHUNK_BYTES
  if (offset >= entry.totalBytes && entry.totalBytes > 0) {
    throw new Error(`Chunk ${index} is past the end of the payload`)
  }
  const length = Math.min(TRANSFER_CHUNK_BYTES, entry.totalBytes - offset)
  const fh = await open(entry.payloadPath, 'r')
  try {
    const buf = Buffer.alloc(length)
    await fh.read(buf, 0, length, offset)
    return buf.toString('base64')
  } finally {
    await fh.close()
  }
}

export async function beginImport(params: {
  repoRoot: string
  branchName: string
  chunkCount: number
  totalBytes: number
}): Promise<{ handle: string }> {
  const { branchName, chunkCount, totalBytes } = params
  if (!existsSync(params.repoRoot)) {
    throw new Error(`No such repo on this machine: ${params.repoRoot}`)
  }
  // git reports worktree paths in canonical form, so a repo reached
  // through a symlink (/tmp → /private/tmp on macOS) would make the
  // post-create lookup in addWorktree miss the worktree it just made.
  const repoRoot = await realpath(params.repoRoot)
  if (await localBranchExists(repoRoot, branchName)) {
    throw new Error(
      `Branch ${branchName} already exists here. Delete or rename it before transferring.`
    )
  }
  const dir = await mkdtemp(join(tmpdir(), 'harness-import-'))
  const handle = randomUUID()
  imports.set(handle, {
    dir,
    payloadPath: join(dir, 'payload.tar.gz'),
    repoRoot,
    branchName,
    chunkCount,
    totalBytes
  })
  log('transfer', `import begun handle=${handle} branch=${branchName} bytes=${totalBytes}`)
  return { handle }
}

export async function writeChunk(handle: string, index: number, base64: string): Promise<boolean> {
  const entry = imports.get(handle)
  if (!entry) throw new Error(`Unknown import handle ${handle}`)
  const buf = Buffer.from(base64, 'base64')
  const fh = await open(entry.payloadPath, index === 0 ? 'w' : 'r+')
  try {
    await fh.write(buf, 0, buf.length, index * TRANSFER_CHUNK_BYTES)
  } finally {
    await fh.close()
  }
  return true
}

export async function finishImport(handle: string): Promise<TransferImport> {
  const entry = imports.get(handle)
  if (!entry) throw new Error(`Unknown import handle ${handle}`)
  const { dir, payloadPath, repoRoot, branchName } = entry

  const { size } = await stat(payloadPath)
  if (size !== entry.totalBytes) {
    throw new Error(`Payload is ${size} bytes, expected ${entry.totalBytes}`)
  }

  const stage = join(dir, 'stage')
  await mkdir(stage, { recursive: true })
  await execFileAsync('tar', ['xzf', payloadPath, '-C', stage])

  const meta = JSON.parse(await readFile(join(stage, 'meta.json'), 'utf8')) as PayloadMeta

  try {
    await git(repoRoot, ['cat-file', '-e', `${meta.baseSha}^{commit}`])
  } catch {
    throw new Error(
      `This machine's copy of the repo doesn't have commit ${meta.baseSha.slice(0, 8)}, ` +
        `which the branch is based on. Fetch the repo here first, then retry.`
    )
  }

  const bundle = join(stage, 'code.bundle')
  const refspecs = [`+refs/heads/${branchName}:refs/heads/${branchName}`]
  if (meta.stashSha) refspecs.push(`+${STASH_REF}:${STASH_REF}`)
  await git(repoRoot, ['fetch', bundle, ...refspecs])

  const created = await addWorktree(repoRoot, defaultWorktreeDir(repoRoot), branchName, {
    checkoutExisting: true
  })

  let stashApplied = false
  if (meta.stashSha) {
    try {
      await git(created.path, ['stash', 'apply', meta.stashSha])
      stashApplied = true
    } catch (err) {
      log('transfer', `stash apply failed`, err instanceof Error ? err.message : err)
    }
    await git(repoRoot, ['update-ref', '-d', STASH_REF]).catch(() => {})
  }

  if (meta.hasUntracked) {
    await execFileAsync('tar', ['xzf', join(stage, 'untracked.tar.gz'), '-C', created.path])
  }

  let sessions: TransferImportedSession[] = []
  let transcriptsSkipped: string | null = null
  let worktreePath = created.path

  if (meta.lochyRef) {
    try {
      // --new-id so the destination gets fresh session ids: the source
      // copy stays resumable, and two machines never claim the same
      // session id in cost aggregation.
      const restored = await lochyJson([
        'restore',
        meta.lochyRef,
        '--into',
        created.path,
        '--store',
        join(stage, 'lochy'),
        '--new-id'
      ])
      // lochy resolves symlinks (/tmp → /private/tmp on macOS) and
      // derives the transcript directory slug from the resolved form.
      // Trusting the requested path instead would point every later
      // lookup at a directory that doesn't exist.
      if (typeof restored.cwd === 'string' && restored.cwd) worktreePath = restored.cwd
      sessions = (Array.isArray(restored.sessions) ? restored.sessions : []).map((s) => {
        const row = s as Record<string, unknown>
        return {
          sessionId: String(row.sessionId ?? ''),
          originSessionId: String(row.originSessionId ?? ''),
          residualOriginPaths: Array.isArray(row.residualOriginPaths)
            ? (row.residualOriginPaths as string[])
            : [],
          resumeCommand: String(row.resumeCommand ?? '')
        }
      })
    } catch (err) {
      transcriptsSkipped = err instanceof Error ? err.message : String(err)
      log('transfer', `restore skipped: ${transcriptsSkipped}`)
    }
  } else {
    transcriptsSkipped = 'The source machine had no transcripts to send'
  }

  const transcriptPathCheck = sessions.length
    ? await checkTranscriptPaths(worktreePath, sessions)
    : null

  imports.delete(handle)
  await rm(dir, { recursive: true, force: true })

  const foreign = transcriptPathCheck
    ? Object.values(transcriptPathCheck.foreign).reduce((a, b) => a + b, 0)
    : 0
  log(
    'transfer',
    `imported ${branchName} at ${worktreePath} sessions=${sessions.length} foreignCwds=${foreign}`
  )

  return {
    worktreePath,
    branchName,
    stashApplied,
    sessions,
    hasResidualPaths: sessions.some((s) => s.residualOriginPaths.length > 0),
    transcriptsSkipped,
    transcriptPathCheck
  }
}

/** Read the restored transcripts back and count how many records point
 *  at `worktreePath`. This exists because a restore can rewrite paths
 *  onto a directory that doesn't exist here and still report success,
 *  which makes a broken transfer indistinguishable from a good one. */
async function checkTranscriptPaths(
  worktreePath: string,
  sessions: TransferImportedSession[]
): Promise<TranscriptPathCheck> {
  const slug = worktreePath.replace(/[^a-zA-Z0-9]/g, '-')
  const projectDir = join(homedir(), '.claude', 'projects', slug)
  const check: TranscriptPathCheck = { checked: 0, correct: 0, foreign: {} }

  for (const session of sessions) {
    let text: string
    try {
      text = await readFile(join(projectDir, `${session.sessionId}.jsonl`), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      let cwd: unknown
      try {
        cwd = (JSON.parse(line) as Record<string, unknown>).cwd
      } catch {
        continue
      }
      if (typeof cwd !== 'string' || !cwd) continue
      check.checked++
      if (cwd === worktreePath) check.correct++
      else check.foreign[cwd] = (check.foreign[cwd] ?? 0) + 1
    }
  }
  return check
}

export async function discardTransfer(handle: string): Promise<boolean> {
  const entry = exports.get(handle) ?? imports.get(handle)
  if (!entry) return false
  exports.delete(handle)
  imports.delete(handle)
  await rm(entry.dir, { recursive: true, force: true })
  return true
}
