import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSessionFile, scanSessions } from './session-scanner'
import { statSync } from 'fs'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-scan-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const BASE = {
  cwd: '/Users/x/repo',
  gitBranch: 'feature/thing',
  version: '2.1.126',
  timestamp: '2026-08-10T19:54:30.360Z'
}

function userLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: null,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: `u-${text.slice(0, 6)}`,
    ...BASE,
    ...extra
  })
}

function assistantLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: { model: 'claude-opus-4-8', id: 'msg_1', content: [{ type: 'text', text }] },
    type: 'assistant',
    uuid: `a-${text.slice(0, 6)}`,
    ...BASE,
    ...extra
  })
}

/** A user record carrying tool results: array content whose elements have
 *  their own `content` field. This is the shape that broke an earlier
 *  regex-based fast path. */
function toolResultLine(payload: string): string {
  return JSON.stringify({
    parentUuid: null,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: payload }]
    },
    uuid: 'tr-1',
    ...BASE
  })
}

function writeSession(dir: string, sessionId: string, lines: string[]): string {
  const dirPath = join(root, dir)
  mkdirSync(dirPath, { recursive: true })
  const path = join(dirPath, `${sessionId}.jsonl`)
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
  return path
}

function read(path: string): ReturnType<typeof readSessionFile> {
  const st = statSync(path)
  return readSessionFile(path, st.size, st.mtimeMs)
}

describe('readSessionFile', () => {
  it('reads cwd and gitBranch from line content, not the directory name', () => {
    // Directory name is the lossy encoding; it must not be the source of truth.
    const path = writeSession('-', 'abc', [userLine('hello'), assistantLine('hi')])
    const session = read(path)
    expect(session.cwd).toBe('/Users/x/repo')
    expect(session.gitBranch).toBe('feature/thing')
    expect(session.sessionId).toBe('abc')
  })

  it('prefers a custom title over an ai title', () => {
    const path = writeSession('d', 'abc', [
      userLine('do the thing'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'AI generated' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'User chosen' })
    ])
    const session = read(path)
    expect(session.title).toBe('User chosen')
    expect(session.titleSource).toBe('custom')
  })

  it('ignores the repo/branch label Ness writes as a custom title', () => {
    const path = writeSession('d', 'abc', [
      userLine('do the thing'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'AI generated' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'claude-harness/rename/ness' })
    ])
    const session = read(path)
    expect(session.title).toBe('AI generated')
    expect(session.titleSource).toBe('ai')
  })

  it('keeps a custom title that reads like a sentence', () => {
    const path = writeSession('d', 'abc', [
      userLine('x'),
      JSON.stringify({ type: 'custom-title', customTitle: 'Rename harness/ness everywhere' })
    ])
    expect(read(path).title).toBe('Rename harness/ness everywhere')
  })

  it('prefers an ai title over the first message', () => {
    const path = writeSession('d', 'abc', [
      userLine('do the thing'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'AI generated' })
    ])
    const session = read(path)
    expect(session.title).toBe('AI generated')
    expect(session.titleSource).toBe('ai')
  })

  it('falls back to the first user message when untitled', () => {
    const path = writeSession('d', 'abc', [userLine('do the   thing\nplease')])
    const session = read(path)
    expect(session.title).toBe('do the thing please')
    expect(session.titleSource).toBe('first-message')
  })

  it('takes the last ai title when several were written', () => {
    const path = writeSession('d', 'abc', [
      userLine('x'),
      JSON.stringify({ type: 'ai-title', aiTitle: 'First guess' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Refined guess' })
    ])
    expect(read(path).title).toBe('Refined guess')
  })

  it('extracts pr-link metadata', () => {
    const path = writeSession('d', 'abc', [
      userLine('x'),
      JSON.stringify({
        type: 'pr-link',
        prNumber: 1142,
        prUrl: 'https://github.com/o/r/pull/1142',
        prRepository: 'o/r'
      })
    ])
    const session = read(path)
    expect(session.prNumber).toBe(1142)
    expect(session.prRepository).toBe('o/r')
  })

  it('counts only user turns that would render', () => {
    const path = writeSession('d', 'abc', [
      userLine('real one'),
      userLine('meta wrapper', { isMeta: true }),
      userLine('compaction summary', { isCompactSummary: true }),
      userLine('<command-name>/compact'),
      userLine('<local-command-stdout>Compacted'),
      userLine('   '),
      toolResultLine('tool output'),
      assistantLine('reply'),
      userLine('real two')
    ])
    const session = read(path)
    expect(session.userTurns).toBe(2)
    expect(session.userTurnsExact).toBe(true)
    expect(session.title).toBe('real one')
  })

  it('does not mistake tool-result content for a user turn on a large record', () => {
    // Regression: the >2KB fast path regex matched the tool_result element's
    // own `"content":"…"`, both inflating turn counts and titling the session
    // with tool output.
    const bigPayload = 'x'.repeat(8 * 1024)
    const path = writeSession('d', 'abc', [
      userLine('the real question'),
      toolResultLine(bigPayload),
      assistantLine('y'.repeat(8 * 1024))
    ])
    const session = read(path)
    expect(session.userTurns).toBe(1)
    expect(session.title).toBe('the real question')
  })

  it('counts a large typed user turn that exceeds the fast-path threshold', () => {
    const longPrompt = 'please review this: ' + 'z'.repeat(8 * 1024)
    const path = writeSession('d', 'abc', [userLine(longPrompt), assistantLine('ok')])
    const session = read(path)
    expect(session.userTurns).toBe(1)
    expect(session.cwd).toBe('/Users/x/repo')
  })

  it('still reads metadata from large assistant records', () => {
    const path = writeSession('d', 'abc', [
      assistantLine('q'.repeat(8 * 1024), { timestamp: '2026-08-10T20:00:00.000Z' })
    ])
    const session = read(path)
    expect(session.cwd).toBe('/Users/x/repo')
    expect(session.gitBranch).toBe('feature/thing')
    expect(session.cliVersion).toBe('2.1.126')
    expect(session.lastTimestamp).toBe(Date.parse('2026-08-10T20:00:00.000Z'))
  })

  it('tracks first and last timestamps across the session', () => {
    const path = writeSession('d', 'abc', [
      userLine('a', { timestamp: '2026-08-10T10:00:00.000Z' }),
      assistantLine('b', { timestamp: '2026-08-10T12:00:00.000Z' })
    ])
    const session = read(path)
    expect(session.firstTimestamp).toBe(Date.parse('2026-08-10T10:00:00.000Z'))
    expect(session.lastTimestamp).toBe(Date.parse('2026-08-10T12:00:00.000Z'))
  })

  it('skips malformed and non-object lines without throwing', () => {
    const path = writeSession('d', 'abc', [
      'not json at all',
      '{"broken":',
      '',
      userLine('survivor')
    ])
    const session = read(path)
    expect(session.userTurns).toBe(1)
    expect(session.title).toBe('survivor')
  })

  it('ignores bookkeeping record types', () => {
    const path = writeSession('d', 'abc', [
      JSON.stringify({ type: 'queue-operation', timestamp: BASE.timestamp }),
      JSON.stringify({ type: 'last-prompt', prompt: 'x' }),
      JSON.stringify({ type: 'agent-name', name: 'x' }),
      userLine('only turn')
    ])
    expect(read(path).userTurns).toBe(1)
  })
})

describe('scanSessions', () => {
  it('walks every project directory and sorts newest first', async () => {
    writeSession('dir-a', 'old', [userLine('a', { timestamp: '2026-08-01T00:00:00.000Z' })])
    writeSession('dir-b', 'new', [userLine('b', { timestamp: '2026-08-09T00:00:00.000Z' })])
    const result = await scanSessions({ root, useCache: false })
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['new', 'old'])
    expect(result.scannedFiles).toBe(2)
  })

  it('ignores non-jsonl files', async () => {
    writeSession('dir-a', 'real', [userLine('a')])
    mkdirSync(join(root, 'dir-a'), { recursive: true })
    writeFileSync(join(root, 'dir-a', 'notes.txt'), 'hello', 'utf8')
    const result = await scanSessions({ root, useCache: false })
    expect(result.scannedFiles).toBe(1)
  })

  it('returns an empty result when the projects root is missing', async () => {
    const result = await scanSessions({ root: join(root, 'nope'), useCache: false })
    expect(result.sessions).toEqual([])
    expect(result.scannedFiles).toBe(0)
  })

  it('reports progress for every file', async () => {
    writeSession('dir-a', 'one', [userLine('a')])
    writeSession('dir-a', 'two', [userLine('b')])
    const seen: number[] = []
    await scanSessions({ root, useCache: false, onProgress: (done) => seen.push(done) })
    expect(seen).toEqual([1, 2])
  })
})
