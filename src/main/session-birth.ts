// Pure decision logic for how a newly-created or re-spawned agent surface
// (a json-claude chat tab OR an xterm agent tab) attaches to an agent
// session. Two questions live here:
//
//   * resolveTabBirth — what should a BRAND-NEW tab do, given what's already
//     open in the worktree? (fork / resume-last / blank)
//   * deriveSpawnSpec — how should an ALREADY-EXISTING tab re-attach when its
//     subprocess is (re)spawned on mount or wake?
//
// Grouping is by AGENT KIND, not tab surface: a json-claude chat tab and an
// xterm Claude tab share the same `~/.claude/projects` session store, so they
// fork from / resume each other; Codex tabs form their own group. The on-disk
// facts (does a transcript exist, what sessions exist) are injected per kind
// via SessionBirthDeps so this module stays free of store/disk/manager
// coupling and is unit-testable.
//
// The invariant these encode: the tab id is the stable slice/instance key,
// while the agent session id (the on-disk transcript basename) may differ — a
// resumed tab carries the resumed id, a fork's id is minted by the agent and
// discovered later. See SessionSpawnSpec for the three shapes.

import type { AgentKind, PaneNode, TerminalTab } from '../shared/state/terminals'
import { getLeaves } from '../shared/state/terminals'

/** How an agent subprocess should attach to a session. The slice/instance/tab
 *  id is always the stable key; this controls only which agent session the
 *  subprocess reads/writes:
 *   - blank:  fresh session (Claude pins --session-id; Codex self-assigns).
 *   - resume: re-attach an existing on-disk session.
 *   - fork:   branch an existing session into a brand-new one. The agent
 *             mints the new id; we discover it from the first init/hook event
 *             and bind it to the tab. */
export type SessionSpawnSpec =
  | { kind: 'blank' }
  | { kind: 'resume'; resumeSessionId: string }
  | { kind: 'fork'; srcSessionId: string }

export interface SessionBirthDeps {
  /** True when an on-disk transcript exists for this agent session id. */
  hasTranscript: (sessionId: string, worktreePath: string) => boolean
  /** On-disk sessions for this worktree, newest first by mtime. */
  listSessions: (
    worktreePath: string
  ) => Array<{ sessionId: string; mtimeMs: number }>
}

/** The agent kind a tab represents for fork/resume grouping, or null for
 *  non-agent tabs (shell/diff/file/browser/review). A json-claude chat tab is
 *  Claude; an agent tab is its agentKind (defaulting to Claude). */
export function agentKindOfTab(tab: TerminalTab): AgentKind | null {
  if (tab.type === 'json-claude') return 'claude'
  if (tab.type === 'agent') return tab.agentKind ?? 'claude'
  return null
}

/** Flatten a worktree's pane tree to its tabs (in pane/tab order). */
export function flattenTabs(tree: PaneNode | undefined): TerminalTab[] {
  if (!tree) return []
  const tabs: TerminalTab[] = []
  for (const leaf of getLeaves(tree)) tabs.push(...leaf.tabs)
  return tabs
}

/** Resolve how an existing tab should re-attach to a session. Keys off the
 *  tab's persisted `sessionId`: a resumed/forked tab carries a session id that
 *  differs from the tab id, so we --resume it; a tab whose id equals its
 *  session id --resumes its own id when a transcript exists (continue after
 *  reload), else starts fresh. */
export function deriveSpawnSpec(
  tabId: string,
  tree: PaneNode | undefined,
  worktreePath: string,
  deps: SessionBirthDeps
): SessionSpawnSpec {
  const tab = flattenTabs(tree).find((t) => t.id === tabId)
  const sid = tab?.sessionId
  if (sid && sid !== tabId && deps.hasTranscript(sid, worktreePath)) {
    return { kind: 'resume', resumeSessionId: sid }
  }
  if (deps.hasTranscript(tabId, worktreePath)) {
    return { kind: 'resume', resumeSessionId: tabId }
  }
  return { kind: 'blank' }
}

/** Pick the session id to fork from among same-kind tabs: prefer the tab
 *  active in the target pane, else any same-kind tab, taking the first whose
 *  transcript actually exists on disk. Returns undefined when no open
 *  same-kind tab has a forkable transcript yet (e.g. a zero-turn session). */
export function pickForkSource(
  tree: PaneNode | undefined,
  sameKindTabs: TerminalTab[],
  worktreePath: string,
  deps: SessionBirthDeps,
  paneId?: string
): string | undefined {
  const candidates: string[] = []
  if (tree) {
    const leaves = getLeaves(tree)
    const target = paneId ? leaves.find((l) => l.id === paneId) : undefined
    const active = target
      ? sameKindTabs.find((t) => t.id === target.activeTabId)
      : undefined
    if (active) candidates.push(active.sessionId ?? active.id)
  }
  for (const t of sameKindTabs) candidates.push(t.sessionId ?? t.id)
  for (const id of candidates) {
    if (deps.hasTranscript(id, worktreePath)) return id
  }
  return undefined
}

/** Newest on-disk session for this worktree that isn't already open in a tab
 *  (so resume doesn't collide with a live session). */
export function newestResumableSession(
  worktreePath: string,
  openTabs: TerminalTab[],
  deps: SessionBirthDeps
): string | undefined {
  const openIds = new Set<string>()
  for (const t of openTabs) {
    openIds.add(t.id)
    if (t.sessionId) openIds.add(t.sessionId)
  }
  for (const { sessionId } of deps.listSessions(worktreePath)) {
    if (!openIds.has(sessionId)) return sessionId
  }
  return undefined
}

/** Decide what a NEW tab of `targetKind` should do when created in a worktree,
 *  driven entirely by what's already open there:
 *    1. A same-kind agent tab already exists → fork from the active one (tip).
 *    2. No agent tabs of ANY kind            → resume the worktree's last known
 *                                              session (excluding open ones).
 *    3. Otherwise                            → blank.
 *  "Always fork, never blank" once a same-kind tab exists; a forkable source
 *  needs an on-disk transcript (a zero-turn session has nothing to fork). */
export function resolveTabBirth(
  tree: PaneNode | undefined,
  worktreePath: string,
  targetKind: AgentKind,
  deps: SessionBirthDeps,
  paneId?: string
): SessionSpawnSpec {
  const tabs = flattenTabs(tree)
  const sameKind = tabs.filter((t) => agentKindOfTab(t) === targetKind)

  if (sameKind.length > 0) {
    const src = pickForkSource(tree, sameKind, worktreePath, deps, paneId)
    if (src) return { kind: 'fork', srcSessionId: src }
    return { kind: 'blank' }
  }

  const hasAnyAgentTab = tabs.some((t) => agentKindOfTab(t) !== null)
  if (!hasAnyAgentTab) {
    const resumeId = newestResumableSession(worktreePath, tabs, deps)
    if (resumeId) return { kind: 'resume', resumeSessionId: resumeId }
  }
  return { kind: 'blank' }
}
