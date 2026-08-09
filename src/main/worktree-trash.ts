// Trash-and-background-unlink support for worktree deletion.
//
// APFS `mv` within the same volume is O(1) — the file entry is relinked
// at the parent directory level and the actual data blocks aren't
// touched. That means we can make a worktree deletion FEEL instant by
// renaming the directory into a hidden trash location, doing the git
// bookkeeping cheaply (`git worktree prune`), and unlinking the moved
// tree on our own time. A user deleting 30 worktrees each with a
// 100k-file node_modules used to eat ~30 minutes of foreground time;
// with this path the foreground work is a single rename per worktree
// and the unlink cost is amortized in the background.
//
// The trash root lives under `userData` (same volume as the app's other
// state on the common case), NOT `/tmp` — putting it under userData
// keeps everything on one disk and lets a boot-time sweep clean up any
// orphans left by a mid-delete crash.

import { promises as fsp, statSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { userDataDir } from './paths'
import { log } from './debug'

const TRASH_DIRNAME = 'worktree-trash'

let trashDirEnsured = false

/** Absolute path of the trash root. Same volume as `userDataDir()` in
 *  the common case (internal SSD), which is what makes the rename O(1). */
export function worktreeTrashDir(): string {
  return join(userDataDir(), TRASH_DIRNAME)
}

/** mkdir the trash root once per process. Cached because the check runs
 *  on every deletion and the syscall isn't free at bulk-delete rates. */
function ensureTrashDir(): string {
  const dir = worktreeTrashDir()
  if (!trashDirEnsured) {
    mkdirSync(dir, { recursive: true })
    trashDirEnsured = true
  }
  return dir
}

/** True if `a` and `b` live on the same volume (i.e. an `fs.rename`
 *  between them is O(1) metadata). Any stat failure (e.g. the trash
 *  root doesn't exist yet, or the worktree path is already gone) is
 *  treated as "not same-volume" so the caller falls back to the slow
 *  path rather than crashing. */
export function isSameVolume(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev
  } catch {
    return false
  }
}

/** Rename the worktree directory into the trash under a fresh UUID and
 *  return the new path. Concurrency-safe: the UUID prevents rename
 *  collisions even under bulk-delete. */
export async function moveWorktreeToTrash(worktreePath: string): Promise<string> {
  const dir = ensureTrashDir()
  const trashPath = join(dir, randomUUID())
  await fsp.rename(worktreePath, trashPath)
  return trashPath
}

/** Fire-and-forget: unlink one trashed worktree. Errors are logged
 *  (`log('worktree-trash', ...)`) but never propagated — the user has
 *  already moved on and there's nothing they can do about a background
 *  unlink failure. */
export function scheduleTrashUnlink(trashPath: string): void {
  void fsp.rm(trashPath, { recursive: true, force: true }).catch((err) => {
    log(
      'worktree-trash',
      `background unlink failed for ${trashPath}: ${err instanceof Error ? err.message : String(err)}`
    )
  })
}

/** Boot-time sweep: fire-and-forget rm every entry currently in the
 *  trash. Cleans up orphans left by mid-delete crashes (Cmd+Q while the
 *  background unlink is still running). Doesn't block boot — each entry
 *  is dispatched to the threadpool and drains at its own pace. */
export async function sweepWorktreeTrashOnBoot(): Promise<void> {
  const dir = worktreeTrashDir()
  if (!existsSync(dir)) return
  try {
    const entries = await fsp.readdir(dir)
    for (const entry of entries) {
      scheduleTrashUnlink(join(dir, entry))
    }
  } catch (err) {
    log(
      'worktree-trash',
      `boot sweep readdir failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Test-only: reset the cached "trash dir ensured" flag so successive
 *  tests each get to observe the mkdir path. Production code never
 *  needs this. */
export function resetTrashDirCacheForTests(): void {
  trashDirEnsured = false
}
