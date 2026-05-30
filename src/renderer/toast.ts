import { useSyncExternalStore } from 'react'

/** A transient notification. `icon` is an opaque key the <Toasts> component
 *  maps to a glyph (currently the prevent-sleep set); omit it for a text-only
 *  toast. `key` dedups: a new toast with the same key replaces the live one
 *  in place rather than stacking (e.g. rapid hotkey cycling). */
export interface ToastItem {
  id: number
  message: string
  icon?: string
  key?: string
}

const TOAST_MS = 2400

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit(): void {
  for (const cb of listeners) cb()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot(): ToastItem[] {
  return items
}

export function showToast(message: string, icon?: string, key?: string): void {
  // Dedup by key: drop any live toast sharing this key (and its timer) so the
  // new one replaces it in place instead of stacking.
  if (key !== undefined) {
    for (const t of items) {
      if (t.key === key) {
        const timer = timers.get(t.id)
        if (timer) {
          clearTimeout(timer)
          timers.delete(t.id)
        }
      }
    }
    items = items.filter((t) => t.key !== key)
  }
  const id = nextId++
  items = [...items, { id, message, icon, key }]
  emit()
  timers.set(id, setTimeout(() => dismissToast(id), TOAST_MS))
}

export function dismissToast(id: number): void {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
  const next = items.filter((i) => i.id !== id)
  if (next.length === items.length) return
  items = next
  emit()
}

/** Renderer-only transient toasts. Lives outside the store on purpose —
 *  these are per-client, ephemeral, and never need to survive reload (same
 *  rationale as worktree-detail-override.ts). */
export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
