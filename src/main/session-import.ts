import type { TerminalTab } from '../shared/state/terminals'
import type { SessionImportEvent } from '../shared/state/session-import'
import type { ImportOutcome } from '../shared/session-import-types'

export type { ImportOutcome } from '../shared/session-import-types'
import { log } from './debug'
import { forkTranscript } from './json-claude-manager'
import { scanSessions, type DiscoveredSession } from './session-scanner'
import { buildSessionTree, type SessionGroupNode } from './session-tree'

/** Owns discovery and import of Claude Code sessions the user ran outside
 *  Ness.
 *
 *  The scan results are held here rather than in a slice: they are a
 *  multi-megabyte, re-derivable list that exactly one modal reads. Only the
 *  scan's status is dispatched (see shared/state/session-import.ts); the tree
 *  is handed over a request IPC when the browser opens. */

export interface SessionImportDeps {
  dispatch: (event: SessionImportEvent) => void
  getRepoRoots: () => string[]
  addTab: (worktreePath: string, tab: TerminalTab) => void
  startSession: (sessionId: string, worktreePath: string) => void
  homeDir: () => string
  now?: () => number
}

export class SessionImportManager {
  private sessions: DiscoveredSession[] = []
  private scanning = false

  constructor(private readonly deps: SessionImportDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Whether a scan is already running. A second caller is a no-op rather
   *  than a second concurrent walk of the same tree. */
  isScanning(): boolean {
    return this.scanning
  }

  async scan(): Promise<{ sessionCount: number; groupCount: number }> {
    if (this.scanning) {
      return { sessionCount: this.sessions.length, groupCount: this.getTree().length }
    }
    this.scanning = true
    this.deps.dispatch({ type: 'sessionImport/scanStarted' })
    try {
      // The scanner reports per file, which on a real corpus is 8000+ calls.
      // Dispatching each one would push that many events through the reducer
      // and out over IPC to every client -- the exact high-frequency-stream
      // anti-pattern the store is not for. A progress bar can't render more
      // than a few updates a second anyway, so coalesce to whole percent
      // changes and always let the final file through so the bar lands full.
      let lastPercent = -1
      const result = await scanSessions({
        onProgress: (scanned, total) => {
          const percent = total > 0 ? Math.floor((scanned / total) * 100) : 0
          if (percent === lastPercent && scanned !== total) return
          lastPercent = percent
          this.deps.dispatch({
            type: 'sessionImport/scanProgress',
            payload: { scanned, total }
          })
        }
      })
      this.sessions = result.sessions
      const groupCount = this.getTree().length
      this.deps.dispatch({
        type: 'sessionImport/scanCompleted',
        payload: { sessionCount: result.sessions.length, groupCount, at: this.now() }
      })
      log(
        'session-import',
        `scan complete sessions=${result.sessions.length} groups=${groupCount} ` +
          `elapsed=${result.elapsedMs}ms cacheHits=${result.cacheHits}`
      )
      return { sessionCount: result.sessions.length, groupCount }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.deps.dispatch({ type: 'sessionImport/scanFailed', payload: reason })
      log('session-import', 'scan failed', reason)
      return { sessionCount: 0, groupCount: 0 }
    } finally {
      this.scanning = false
    }
  }

  getTree(): SessionGroupNode[] {
    return buildSessionTree(this.sessions, this.deps.getRepoRoots(), this.deps.homeDir())
  }

  findSession(sessionId: string): DiscoveredSession | null {
    return this.sessions.find((s) => s.sessionId === sessionId) ?? null
  }

  /** Attach a discovered session to a worktree as a chat tab.
   *
   *  When the session already ran in the target worktree the transcript is
   *  adopted in place — the CLI's `--resume` keys off the file existing in
   *  that worktree's encoded project dir, which it already does, so no copy
   *  is needed and the user keeps one continuous history.
   *
   *  Otherwise the transcript is forked into the target's project dir under
   *  a fresh session id. forkTranscript handles the per-line sessionId
   *  rewrite; the resumed agent learns it moved via the relocation preamble
   *  that the fork path already injects. The source transcript is untouched
   *  either way, so importing never mutates the user's existing history. */
  importSession(sessionId: string, targetWorktreePath: string): ImportOutcome {
    const session = this.findSession(sessionId)
    if (!session) return { ok: false, reason: 'session not found' }
    if (!session.cwd) return { ok: false, reason: 'session has no recorded working directory' }

    const adopt = session.cwd === targetWorktreePath
    let attachedId = sessionId

    if (!adopt) {
      const forked = forkTranscript({
        sourceSessionId: sessionId,
        sourceWorktreePath: session.cwd,
        destWorktreePath: targetWorktreePath
      })
      if (!forked.ok || !forked.newSessionId) {
        return { ok: false, reason: forked.reason ?? 'fork failed' }
      }
      attachedId = forked.newSessionId
    }

    const tab: TerminalTab = {
      id: attachedId,
      type: 'json-claude',
      label: session.title ? session.title.slice(0, 40) : 'Imported chat',
      sessionId: attachedId,
      mode: 'awake'
    }
    this.deps.addTab(targetWorktreePath, tab)
    this.deps.startSession(attachedId, targetWorktreePath)

    log(
      'session-import',
      `imported ${sessionId} -> ${attachedId} mode=${adopt ? 'adopt' : 'fork'} ` +
        `target=${targetWorktreePath}`
    )
    return { ok: true, sessionId: attachedId, mode: adopt ? 'adopt' : 'fork' }
  }
}
