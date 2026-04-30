// Reference-counted fs.watch manager for worktree change notifications.
// Watches the worktree's .git/ directory for index/HEAD/MERGE_HEAD changes
// (covers stage, commit, branch switch, merge), debounces, and notifies
// every subscriber. Working-tree edits that don't touch .git/ are covered
// by a slow renderer-side fallback poll.

import fs, { type FSWatcher } from 'fs'
import { join } from 'path'

const DEBOUNCE_MS = 200

const RELEVANT_FILES = new Set(['index', 'HEAD', 'MERGE_HEAD'])

export type WorktreeChangeListener = () => void

interface Entry {
  listeners: Set<WorktreeChangeListener>
  watchers: FSWatcher[]
  debounceTimer: NodeJS.Timeout | null
}

export class WorktreeWatcher {
  private readonly entries = new Map<string, Entry>()

  subscribe(worktreePath: string, listener: WorktreeChangeListener): () => void {
    let entry = this.entries.get(worktreePath)
    if (!entry) {
      entry = {
        listeners: new Set(),
        watchers: this.openWatchers(worktreePath),
        debounceTimer: null
      }
      this.entries.set(worktreePath, entry)
    }
    entry.listeners.add(listener)
    return () => this.unsubscribe(worktreePath, listener)
  }

  shutdown(): void {
    for (const [path, entry] of this.entries) {
      this.teardownEntry(entry)
      this.entries.delete(path)
    }
  }

  private unsubscribe(worktreePath: string, listener: WorktreeChangeListener): void {
    const entry = this.entries.get(worktreePath)
    if (!entry) return
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0) {
      this.teardownEntry(entry)
      this.entries.delete(worktreePath)
    }
  }

  private teardownEntry(entry: Entry): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    for (const w of entry.watchers) {
      try {
        w.close()
      } catch {
        // already closed, ignore
      }
    }
    entry.watchers = []
  }

  private openWatchers(worktreePath: string): FSWatcher[] {
    const gitDir = join(worktreePath, '.git')
    const watchers: FSWatcher[] = []
    const onEvent = (_eventType: string, filename: string | Buffer | null): void => {
      const name = typeof filename === 'string' ? filename : filename?.toString()
      if (!name) return
      if (!RELEVANT_FILES.has(name)) return
      this.scheduleNotify(worktreePath)
    }
    try {
      watchers.push(fs.watch(gitDir, { persistent: false }, onEvent))
    } catch {
      // .git/ missing or unreadable — leave the entry without watchers;
      // subscribers still get notified by the renderer fallback poll.
    }
    return watchers
  }

  private scheduleNotify(worktreePath: string): void {
    const entry = this.entries.get(worktreePath)
    if (!entry) return
    if (entry.debounceTimer) return
    entry.debounceTimer = setTimeout(() => {
      const current = this.entries.get(worktreePath)
      if (!current) return
      current.debounceTimer = null
      for (const listener of current.listeners) {
        try {
          listener()
        } catch {
          // listener errors must not break sibling listeners
        }
      }
    }, DEBOUNCE_MS)
  }
}
