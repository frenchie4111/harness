import { useSyncExternalStore } from 'react'
import type { WorktreeDetail } from './types'

/** Transient per-client override for the worktree-detail UI, driven by the
 *  Cmd+I cycle hotkey. Lives in renderer-only memory (no IPC, no persistence)
 *  so it resets to "use the configured default" on reload — matches how
 *  ephemeral sidebar UI focus / modal visibility live in App.tsx. */
let override: WorktreeDetail | null = null
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): WorktreeDetail | null {
  return override
}

export function useWorktreeDetailOverride(): WorktreeDetail | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

const CYCLE: WorktreeDetail[] = ['diff', 'age', 'pr']

/** Advance the override one step through diff → age → pr → diff. 'none' is
 *  deliberately skipped — cycling shouldn't hide the detail entirely
 *  (the user can pick that explicitly in Settings if they want). If no
 *  override is active yet, the cycle starts from whatever the configured
 *  default is (passed in by the caller — this module deliberately doesn't
 *  reach into the store). */
export function cycleWorktreeDetail(configured: WorktreeDetail): void {
  const current = override ?? configured
  const idx = CYCLE.indexOf(current)
  // If current isn't in the cycle (e.g. configured is 'none'), idx = -1
  // and (idx + 1) % len = 0 — lands on the first cycle entry, which is
  // the correct "start cycling from the beginning" behavior.
  const next = CYCLE[(idx + 1) % CYCLE.length]
  override = next
  for (const cb of listeners) cb()
}
