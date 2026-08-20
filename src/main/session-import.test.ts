import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionImportEvent } from '../shared/state/session-import'
import type { TerminalTab } from '../shared/state/terminals'
import { SessionImportManager } from './session-import'
import type { DiscoveredSession } from './session-scanner'

/** forkTranscript reads and writes under the real ~/.claude/projects tree,
 *  so these tests point it at a scratch HOME. */
let fakeHome: string

function encodedDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function writeTranscript(cwd: string, sessionId: string, lines: object[]): void {
  const dir = join(fakeHome, '.claude', 'projects', encodedDir(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8'
  )
}

function session(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    sessionId: 'sid-1',
    transcriptPath: '/x.jsonl',
    cwd: '/work/repo',
    gitBranch: 'main',
    title: 'Fix the thing',
    titleSource: 'ai',
    prNumber: null,
    prUrl: null,
    prRepository: null,
    firstTimestamp: 1,
    lastTimestamp: 2,
    userTurns: 1,
    userTurnsExact: true,
    sizeBytes: 10,
    mtimeMs: 2,
    cliVersion: '2.1.126',
    ...over
  }
}

interface Harness {
  manager: SessionImportManager
  events: SessionImportEvent[]
  tabs: { worktreePath: string; tab: TerminalTab }[]
  started: { sessionId: string; worktreePath: string }[]
}

function harness(sessions: DiscoveredSession[]): Harness {
  const events: SessionImportEvent[] = []
  const tabs: { worktreePath: string; tab: TerminalTab }[] = []
  const started: { sessionId: string; worktreePath: string }[] = []
  const manager = new SessionImportManager({
    dispatch: (e) => events.push(e),
    getRepoRoots: () => [],
    addTab: (worktreePath, tab) => tabs.push({ worktreePath, tab }),
    startSession: (sessionId, worktreePath) => started.push({ sessionId, worktreePath }),
    homeDir: () => fakeHome,
    now: () => 1234
  })
  ;(manager as unknown as { sessions: DiscoveredSession[] }).sessions = sessions
  return { manager, events, tabs, started }
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'session-import-'))
  // os.homedir() reads $HOME, which is what forkTranscript resolves against.
  process.env.HOME = fakeHome
})

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })

})

describe('importSession', () => {
  it('adopts in place when the session already ran in the target worktree', () => {
    const h = harness([session({ sessionId: 'sid-1', cwd: '/work/repo' })])
    const outcome = h.manager.importSession('sid-1', '/work/repo')

    expect(outcome.ok).toBe(true)
    expect(outcome.mode).toBe('adopt')
    // Same id: the CLI resumes the existing transcript, no copy made.
    expect(outcome.sessionId).toBe('sid-1')
    expect(h.tabs[0].tab.id).toBe('sid-1')
    expect(h.tabs[0].tab.sessionId).toBe('sid-1')
    expect(h.tabs[0].tab.type).toBe('json-claude')
    expect(h.started).toEqual([{ sessionId: 'sid-1', worktreePath: '/work/repo' }])
  })

  it('titles the tab from the session title', () => {
    const h = harness([session({ title: 'Fix the thing' })])
    h.manager.importSession('sid-1', '/work/repo')
    expect(h.tabs[0].tab.label).toBe('Fix the thing')
  })

  it('falls back to a generic label when the session is untitled', () => {
    const h = harness([session({ title: null })])
    h.manager.importSession('sid-1', '/work/repo')
    expect(h.tabs[0].tab.label).toBe('Imported chat')
  })

  it('forks into the target when the session ran elsewhere', () => {
    writeTranscript('/work/source', 'sid-1', [
      { type: 'user', sessionId: 'sid-1', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', sessionId: 'sid-1', message: { id: 'm1', content: [] } }
    ])
    const h = harness([session({ sessionId: 'sid-1', cwd: '/work/source' })])

    const outcome = h.manager.importSession('sid-1', '/work/dest')

    expect(outcome.ok).toBe(true)
    expect(outcome.mode).toBe('fork')
    expect(outcome.sessionId).not.toBe('sid-1')

    // The copy lands in the destination worktree's encoded project dir...
    const destDir = join(fakeHome, '.claude', 'projects', encodedDir('/work/dest'))
    const written = readdirSync(destDir)
    expect(written).toEqual([`${outcome.sessionId}.jsonl`])

    // ...with every line restamped to the new session id.
    const body = readFileSync(join(destDir, written[0]), 'utf8').trim().split('\n')
    for (const line of body) {
      expect(JSON.parse(line).sessionId).toBe(outcome.sessionId)
    }

    // ...and the source is untouched.
    const srcDir = join(fakeHome, '.claude', 'projects', encodedDir('/work/source'))
    expect(readdirSync(srcDir)).toEqual(['sid-1.jsonl'])
    const srcBody = readFileSync(join(srcDir, 'sid-1.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(srcBody[0]).sessionId).toBe('sid-1')
  })

  it('opens the forked tab under the new id, not the source id', () => {
    writeTranscript('/work/source', 'sid-1', [
      { type: 'user', sessionId: 'sid-1', message: { role: 'user', content: 'hi' } }
    ])
    const h = harness([session({ sessionId: 'sid-1', cwd: '/work/source' })])
    const outcome = h.manager.importSession('sid-1', '/work/dest')
    expect(h.tabs[0].tab.id).toBe(outcome.sessionId)
    expect(h.started[0].sessionId).toBe(outcome.sessionId)
    expect(h.started[0].worktreePath).toBe('/work/dest')
  })

  it('fails cleanly when the source transcript is missing', () => {
    const h = harness([session({ sessionId: 'gone', cwd: '/work/source' })])
    const outcome = h.manager.importSession('gone', '/work/dest')
    expect(outcome.ok).toBe(false)
    expect(h.tabs).toHaveLength(0)
    expect(h.started).toHaveLength(0)
  })

  it('fails cleanly for an unknown session id', () => {
    const h = harness([])
    const outcome = h.manager.importSession('nope', '/work/dest')
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('session not found')
  })

  it('fails cleanly when the session has no recorded cwd', () => {
    const h = harness([session({ cwd: null })])
    const outcome = h.manager.importSession('sid-1', '/work/dest')
    expect(outcome.ok).toBe(false)
    expect(h.tabs).toHaveLength(0)
  })
})

describe('scan', () => {
  it('dispatches started then completed', async () => {
    const h = harness([])
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true })
    await h.manager.scan()
    expect(h.events[0].type).toBe('sessionImport/scanStarted')
    expect(h.events[h.events.length - 1]).toEqual({
      type: 'sessionImport/scanCompleted',
      payload: { sessionCount: 0, groupCount: 0, at: 1234 }
    })
  })

  it('reports not scanning once finished', async () => {
    const h = harness([])
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true })
    const inFlight = h.manager.scan()
    expect(h.manager.isScanning()).toBe(true)
    await inFlight
    expect(h.manager.isScanning()).toBe(false)
  })
})

describe('getTree', () => {
  it('groups the held sessions', () => {
    const h = harness([
      session({ sessionId: 'a', cwd: '/work/repo', gitBranch: 'main' }),
      session({ sessionId: 'b', cwd: '/work/repo', gitBranch: 'feat' })
    ])
    const tree = h.manager.getTree()
    expect(tree).toHaveLength(1)
    expect(tree[0].branches).toHaveLength(2)
  })
})
