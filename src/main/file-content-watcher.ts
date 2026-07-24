// Reference-counted fs.watch manager for per-file content notifications.
// Mirrors WorktreeWatcher's structure but watches a single absolute file
// path per entry instead of the worktree's .git/ directory. Used by the
// file:watchSubscribe IPC so FileView / ReviewDiffPane can refresh when an
// agent in another tab (or any external tool) edits the file on disk.
//
// Atomic-save robustness: many editors (Vim, IntelliJ, some Claude-Code
// edit flows) replace the file's inode on save. fs.watch loses the
// underlying handle on rename; we detect that via the 'rename' event and
// re-arm by re-opening fs.watch after a small delay, retrying once if
// the file is briefly missing. If the file is gone after the retry we
// give up — subscribers stay registered but get no notifications until
// the file reappears via a fresh subscribe.
//
// If the very first fs.watch open fails (file missing, EPERM, etc.), the
// entry is created without a watcher and listeners never fire. This is
// intentional and matches WorktreeWatcher — the watcher is best-effort
// and the renderer has its own ways to refresh as a fallback.
//
// Notifications are debounced ~150ms (slightly tighter than the worktree
// watcher's 200ms) to coalesce editor multi-write saves.

import fs, { type FSWatcher } from 'fs'

const DEBOUNCE_MS = 150
const REARM_DELAY_MS = 50

export type FileContentChangeListener = () => void

interface Entry {
  listeners: Set<FileContentChangeListener>
  watcher: FSWatcher | null
  debounceTimer: NodeJS.Timeout | null
  rearmTimer: NodeJS.Timeout | null
}

export class FileContentWatcher {
  private readonly entries = new Map<string, Entry>()

  subscribe(absolutePath: string, listener: FileContentChangeListener): () => void {
    let entry = this.entries.get(absolutePath)
    if (!entry) {
      entry = {
        listeners: new Set(),
        watcher: null,
        debounceTimer: null,
        rearmTimer: null
      }
      this.entries.set(absolutePath, entry)
      entry.watcher = this.openWatcher(absolutePath)
    }
    entry.listeners.add(listener)
    return () => this.unsubscribe(absolutePath, listener)
  }

  shutdown(): void {
    for (const [path, entry] of this.entries) {
      this.teardownEntry(entry)
      this.entries.delete(path)
    }
  }

  private unsubscribe(absolutePath: string, listener: FileContentChangeListener): void {
    const entry = this.entries.get(absolutePath)
    if (!entry) return
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0) {
      this.teardownEntry(entry)
      this.entries.delete(absolutePath)
    }
  }

  private teardownEntry(entry: Entry): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    if (entry.rearmTimer) {
      clearTimeout(entry.rearmTimer)
      entry.rearmTimer = null
    }
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // already closed, ignore
      }
      entry.watcher = null
    }
  }

  private openWatcher(absolutePath: string): FSWatcher | null {
    const onEvent = (eventType: string): void => {
      this.scheduleNotify(absolutePath)
      if (eventType === 'rename') {
        this.scheduleRearm(absolutePath)
      }
    }
    try {
      return fs.watch(absolutePath, { persistent: false }, onEvent)
    } catch {
      return null
    }
  }

  private scheduleNotify(absolutePath: string): void {
    const entry = this.entries.get(absolutePath)
    if (!entry) return
    if (entry.debounceTimer) return
    entry.debounceTimer = setTimeout(() => {
      const current = this.entries.get(absolutePath)
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

  private scheduleRearm(absolutePath: string): void {
    const entry = this.entries.get(absolutePath)
    if (!entry) return
    if (entry.rearmTimer) return
    entry.rearmTimer = setTimeout(() => {
      const current = this.entries.get(absolutePath)
      if (!current) return
      current.rearmTimer = null
      if (current.watcher) {
        try {
          current.watcher.close()
        } catch {
          // ignore
        }
        current.watcher = null
      }
      current.watcher = this.openWatcher(absolutePath)
    }, REARM_DELAY_MS)
  }
}
