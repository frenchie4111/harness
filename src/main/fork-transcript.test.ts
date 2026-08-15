import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// forkTranscript resolves transcript paths under homedir(), so point that
// at a scratch dir rather than mocking fs — the atomic tmp+rename write and
// the recursive mkdir are exactly the behavior under test.
let fakeHome: string
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => fakeHome }
})
vi.mock('./debug', () => ({ log: () => {}, perfLog: () => {} }))

import { forkTranscript } from './json-claude-manager'

const SOURCE_WT = '/Users/someone/code/feature-a'
const DEST_WT = '/Users/someone/code/feature-b'

function projectDir(worktreePath: string): string {
  return join(fakeHome, '.claude', 'projects', worktreePath.replace(/[^a-zA-Z0-9]/g, '-'))
}

function writeTranscript(worktreePath: string, sessionId: string, lines: object[]): void {
  const dir = projectDir(worktreePath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

function readForked(worktreePath: string, sessionId: string): Record<string, unknown>[] {
  const raw = readFileSync(join(projectDir(worktreePath), `${sessionId}.jsonl`), 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

const CONVO = [
  { type: 'user', sessionId: 'src-session', cwd: SOURCE_WT, message: { content: 'first' } },
  { type: 'assistant', sessionId: 'src-session', cwd: SOURCE_WT, message: { id: 'msg_1' } },
  { type: 'user', sessionId: 'src-session', cwd: SOURCE_WT, message: { content: 'second' } },
  { type: 'assistant', sessionId: 'src-session', cwd: SOURCE_WT, message: { id: 'msg_2' } },
  { type: 'assistant', sessionId: 'src-session', cwd: SOURCE_WT, message: { id: 'msg_2' } }
]

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'harness-fork-test-'))
})

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
})

describe('forkTranscript', () => {
  it('copies the whole transcript when no fork point is given', () => {
    writeTranscript(SOURCE_WT, 'src-session', CONVO)
    const out = forkTranscript({
      sourceSessionId: 'src-session',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: SOURCE_WT
    })
    expect(out.ok).toBe(true)
    expect(readForked(SOURCE_WT, out.newSessionId!)).toHaveLength(CONVO.length)
  })

  it('truncates after the LAST line sharing the target message id', () => {
    // One assistant API turn spans several jsonl lines (thinking, tool_use,
    // text) that all carry the same message.id — cutting at the first would
    // drop half the turn.
    writeTranscript(SOURCE_WT, 'src-session', CONVO)
    const out = forkTranscript({
      sourceSessionId: 'src-session',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: SOURCE_WT,
      throughApiMessageId: 'msg_1'
    })
    expect(out.ok).toBe(true)
    expect(readForked(SOURCE_WT, out.newSessionId!)).toHaveLength(2)

    const full = forkTranscript({
      sourceSessionId: 'src-session',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: SOURCE_WT,
      throughApiMessageId: 'msg_2'
    })
    expect(readForked(SOURCE_WT, full.newSessionId!)).toHaveLength(5)
  })

  it('rewrites every inner sessionId to the new id', () => {
    writeTranscript(SOURCE_WT, 'src-session', CONVO)
    const out = forkTranscript({
      sourceSessionId: 'src-session',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: SOURCE_WT
    })
    const lines = readForked(SOURCE_WT, out.newSessionId!)
    expect(lines.every((l) => l.sessionId === out.newSessionId)).toBe(true)
  })

  it('writes into the destination worktree project dir, creating it', () => {
    // The in-place fork never had to create this dir; a brand-new worktree
    // has no project dir at all until its first session runs.
    writeTranscript(SOURCE_WT, 'src-session', CONVO)
    expect(existsSync(projectDir(DEST_WT))).toBe(false)

    const out = forkTranscript({
      sourceSessionId: 'src-session',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: DEST_WT
    })
    expect(out.ok).toBe(true)
    expect(existsSync(join(projectDir(DEST_WT), `${out.newSessionId}.jsonl`))).toBe(true)
    expect(readForked(DEST_WT, out.newSessionId!)).toHaveLength(CONVO.length)
  })

  it('leaves the source transcript untouched', () => {
    writeTranscript(SOURCE_WT, 'src-session', CONVO)
    const before = readFileSync(join(projectDir(SOURCE_WT), 'src-session.jsonl'), 'utf8')
    forkTranscript({
      sourceSessionId: 'src-session',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: DEST_WT
    })
    expect(readFileSync(join(projectDir(SOURCE_WT), 'src-session.jsonl'), 'utf8')).toBe(before)
  })

  it('preserves the recorded cwd of each turn', () => {
    // The CLI binds cwd from the spawned process, not the transcript, so
    // these stay accurate as history rather than being rewritten to the
    // destination. The agent is told about the move via the preamble.
    writeTranscript(SOURCE_WT, 'src-session', CONVO)
    const out = forkTranscript({
      sourceSessionId: 'src-session',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: DEST_WT
    })
    expect(readForked(DEST_WT, out.newSessionId!).every((l) => l.cwd === SOURCE_WT)).toBe(true)
  })

  it('fails cleanly when the source transcript is missing', () => {
    const out = forkTranscript({
      sourceSessionId: 'nope',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: DEST_WT
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('source transcript missing')
  })

  it('fails cleanly when the fork point matches no record', () => {
    writeTranscript(SOURCE_WT, 'src-session', CONVO)
    const out = forkTranscript({
      sourceSessionId: 'src-session',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: DEST_WT,
      throughApiMessageId: 'msg_missing'
    })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('no matching jsonl record')
    expect(existsSync(projectDir(DEST_WT))).toBe(false)
  })

  it('leaves no .tmp file behind', () => {
    writeTranscript(SOURCE_WT, 'src-session', CONVO)
    const out = forkTranscript({
      sourceSessionId: 'src-session',
      sourceWorktreePath: SOURCE_WT,
      destWorktreePath: DEST_WT
    })
    expect(readdirSync(projectDir(DEST_WT))).toEqual([`${out.newSessionId}.jsonl`])
  })
})
