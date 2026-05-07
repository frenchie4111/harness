import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getAllSessionCosts,
  clearCostAggregatorCache
} from './cost-aggregator'

let tmpRoot: string

async function setMtime(path: string, ts: number): Promise<void> {
  const date = new Date(ts)
  await utimes(path, date, date)
}

function assistantLine(opts: {
  model: string
  inputTokens: number
  outputTokens: number
  timestamp: string
  cwd?: string
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.timestamp,
    cwd: opts.cwd,
    message: {
      model: opts.model,
      usage: {
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens
      },
      content: [{ type: 'text', text: 'hi' }]
    }
  })
}

beforeEach(async () => {
  clearCostAggregatorCache()
  tmpRoot = await mkdtemp(join(tmpdir(), 'cost-agg-'))
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('getAllSessionCosts', () => {
  it('returns empty array when projects dir does not exist', async () => {
    const result = await getAllSessionCosts({
      projectsDir: join(tmpRoot, 'does-not-exist')
    })
    expect(result).toEqual([])
  })

  it('parses sessions and computes totalCostUsd', async () => {
    const projectDir = join(tmpRoot, '-Users-mike-foo')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess-1.jsonl')
    await writeFile(
      filePath,
      [
        assistantLine({
          model: 'claude-sonnet-4-5',
          inputTokens: 1000,
          outputTokens: 500,
          timestamp: '2026-04-01T12:00:00Z',
          cwd: '/Users/mike/foo'
        }),
        assistantLine({
          model: 'claude-sonnet-4-5',
          inputTokens: 500,
          outputTokens: 200,
          timestamp: '2026-04-01T12:01:00Z'
        })
      ].join('\n') + '\n'
    )

    const result = await getAllSessionCosts({ projectsDir: tmpRoot })
    expect(result).toHaveLength(1)
    const row = result[0]
    expect(row.sessionId).toBe('sess-1')
    expect(row.projectPath).toBe('/Users/mike/foo')
    expect(row.model).toBe('claude-sonnet-4-5')
    expect(row.turns).toBe(2)
    // sonnet-4-5: in $3/M, out $15/M
    // (1500 * 3 + 700 * 15) / 1_000_000 = (4500 + 10500)/1M = 0.015
    expect(row.totalCostUsd).toBeCloseTo(0.015, 6)
    expect(row.firstAt).toBe(Date.parse('2026-04-01T12:00:00Z'))
    expect(row.lastAt).toBe(Date.parse('2026-04-01T12:01:00Z'))
  })

  it('falls back to encoded dir name when no cwd is in any line', async () => {
    const projectDir = join(tmpRoot, '-Users-mike-bar')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'sess-2.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-04-01T12:00:00Z',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: []
        }
      }) + '\n'
    )

    const result = await getAllSessionCosts({ projectsDir: tmpRoot })
    expect(result[0].projectPath).toBe('-Users-mike-bar')
  })

  it('caches summaries by mtime — second call hits cache', async () => {
    const projectDir = join(tmpRoot, '-Users-mike-foo')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess-1.jsonl')
    await writeFile(
      filePath,
      assistantLine({
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 50,
        timestamp: '2026-04-01T12:00:00Z'
      }) + '\n'
    )

    const first = await getAllSessionCosts({ projectsDir: tmpRoot })
    const cachedSummary = first[0]

    // Mutate file CONTENT but keep mtime the same — second call should
    // return the cached value (NOT the new content) because mtime is the
    // sole cache key.
    const originalMtime = (await import('fs/promises'))
      .stat(filePath)
      .then((s) => s.mtimeMs)
    const t = await originalMtime
    await writeFile(
      filePath,
      assistantLine({
        model: 'claude-opus-4-5',
        inputTokens: 999,
        outputTokens: 999,
        timestamp: '2026-04-01T13:00:00Z'
      }) + '\n'
    )
    await setMtime(filePath, t)

    const second = await getAllSessionCosts({ projectsDir: tmpRoot })
    expect(second[0]).toEqual(cachedSummary)
  })

  it('invalidates cache when mtime advances', async () => {
    const projectDir = join(tmpRoot, '-Users-mike-foo')
    await mkdir(projectDir, { recursive: true })
    const filePath = join(projectDir, 'sess-1.jsonl')
    await writeFile(
      filePath,
      assistantLine({
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 50,
        timestamp: '2026-04-01T12:00:00Z'
      }) + '\n'
    )

    const first = await getAllSessionCosts({ projectsDir: tmpRoot })
    expect(first[0].turns).toBe(1)

    // Append a turn and bump mtime forward.
    await writeFile(
      filePath,
      [
        assistantLine({
          model: 'claude-sonnet-4-5',
          inputTokens: 100,
          outputTokens: 50,
          timestamp: '2026-04-01T12:00:00Z'
        }),
        assistantLine({
          model: 'claude-sonnet-4-5',
          inputTokens: 200,
          outputTokens: 100,
          timestamp: '2026-04-01T12:05:00Z'
        })
      ].join('\n') + '\n'
    )
    await setMtime(filePath, Date.now() + 60_000)

    const second = await getAllSessionCosts({ projectsDir: tmpRoot })
    expect(second[0].turns).toBe(2)
  })

  it('sinceMs filter excludes files older than the window', async () => {
    const projectDir = join(tmpRoot, '-Users-mike-foo')
    await mkdir(projectDir, { recursive: true })
    const oldFile = join(projectDir, 'old.jsonl')
    const newFile = join(projectDir, 'new.jsonl')
    await writeFile(
      oldFile,
      assistantLine({
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 50,
        timestamp: '2025-01-01T00:00:00Z'
      }) + '\n'
    )
    await writeFile(
      newFile,
      assistantLine({
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 50,
        timestamp: new Date().toISOString()
      }) + '\n'
    )
    // Force the old file's mtime way back; let new file keep its current mtime.
    await setMtime(oldFile, Date.parse('2025-01-01T00:00:00Z'))

    const sinceMs = Date.now() - 24 * 60 * 60 * 1000
    const result = await getAllSessionCosts({
      projectsDir: tmpRoot,
      sinceMs
    })
    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('new')
  })

  it('skips malformed jsonl lines without crashing', async () => {
    const projectDir = join(tmpRoot, '-Users-mike-foo')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'sess-1.jsonl'),
      [
        '{not valid json',
        assistantLine({
          model: 'claude-sonnet-4-5',
          inputTokens: 100,
          outputTokens: 50,
          timestamp: '2026-04-01T12:00:00Z'
        }),
        '} also broken'
      ].join('\n') + '\n'
    )

    const result = await getAllSessionCosts({ projectsDir: tmpRoot })
    expect(result).toHaveLength(1)
    expect(result[0].turns).toBe(1)
  })

  it('returns empty array when projects dir is empty', async () => {
    const result = await getAllSessionCosts({ projectsDir: tmpRoot })
    expect(result).toEqual([])
  })

  it('skips sessions with zero turns', async () => {
    const projectDir = join(tmpRoot, '-Users-mike-foo')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'empty.jsonl'),
      JSON.stringify({
        type: 'permission-mode',
        permissionMode: 'default',
        sessionId: 'empty'
      }) + '\n'
    )
    const result = await getAllSessionCosts({ projectsDir: tmpRoot })
    expect(result).toEqual([])
  })

  it('handles non-jsonl files in the directory', async () => {
    const projectDir = join(tmpRoot, '-Users-mike-foo')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'README.md'), 'not a session')
    await writeFile(
      join(projectDir, 'sess-1.jsonl'),
      assistantLine({
        model: 'claude-sonnet-4-5',
        inputTokens: 100,
        outputTokens: 50,
        timestamp: '2026-04-01T12:00:00Z'
      }) + '\n'
    )
    const result = await getAllSessionCosts({ projectsDir: tmpRoot })
    expect(result).toHaveLength(1)
  })
})
