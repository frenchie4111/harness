// DemoDriver — scripted, looping fake state for `--demo` mode.
//
// The post-refactor architecture (see CLAUDE.md "Architecture") makes this
// surprisingly small: the renderer is a passive mirror of the main store
// driven by `state:event` IPC + the shared reducer, so we can fake the
// entire app by dispatching pre-canned StateEvents on a timeline. Real
// data sources (PRPoller, watchStatusDir, listWorktrees, ptyManager.create)
// are short-circuited in main/index.ts behind the isDemoMode flag, so
// nothing fights us.
//
// Terminal bytes don't flow through the store — they go over `terminal:data`
// IPC direct from node-pty to xterm.js. We replay asciinema cast files
// (v2 format: JSON header + JSONL `[ts, "o", data]` records) by sending
// the same chunks at the same timings over the same channel. xterm renders
// whatever we throw at it.
//
// The timeline is symmetric (state at t=0 == state at t=LOOP_MS) so the
// loop seams invisibly. See the homepage-GIF script in the demo-mode PR
// for the storyboard.

import { readFileSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import type { Store } from './store'
import type { StateEvent, Worktree, WorkspacePane, PRStatus } from '../shared/state'
import { log } from './debug'

const LOOP_MS = 30000

const ACME_API = '/demo/repos/acme-api'
const ACME_WEB = '/demo/repos/acme-web'

const WT_FIX_AUTH = '/demo/worktrees/acme-api/fix-auth-token-refresh'
const WT_RATE_LIMIT = '/demo/worktrees/acme-api/add-rate-limiter'
const WT_MIGRATE_PG = '/demo/worktrees/acme-api/migrate-postgres-16'
const WT_REDESIGN = '/demo/worktrees/acme-web/redesign-settings-page'
const WT_FIX_FLAKY = '/demo/worktrees/acme-api/fix-flaky-login-test'

const HERO_TAB_ID = 'demo-claude-fix-auth'
const TAB_RATE_LIMIT = 'demo-claude-rate-limit'
const TAB_MIGRATE_PG = 'demo-claude-migrate-pg'
const TAB_FIX_FLAKY = 'demo-claude-fix-flaky'
const TAB_REDESIGN = 'demo-claude-redesign'

function fakeWorktree(
  path: string,
  branch: string,
  repoRoot: string,
  isMain = false
): Worktree {
  return {
    path,
    branch,
    head: 'demo000000000000000000000000000000000000',
    isBare: false,
    isMain,
    createdAt: Date.now(),
    repoRoot
  }
}

function pr(
  number: number,
  title: string,
  branch: string,
  state: PRStatus['state'],
  checks: PRStatus['checksOverall']
): PRStatus {
  return {
    number,
    title,
    state,
    url: `https://github.com/demo/${branch}`,
    branch,
    checks: [
      {
        name: 'ci',
        state:
          checks === 'success'
            ? 'success'
            : checks === 'pending'
              ? 'pending'
              : checks === 'failure'
                ? 'failure'
                : 'neutral',
        description: 'Build & test'
      }
    ],
    checksOverall: checks,
    hasConflict: false,
    reviews: [],
    reviewDecision: 'none'
  }
}

interface CastRecord {
  delayMs: number
  data: string
}

function loadCast(file: string): CastRecord[] {
  const path = join(app.getAppPath(), 'resources', 'demo', file)
  const raw = readFileSync(path, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  // Header line is JSON: `{"version":2,...}` or `{"version":3,...}`.
  // v2: `[absoluteTs, "o", data]` — timestamps are absolute, deltas are derived.
  // v3: `[relativeTs, "o", data]` — timestamps are already deltas from prior record.
  const header = JSON.parse(lines[0]) as { version?: number }
  const version = header.version ?? 2
  const records: CastRecord[] = []
  let prevTs = 0
  for (let i = 1; i < lines.length; i++) {
    const parsed = JSON.parse(lines[i]) as [number, string, string]
    const [ts, channel, data] = parsed
    if (channel !== 'o') continue
    const delayMs =
      version >= 3 ? Math.max(0, ts * 1000) : Math.max(0, (ts - prevTs) * 1000)
    records.push({ delayMs, data })
    prevTs = ts
  }
  return records
}

export class DemoDriver {
  private store: Store
  private getWindow: () => BrowserWindow | null
  private timers: NodeJS.Timeout[] = []
  private heroCast: CastRecord[] = []

  constructor(store: Store, getWindow: () => BrowserWindow | null) {
    this.store = store
    this.getWindow = getWindow
  }

  start(): void {
    log('demo', 'starting DemoDriver')
    try {
      this.heroCast = loadCast('hero.cast')
    } catch (err) {
      log('demo', 'failed to load hero.cast', err instanceof Error ? err.message : err)
    }
    this.seed()
    this.runLoop()
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  private dispatch(event: StateEvent): void {
    this.store.dispatch(event)
  }

  private at(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms))
  }

  /** Seed initial state. Runs once on start() and again at the top of every
   * loop iteration to reset state to t=0. */
  private seed(): void {
    this.dispatch({
      type: 'hooks/consentChanged',
      payload: 'accepted'
    })

    this.dispatch({
      type: 'worktrees/reposChanged',
      payload: [ACME_API, ACME_WEB]
    })

    const worktrees: Worktree[] = [
      fakeWorktree(ACME_API, 'main', ACME_API, true),
      fakeWorktree(WT_FIX_AUTH, 'fix-auth-token-refresh', ACME_API),
      fakeWorktree(WT_RATE_LIMIT, 'add-rate-limiter', ACME_API),
      fakeWorktree(WT_MIGRATE_PG, 'migrate-postgres-16', ACME_API),
      fakeWorktree(WT_FIX_FLAKY, 'fix-flaky-login-test', ACME_API),
      fakeWorktree(ACME_WEB, 'main', ACME_WEB, true),
      fakeWorktree(WT_REDESIGN, 'redesign-settings-page', ACME_WEB)
    ]
    this.dispatch({ type: 'worktrees/listChanged', payload: worktrees })

    // Seed a pane with a single Claude tab for every demo worktree. The
    // sidebar's per-worktree status is derived by looking up panes for that
    // path, walking the tabs, and reading terminals.statuses[tab.id]. So
    // every worktree we want to flip in the timeline needs a tab whose id
    // matches what the timeline dispatches.
    //
    // Only the active worktree (fix-auth) has its xterm component actually
    // mounted; the others render invisibly. pty:create is a no-op in demo
    // mode so no real ptys spawn for any of them.
    const seedPane = (tabId: string): WorkspacePane => ({
      id: `demo-pane-${tabId}`,
      tabs: [
        {
          id: tabId,
          type: 'claude',
          label: 'Claude',
          sessionId: `demo-session-${tabId}`
        }
      ],
      activeTabId: tabId
    })
    this.dispatch({
      type: 'terminals/panesReplaced',
      payload: {
        [WT_FIX_AUTH]: [seedPane(HERO_TAB_ID)],
        [WT_RATE_LIMIT]: [seedPane(TAB_RATE_LIMIT)],
        [WT_MIGRATE_PG]: [seedPane(TAB_MIGRATE_PG)],
        [WT_FIX_FLAKY]: [seedPane(TAB_FIX_FLAKY)],
        [WT_REDESIGN]: [seedPane(TAB_REDESIGN)]
      }
    })

    // Initial statuses — opening frame
    this.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: HERO_TAB_ID, status: 'processing', pendingTool: null }
    })
    this.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: TAB_RATE_LIMIT, status: 'processing', pendingTool: null }
    })
    this.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: TAB_MIGRATE_PG, status: 'idle', pendingTool: null }
    })
    this.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: TAB_FIX_FLAKY, status: 'idle', pendingTool: null }
    })
    this.dispatch({
      type: 'terminals/statusChanged',
      payload: { id: TAB_REDESIGN, status: 'idle', pendingTool: null }
    })

    // Initial PR statuses
    this.dispatch({
      type: 'prs/bulkStatusChanged',
      payload: {
        [WT_FIX_AUTH]: pr(1823, 'Refresh expired auth tokens', 'fix-auth-token-refresh', 'open', 'pending'),
        [WT_RATE_LIMIT]: pr(1824, 'Add rate limiter middleware', 'add-rate-limiter', 'open', 'pending'),
        [WT_REDESIGN]: pr(442, 'Redesign settings page', 'redesign-settings-page', 'merged', 'success')
      }
    })
    this.dispatch({
      type: 'prs/mergedChanged',
      payload: { [WT_REDESIGN]: true }
    })

    // Per-worktree lastActive so the sidebar sort is stable
    const now = Date.now()
    for (const [i, p] of [WT_FIX_AUTH, WT_RATE_LIMIT, WT_MIGRATE_PG, WT_FIX_FLAKY, WT_REDESIGN].entries()) {
      this.dispatch({
        type: 'terminals/lastActiveChanged',
        payload: { worktreePath: p, ts: now - i * 60_000 }
      })
    }
  }

  /** The 8-second symmetric loop. Every change made in the first half is
   * undone in the second half so the state at LOOP_MS exactly equals t=0.
   * That means we only need to reschedule timeline + cast at the loop
   * boundary, not re-seed — re-seeding caused the sidebar to repaint
   * wholesale and the PR badge to re-animate every loop. */
  private runLoop(): void {
    this.scheduleTimeline()
    this.scheduleCast()
    this.timers.push(setTimeout(() => this.runLoop(), LOOP_MS))
  }

  private scheduleTimeline(): void {
    // t=6  migrate-pg → needs-approval
    this.at(6000, () => {
      this.dispatch({
        type: 'terminals/statusChanged',
        payload: {
          id: TAB_MIGRATE_PG,
          status: 'needs-approval',
          pendingTool: { name: 'Bash', input: { command: 'dropdb acme_dev && createdb acme_dev' } }
        }
      })
    })

    // t=12  rate-limiter PR pending → success
    this.at(12000, () => {
      this.dispatch({
        type: 'prs/statusChanged',
        payload: {
          path: WT_RATE_LIMIT,
          status: pr(1824, 'Add rate limiter middleware', 'add-rate-limiter', 'open', 'success')
        }
      })
    })

    // t=15  fix-auth processing → waiting (the hero worktree finishes)
    this.at(15000, () => {
      this.dispatch({
        type: 'terminals/statusChanged',
        payload: { id: HERO_TAB_ID, status: 'waiting', pendingTool: null }
      })
    })

    // t=18  fix-auth waiting → processing again (reverse for loop symmetry)
    this.at(18000, () => {
      this.dispatch({
        type: 'terminals/statusChanged',
        payload: { id: HERO_TAB_ID, status: 'processing', pendingTool: null }
      })
    })

    // t=24  rate-limiter PR success → pending (reverse)
    this.at(24000, () => {
      this.dispatch({
        type: 'prs/statusChanged',
        payload: {
          path: WT_RATE_LIMIT,
          status: pr(1824, 'Add rate limiter middleware', 'add-rate-limiter', 'open', 'pending')
        }
      })
    })

    // t=27  migrate-pg needs-approval → idle (reverse)
    this.at(27000, () => {
      this.dispatch({
        type: 'terminals/statusChanged',
        payload: { id: TAB_MIGRATE_PG, status: 'idle', pendingTool: null }
      })
    })
  }

  /** Replay the hero cast against HERO_TAB_ID. Schedules each chunk relative
   * to loop start; chunks past LOOP_MS are dropped. The first byte sent is
   * a full terminal reset (RIS, ESC c) so each loop starts with a clean
   * screen instead of layering on top of the previous loop's content. */
  private scheduleCast(): void {
    const win = this.getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:data', HERO_TAB_ID, '\x1bc')
    }
    if (this.heroCast.length === 0) return
    let cursor = 0
    for (const rec of this.heroCast) {
      cursor += rec.delayMs
      if (cursor >= LOOP_MS) break
      const fireAt = cursor
      const data = rec.data
      this.at(fireAt, () => {
        const w = this.getWindow()
        if (w && !w.isDestroyed()) {
          w.webContents.send('terminal:data', HERO_TAB_ID, data)
        }
      })
    }
  }
}
