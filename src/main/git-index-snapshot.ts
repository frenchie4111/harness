// GIT_OPTIONAL_LOCKS=0 stops `status` and `diff --cached` from writing the
// index back, but NOT the unstaged worktree-vs-index `git diff` — that form
// refreshes and writes the index regardless (verified on git 2.50.1: 5/5 runs
// rewrote .git/index with the flag set, while status and --cached never did).
//
// That write lands in the gitdir WorktreeWatcher watches, and `index` is in its
// CHANGED_FILES_RELEVANT set — so the changed-files refetch retriggers its own
// invalidation. It isn't infinite (the second pass finds the stat cache fresh),
// but it doubles the git work behind every file edit and adds a spurious
// 200ms-debounced refresh cycle on top of every Claude tool call.
//
// Fix: point that one diff at a throwaway copy of the index. Output is
// byte-identical — the copy carries the same staged state — and the write-back
// lands outside the watched gitdir. The copy is long-lived and re-taken only
// when the real index actually moves, so git's stat-cache refresh still pays
// off across calls instead of being discarded every time.

import { copyFileSync, mkdirSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { WorktreeWatcher } from './worktree-watcher'

// Deliberately outside any gitdir — putting it inside would just move the
// feedback loop rather than cut it.
const SNAPSHOT_DIR = join(tmpdir(), 'harness-git-index')

interface Snapshot {
  path: string
  srcMtimeMs: number
  srcSize: number
}

const snapshots = new Map<string, Snapshot>()

function snapshotPathFor(worktreePath: string): string {
  const digest = createHash('sha256').update(worktreePath).digest('hex').slice(0, 16)
  return join(SNAPSHOT_DIR, `${digest}.index`)
}

/** Env overlay pointing git at a throwaway index copy for `worktreePath`.
 * Returns null when the gitdir or index can't be resolved, or the copy fails —
 * callers then run unchanged (correct output, just the old write-back). */
export function unstagedDiffIndexEnv(worktreePath: string): { GIT_INDEX_FILE: string } | null {
  const gitdir = WorktreeWatcher.resolveGitdir(worktreePath)
  if (!gitdir) return null
  const realIndex = join(gitdir, 'index')

  let src: ReturnType<typeof statSync>
  try {
    src = statSync(realIndex)
  } catch {
    return null
  }

  const prev = snapshots.get(worktreePath)
  if (prev && prev.srcMtimeMs === src.mtimeMs && prev.srcSize === src.size) {
    return { GIT_INDEX_FILE: prev.path }
  }

  const dest = prev?.path ?? snapshotPathFor(worktreePath)
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true })
    copyFileSync(realIndex, dest)
  } catch {
    return null
  }
  snapshots.set(worktreePath, { path: dest, srcMtimeMs: src.mtimeMs, srcSize: src.size })
  return { GIT_INDEX_FILE: dest }
}

/** Drop a worktree's snapshot bookkeeping (worktree removed). */
export function forgetIndexSnapshot(worktreePath: string): void {
  snapshots.delete(worktreePath)
}
