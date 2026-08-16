import type { AppState } from '../shared/state'
import { getLeaves } from '../shared/state/terminals'

export interface ChatDeliveryDeps {
  /** Injects a user turn into a running json-mode chat session. */
  send: (sessionId: string, text: string) => void
  /** True when the session has a live subprocess to receive the message. */
  hasSession: (sessionId: string) => boolean
  /** Re-spawns a slept json-claude tab's subprocess. Synchronous — the
   *  session is live by the time this returns (or the spawn failed). */
  wake: (worktreePath: string, tabId: string) => void
}

export type ChatDeliveryResult =
  | { ok: true; sessionId: string; woke: boolean }
  | { ok: false; reason: 'no-chat-tab' | 'wake-failed' }

/** Most recently active session for this worktree that still has a live
 *  subprocess. */
function pickLiveSession(
  state: AppState,
  deps: ChatDeliveryDeps,
  worktreePath: string
): string | null {
  let best: string | null = null
  let bestTs = -1
  for (const [sessionId, session] of Object.entries(state.jsonClaude.sessions)) {
    if (session.worktreePath !== worktreePath) continue
    if (!deps.hasSession(sessionId)) continue
    const last = session.entries[session.entries.length - 1]
    const ts = last?.timestamp ?? 0
    if (ts > bestTs || (ts === bestTs && (best === null || sessionId < best))) {
      best = sessionId
      bestTs = ts
    }
  }
  return best
}

/** A slept json-claude tab to wake, preferring whichever tab its pane
 *  had focused. Only genuinely-asleep tabs qualify: a tab marked awake
 *  with a dead subprocess is the renderer's to respawn on focus, and
 *  racing it here would double-spawn. */
function pickSleptTab(state: AppState, worktreePath: string): string | null {
  const tree = state.terminals.panes[worktreePath]
  if (!tree) return null
  let fallback: string | null = null
  for (const leaf of getLeaves(tree)) {
    for (const tab of leaf.tabs) {
      if (tab.type !== 'json-claude') continue
      if ((tab.mode ?? 'awake') !== 'asleep') continue
      if (tab.id === leaf.activeTabId) return tab.id
      fallback ??= tab.id
    }
  }
  return fallback
}

const WORKTREE_HANDLE_PREFIX = 'worktree:'

/** Resolve a caller-supplied worktree handle. Absolute path wins outright;
 *  otherwise alias and branch are matched case-insensitively. An ambiguous
 *  handle is an error rather than a guess — silently picking one of two
 *  worktrees would deliver a message somewhere the sender didn't intend. */
export function resolveWorktreeQuery(
  state: AppState,
  query: string
): { path: string } | { error: string } {
  // The chat composer's @-mention inserts `@worktree:<branch>`, and agents
  // routinely pass that token through verbatim. Strip the prefix so it
  // resolves instead of 404ing on a handle we handed them ourselves.
  let q = query.trim()
  if (q.toLowerCase().startsWith(WORKTREE_HANDLE_PREFIX)) {
    q = q.slice(WORKTREE_HANDLE_PREFIX.length).trim()
  }
  if (!q) return { error: 'worktree required' }
  // A prunable worktree's directory is already gone, so nothing can be
  // running in it to receive the message.
  const list = state.worktrees.list.filter((w) => !w.prunable)
  if (list.some((w) => w.path === q)) return { path: q }
  const lower = q.toLowerCase()
  const matches = new Set<string>()
  for (const w of list) {
    const alias = state.aliases.byPath[w.path]
    if (alias?.toLowerCase() === lower || w.branch.toLowerCase() === lower) {
      matches.add(w.path)
    }
  }
  if (matches.size === 1) return { path: [...matches][0] }
  if (matches.size > 1) {
    return {
      error: `"${q}" matches ${matches.size} worktrees — pass the absolute path instead`
    }
  }
  return { error: `no worktree matching "${q}"` }
}

/** Human label for a worktree: alias when the user set one, else its branch. */
export function describeWorktree(state: AppState, worktreePath: string): string {
  const alias = state.aliases.byPath[worktreePath]
  if (alias) return alias
  const wt = state.worktrees.list.find((w) => w.path === worktreePath)
  return wt?.branch || worktreePath
}

/** Route a message to a worktree's agent chat, waking a slept tab if that's
 *  what it takes. Every persisted json-claude tab hydrates as 'asleep' at
 *  app launch and the auto-sleep monitor puts idle ones back to sleep, so
 *  "no live session" is the *normal* state for the worktrees these callers
 *  care about — refusing to wake would make them fire almost never.
 *
 *  Waking spawns a subprocess and replays a transcript from disk, so this
 *  is far too much work to run inside a store listener. Callers reached
 *  from a store subscription must hop off the fan-out first. */
export function deliverToWorktreeChat(
  state: AppState,
  deps: ChatDeliveryDeps,
  worktreePath: string,
  message: string
): ChatDeliveryResult {
  const live = pickLiveSession(state, deps, worktreePath)
  if (live) {
    deps.send(live, message)
    return { ok: true, sessionId: live, woke: false }
  }
  const slept = pickSleptTab(state, worktreePath)
  // No chat tab at all — a terminal-only worktree.
  if (!slept) return { ok: false, reason: 'no-chat-tab' }
  deps.wake(worktreePath, slept)
  if (!deps.hasSession(slept)) return { ok: false, reason: 'wake-failed' }
  deps.send(slept, message)
  return { ok: true, sessionId: slept, woke: true }
}
