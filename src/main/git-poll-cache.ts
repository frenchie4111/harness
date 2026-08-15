// Skip-cache for the worktree reads behind the Changed Files / Branch Commits
// panels. Those run on a 30s fallback poll (plus the watcher signal), and each
// tick spawns several git processes against a worktree the user's agent is
// often writing to at the same time. Two independent reasons to serve the
// previous answer instead of shelling out again:
//
//   1. An operation is in flight (rebase / cherry-pick / merge / bisect, or a
//      transient index.lock). A rebase is N ref updates, so reading mid-op
//      reports garbage — the panel flaps through every intermediate step.
//   2. Nothing the read depends on has moved since last time.
//
// (2) is only sound for commit-derived reads (base...HEAD diffs, git log).
// Untracked and unstaged edits leave no trace under .git, and an agent writing
// files is exactly the case that produces them — so working-tree reads must
// never be fingerprint-skipped, or the panel goes blind.
//
// Both paths are capped at MAX_CONSECUTIVE_SKIPS so any hole — a stale
// index.lock from a crashed git, a fingerprint input nobody thought of —
// self-heals in a few minutes instead of freezing the panel for the session.

import { existsSync, readFileSync, statSync } from 'fs'
import { isAbsolute, join } from 'path'
import { isGitBusy } from './git-ops-state'
import { WorktreeWatcher } from './worktree-watcher'

const CACHE_LIMIT = 50
const MAX_CONSECUTIVE_SKIPS = 10

interface GitPaths {
  gitDir: string
  commonDir: string
}

interface Entry {
  value: unknown
  fingerprint: string | null
  skips: number
}

const pathsByWorktree = new Map<string, GitPaths>()
const entries = new Map<string, Entry>()

/** A linked worktree's gitdir holds HEAD and the op markers, but refs/ and
 * packed-refs live in the common dir — a fetch moving origin/main touches only
 * the latter, so the fingerprint has to span both. Failures aren't cached: the
 * gitdir may not exist yet when `git worktree add` is still running. */
function resolveGitPaths(worktreePath: string): GitPaths | null {
  const cached = pathsByWorktree.get(worktreePath)
  // Revalidated rather than trusted: Harness removes and recreates worktrees
  // under a shared root, so a path can be reused by a different gitdir.
  if (cached && existsSync(cached.gitDir)) return cached

  const gitDir = WorktreeWatcher.resolveGitdir(worktreePath)
  if (!gitDir) return null

  let commonDir = gitDir
  try {
    const raw = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
    if (raw) commonDir = isAbsolute(raw) ? raw : join(gitDir, raw)
  } catch {
    // No commondir file: this is the main worktree, where gitDir is the common dir.
  }

  const paths = { gitDir, commonDir }
  pathsByWorktree.set(worktreePath, paths)
  return paths
}

function stamp(path: string): string {
  try {
    const s = statSync(path)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return '-'
  }
}

/** Loose ref file for a base ref as git spells it: `origin/main` →
 * refs/remotes/origin/main, `main` → refs/heads/main. A packed ref has no
 * loose file, which is why packed-refs is in the tuple too. */
function baseRefPath(commonDir: string, ref: string): string {
  return join(commonDir, ref.includes('/') ? `refs/remotes/${ref}` : `refs/heads/${ref}`)
}

function fingerprint(paths: GitPaths, baseRef: string | null): string {
  const { gitDir, commonDir } = paths
  let head = ''
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    // Unreadable HEAD contributes an empty component; the stamps below still vary.
  }

  const parts = [head, stamp(join(gitDir, 'logs', 'HEAD'))]

  // A plain `git commit` moves refs/heads/<branch>, leaving HEAD's contents
  // and mtime untouched. The reflog catches it, but core.logAllRefUpdates can
  // be turned off, so stat the branch ref itself as well.
  const symbolic = head.match(/^ref:\s*(.+)$/)
  if (symbolic) parts.push(stamp(join(commonDir, symbolic[1].trim())))

  parts.push(stamp(join(commonDir, 'packed-refs')))
  if (baseRef) parts.push(stamp(baseRefPath(commonDir, baseRef)))

  return parts.join('|')
}

function store(key: string, entry: Entry): void {
  if (entries.has(key)) entries.delete(key)
  entries.set(key, entry)
  while (entries.size > CACHE_LIMIT) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export interface CachedGitReadOptions<T> {
  key: string
  worktreePath: string
  /** Commit-derived reads only. Working-tree reads see changes that leave no
   * trace under .git, so they can be busy-skipped but never fingerprint-skipped. */
  fingerprintable: boolean
  baseRef?: string | null
  read: () => Promise<T>
}

export async function cachedGitRead<T>(
  opts: CachedGitReadOptions<T>
): Promise<{ value: T; cached: boolean }> {
  const { key, worktreePath, fingerprintable, baseRef = null, read } = opts

  const paths = resolveGitPaths(worktreePath)
  // Sampled before the read, so a change landing mid-read leaves the entry
  // looking stale and the next tick re-reads.
  const fp = paths && fingerprintable ? fingerprint(paths, baseRef) : null
  const entry = entries.get(key)

  if (paths && entry && entry.skips < MAX_CONSECUTIVE_SKIPS) {
    if (isGitBusy(paths.gitDir) || (fp !== null && fp === entry.fingerprint)) {
      entry.skips++
      return { value: entry.value as T, cached: true }
    }
  }

  const value = await read()
  store(key, { value, fingerprint: fp, skips: 0 })
  return { value, cached: false }
}

export function resetGitPollCache(): void {
  pathsByWorktree.clear()
  entries.clear()
}
