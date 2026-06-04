// Reference-counted fs.watch manager for a worktree's gitdir. One watch handle
// per worktree feeds two consumers:
//
//   1. Changed-files invalidation — ref-counted subscribe()/unsubscribe(), one
//      per client viewing the Changed Files panel. Fires when index/HEAD/
//      MERGE_HEAD move (stage, commit, branch switch, merge) so the panel
//      refreshes on real events instead of waiting for the 60s fallback poll.
//   2. Branch-label sync — a single always-on callback driven by sync(list).
//      Fires when HEAD or an in-progress-op marker (rebase/bisect/cherry-pick/
//      revert/merge) moves, so a "rebasing 2/22" label appears the instant the
//      op starts and clears the instant it ends — instead of sticking until the
//      next create/delete/manual refresh (the bug this watcher's branch half
//      was added to fix).
//
// Why resolve the real gitdir instead of watching <path>/.git directly: a
// linked worktree's <path>/.git is a gitlink FILE pointing at
// <main>/.git/worktrees/<name>/, and that's where index, HEAD and rebase-merge/
// actually live. Watching <path>/.git (as this did before the merge) silently
// never fired for linked worktrees — which is most of Harness's worktrees — so
// both consumers were quietly leaning on the slow fallback poll. We resolve the
// gitlink once per worktree and watch the real gitdir non-recursively
// (cross-platform: every file we filter on sits directly in the gitdir, so no
// recursive fs.watch is needed).

import fs, { type FSWatcher } from 'fs'
import { isAbsolute, join } from 'path'
import { log } from './debug'

// Changed-files consumers care about staging/commit/merge state.
const CHANGED_FILES_RELEVANT = new Set(['index', 'HEAD', 'MERGE_HEAD'])

// Branch-label consumers care about HEAD + in-progress-op markers. HEAD covers
// branch switch + every rebase/bisect step (a plain commit moves the ref, not
// HEAD); the op markers make the label appear/clear promptly at the edges.
const BRANCH_RELEVANT = new Set([
  'HEAD',
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG'
])

const CHANGED_FILES_DEBOUNCE_MS = 200
const BRANCH_DEBOUNCE_MS = 250

export type WorktreeChangeListener = () => void

interface Entry {
  watcher: FSWatcher | null
  // Ref-counted changed-files subscribers (per client).
  fileListeners: Set<WorktreeChangeListener>
  fileDebounce: NodeJS.Timeout | null
  // Whether sync() currently wants this worktree watched for branch changes.
  branchWatched: boolean
  branchDebounce: NodeJS.Timeout | null
}

export class WorktreeWatcher {
  private readonly entries = new Map<string, Entry>() // key: worktree path
  private readonly onBranchChange: (() => void) | null

  /** @param onBranchChange invoked (debounced) whenever a branch-relevant file
   * moves in a worktree currently in the sync() set. Omit it for a
   * changed-files-only watcher. */
  constructor(onBranchChange?: () => void) {
    this.onBranchChange = onBranchChange ?? null
  }

  /** Changed-files subscription. Ref-counted: the first interested party on a
   * path opens the watch handle (if branch-sync hasn't already), the last to
   * leave releases its share. Returns an unsubscribe fn. */
  subscribe(worktreePath: string, listener: WorktreeChangeListener): () => void {
    const entry = this.ensure(worktreePath)
    entry.fileListeners.add(listener)
    return () => this.removeFileListener(worktreePath, listener)
  }

  /** Reconcile the always-on branch-sync watch set against the current worktree
   * paths: open a handle for each worktree, drop the branch share for ones that
   * went away (a handle still held by a changed-files subscriber stays open).
   * Cheap, idempotent, never dispatches — safe on every worktrees/listChanged. */
  sync(worktrees: { path: string }[]): void {
    const wanted = new Set(worktrees.map((w) => w.path))
    for (const path of [...this.entries.keys()]) {
      const entry = this.entries.get(path)!
      if (entry.branchWatched && !wanted.has(path)) {
        entry.branchWatched = false
        this.releaseIfIdle(path)
      }
    }
    for (const w of worktrees) {
      this.ensure(w.path).branchWatched = true
    }
  }

  shutdown(): void {
    for (const path of [...this.entries.keys()]) this.teardown(path)
  }

  /** Resolve a worktree's real gitdir. Main worktree: <path>/.git is a
   * directory. Linked worktree: <path>/.git is a `gitdir: <path>` pointer file.
   * Returns null if neither resolves (caller records a no-op entry so we don't
   * re-probe; the PR-poller re-derive + fallback poll stay the net). */
  static resolveGitdir(worktreePath: string): string | null {
    const dotgit = join(worktreePath, '.git')
    let isDir = false
    try {
      isDir = fs.statSync(dotgit).isDirectory()
    } catch {
      return null
    }
    if (isDir) return dotgit
    try {
      const content = fs.readFileSync(dotgit, 'utf8').trim()
      const m = content.match(/^gitdir:\s*(.+)$/)
      if (!m) return null
      let gd = m[1].trim()
      if (!isAbsolute(gd)) gd = join(worktreePath, gd)
      return fs.existsSync(gd) ? gd : null
    } catch {
      return null
    }
  }

  private ensure(worktreePath: string): Entry {
    let entry = this.entries.get(worktreePath)
    if (!entry) {
      entry = {
        watcher: null,
        fileListeners: new Set(),
        fileDebounce: null,
        branchWatched: false,
        branchDebounce: null
      }
      this.entries.set(worktreePath, entry)
      this.openWatcher(worktreePath, entry)
    }
    return entry
  }

  private openWatcher(worktreePath: string, entry: Entry): void {
    const gitdir = WorktreeWatcher.resolveGitdir(worktreePath)
    if (!gitdir) return
    try {
      entry.watcher = fs.watch(gitdir, { persistent: false }, (_evt, filename) => {
        this.onFsEvent(worktreePath, typeof filename === 'string' ? filename : null)
      })
    } catch (err) {
      // .git/ missing or unreadable — leave the entry watcher-less; both
      // consumers still converge via the fallback poll / PR-poller re-derive.
      log('worktree-watcher', `fs.watch failed for ${gitdir}`, err instanceof Error ? err.message : err)
    }
  }

  private onFsEvent(worktreePath: string, name: string | null): void {
    const entry = this.entries.get(worktreePath)
    if (!entry) return
    // Some platforms omit the filename — refresh both rather than miss a change.
    const fileHit = name === null || CHANGED_FILES_RELEVANT.has(name)
    const branchHit = name === null || BRANCH_RELEVANT.has(name)
    if (fileHit && entry.fileListeners.size > 0) this.scheduleFiles(worktreePath)
    if (branchHit && entry.branchWatched && this.onBranchChange) this.scheduleBranch(worktreePath)
  }

  private scheduleFiles(worktreePath: string): void {
    const entry = this.entries.get(worktreePath)
    if (!entry || entry.fileDebounce) return
    entry.fileDebounce = setTimeout(() => {
      const cur = this.entries.get(worktreePath)
      if (!cur) return
      cur.fileDebounce = null
      for (const listener of cur.fileListeners) {
        try {
          listener()
        } catch {
          // A failing listener must not break its siblings.
        }
      }
    }, CHANGED_FILES_DEBOUNCE_MS)
  }

  private scheduleBranch(worktreePath: string): void {
    const entry = this.entries.get(worktreePath)
    if (!entry || entry.branchDebounce) return
    entry.branchDebounce = setTimeout(() => {
      const cur = this.entries.get(worktreePath)
      if (cur) cur.branchDebounce = null
      try {
        this.onBranchChange?.()
      } catch {
        // A failing listener must not wedge the watcher.
      }
    }, BRANCH_DEBOUNCE_MS)
  }

  private removeFileListener(worktreePath: string, listener: WorktreeChangeListener): void {
    const entry = this.entries.get(worktreePath)
    if (!entry) return
    entry.fileListeners.delete(listener)
    this.releaseIfIdle(worktreePath)
  }

  /** Tear the entry down once nothing wants it: no changed-files subscribers
   * and not in the branch-sync set. */
  private releaseIfIdle(worktreePath: string): void {
    const entry = this.entries.get(worktreePath)
    if (!entry) return
    if (entry.fileListeners.size > 0 || entry.branchWatched) return
    this.teardown(worktreePath)
  }

  private teardown(worktreePath: string): void {
    const entry = this.entries.get(worktreePath)
    if (!entry) return
    if (entry.fileDebounce) clearTimeout(entry.fileDebounce)
    if (entry.branchDebounce) clearTimeout(entry.branchDebounce)
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // already closed, ignore
      }
    }
    this.entries.delete(worktreePath)
  }
}
