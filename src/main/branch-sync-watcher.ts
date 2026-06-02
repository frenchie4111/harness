// Event-driven branch-name sync for every worktree.
//
// The stored branch label is a live `git worktree list --porcelain` read,
// re-derived only when something calls refreshList (create/delete/manual
// refresh/boot). Nothing re-reads it when the branch changes underneath us
// from inside a terminal — `git checkout`/`switch`, `git branch -m`,
// `gh pr checkout`, or a rebase/bisect/cherry-pick starting and finishing.
// The classic symptom is a "rebasing 2/22" label that sticks forever
// because the rebase ended with no trigger to clear it.
//
// This watcher closes that gap by watching each worktree's real gitdir and
// calling back to refreshList the instant HEAD (or an in-progress-op marker)
// changes. HEAD is the right signal: a normal commit on a branch leaves
// HEAD untouched (the ref moves, not HEAD), while every branch switch and
// every rebase/bisect step rewrites HEAD — so we update exactly when the
// branch/position label would actually change, and stay quiet otherwise.
//
// Why the gitdir, not <worktree>/.git: a linked worktree's `.git` is a
// gitlink FILE pointing at <main>/.git/worktrees/<name>/, and that's where
// HEAD and rebase-merge/ actually live. We resolve the real gitdir per
// worktree and watch it non-recursively (cross-platform — no recursive
// fs.watch needed since the files we filter on sit directly in the gitdir).

import fs, { type FSWatcher } from 'fs'
import { isAbsolute, join } from 'path'
import { log } from './debug'

const DEBOUNCE_MS = 250

// Top-level entries inside a gitdir whose change means HEAD/branch/op state
// moved. HEAD covers branch switch + every rebase/bisect step; the op
// markers make the label appear/clear promptly at the edges.
const RELEVANT = new Set([
  'HEAD',
  'rebase-merge',
  'rebase-apply',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG'
])

interface Entry {
  watcher: FSWatcher | null
  debounce: NodeJS.Timeout | null
}

export class BranchSyncWatcher {
  private readonly entries = new Map<string, Entry>() // key: worktree path
  private readonly onChange: () => void

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  /** Reconcile the watch set against the current worktree paths: open a
   * watcher for each new worktree, close watchers for worktrees that went
   * away. Cheap and idempotent — safe to call on every worktrees/listChanged.
   * Sweeps the whole list, but only on that (infrequent) event. */
  sync(worktrees: { path: string }[]): void {
    const wanted = new Set(worktrees.map((w) => w.path))
    for (const path of [...this.entries.keys()]) {
      if (!wanted.has(path)) this.close(path)
    }
    for (const w of worktrees) {
      if (!this.entries.has(w.path)) this.open(w.path)
    }
  }

  shutdown(): void {
    for (const path of [...this.entries.keys()]) this.close(path)
  }

  /** Resolve a worktree's real gitdir. Main worktree: <path>/.git is a
   * directory. Linked worktree: <path>/.git is a `gitdir: <abs>` pointer
   * file. Returns null if neither resolves (caller records a no-op entry so
   * we don't re-probe every sync; the PR-poller re-derive stays the net). */
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

  private open(worktreePath: string): void {
    const entry: Entry = { watcher: null, debounce: null }
    this.entries.set(worktreePath, entry)
    const gitdir = BranchSyncWatcher.resolveGitdir(worktreePath)
    if (!gitdir) return
    try {
      entry.watcher = fs.watch(gitdir, { persistent: false }, (_evt, filename) => {
        const name = typeof filename === 'string' ? filename : null
        // Some platforms omit the filename — fall back to refreshing rather
        // than missing a real HEAD change.
        if (name && !RELEVANT.has(name)) return
        this.schedule(worktreePath)
      })
    } catch (err) {
      log('branch-watcher', `fs.watch failed for ${gitdir}`, err instanceof Error ? err.message : err)
    }
  }

  private schedule(worktreePath: string): void {
    const entry = this.entries.get(worktreePath)
    if (!entry || entry.debounce) return
    entry.debounce = setTimeout(() => {
      const cur = this.entries.get(worktreePath)
      if (cur) cur.debounce = null
      try {
        this.onChange()
      } catch {
        // A failing listener must not wedge the watcher.
      }
    }, DEBOUNCE_MS)
  }

  private close(worktreePath: string): void {
    const entry = this.entries.get(worktreePath)
    if (!entry) return
    if (entry.debounce) clearTimeout(entry.debounce)
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // already closed
      }
    }
    this.entries.delete(worktreePath)
  }
}
