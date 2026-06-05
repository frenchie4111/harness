// Cross-component "jump the review tab to this file" request channel.
// The Changed Files panel (committed rows) opens the worktree's Review tab
// and asks it to select a specific file; this side channel carries that
// request from the panel into the ReviewPane's own React tree.
//
// Mirrors review-progress.ts — a side channel for state that lives inside
// ReviewPane, keyed by worktree path. A monotonic nonce makes re-requesting
// the same file re-fire, so clicking an already-open file re-selects it.
import { useSyncExternalStore } from 'react'

export interface ReviewFileRequest {
  filePath: string
  nonce: number
}

const requestByWorktree = new Map<string, ReviewFileRequest>()
const listeners = new Set<() => void>()
let counter = 0

function emit(): void {
  for (const l of listeners) l()
}

export function requestReviewFile(worktreePath: string, filePath: string): void {
  requestByWorktree.set(worktreePath, { filePath, nonce: ++counter })
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function getSnapshot(worktreePath: string): ReviewFileRequest | undefined {
  return requestByWorktree.get(worktreePath)
}

export function useReviewFileRequest(worktreePath: string): ReviewFileRequest | undefined {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot(worktreePath),
    () => undefined
  )
}
