// One-shot walker over ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl that
// produces a per-session cost summary list for the Activity > Costs tab.
//
// Cache is in-memory only and keyed by absolute file path; an entry hits when
// the on-disk mtime hasn't moved since we last parsed. First call after boot
// pays the full parse cost (1-5s for hundreds of sessions); subsequent calls
// only re-parse files that grew. Lost on restart — acceptable for v1.
//
// Project dir name is the worktree path with every non-alphanumeric char
// collapsed to '-' (see json-claude-manager.ts seedFromTranscript). The
// reverse is lossy, so for display we prefer the `cwd` field that Claude
// Code writes onto every assistant/user line and fall back to the encoded
// dir name only if no line carried one.

import { readdir, stat, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { priceFor, type TokenUsage } from '../shared/pricing'
import type { SessionCostSummary } from '../shared/cost-summary'
import { log } from './debug'

export type { SessionCostSummary }

interface CacheEntry {
  mtime: number
  summary: SessionCostSummary
}

const cache = new Map<string, CacheEntry>()

export function clearCostAggregatorCache(): void {
  cache.clear()
}

export async function getAllSessionCosts(
  opts: { sinceMs?: number; projectsDir?: string } = {}
): Promise<SessionCostSummary[]> {
  const projectsDir =
    opts.projectsDir ?? join(homedir(), '.claude', 'projects')
  let dirs: string[]
  try {
    dirs = await readdir(projectsDir)
  } catch {
    return []
  }

  const out: SessionCostSummary[] = []
  for (const dirName of dirs) {
    const dirPath = join(projectsDir, dirName)
    let dirStat
    try {
      dirStat = await stat(dirPath)
    } catch {
      continue
    }
    if (!dirStat.isDirectory()) continue

    let files: string[]
    try {
      files = await readdir(dirPath)
    } catch {
      continue
    }

    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl')) continue
      const filePath = join(dirPath, fileName)
      let fileStat
      try {
        fileStat = await stat(filePath)
      } catch {
        continue
      }
      if (!fileStat.isFile()) continue

      const mtimeMs = fileStat.mtimeMs
      if (opts.sinceMs != null && mtimeMs < opts.sinceMs) continue

      const cached = cache.get(filePath)
      let summary: SessionCostSummary | null
      if (cached && cached.mtime >= mtimeMs) {
        summary = cached.summary
      } else {
        try {
          summary = await parseSession(filePath, fileName, dirName)
        } catch (err) {
          log(
            'cost-aggregator',
            `parse failed for ${filePath}: ${err instanceof Error ? err.message : err}`
          )
          continue
        }
        if (summary) cache.set(filePath, { mtime: mtimeMs, summary })
      }

      if (!summary || summary.turns === 0) continue
      if (opts.sinceMs != null && summary.lastAt < opts.sinceMs) continue
      out.push(summary)
    }
  }
  return out
}

async function parseSession(
  filePath: string,
  fileName: string,
  dirName: string
): Promise<SessionCostSummary> {
  const text = await readFile(filePath, 'utf-8')
  const sessionId = fileName.replace(/\.jsonl$/, '')

  let totalCostUsd = 0
  let model: string | null = null
  let firstAt = Number.POSITIVE_INFINITY
  let lastAt = 0
  let turns = 0
  let projectPath: string | null = null

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!projectPath && typeof obj.cwd === 'string') {
      projectPath = obj.cwd
    }
    const rawTs = obj.timestamp
    if (typeof rawTs === 'string') {
      const ts = Date.parse(rawTs)
      if (!Number.isNaN(ts)) {
        if (ts < firstAt) firstAt = ts
        if (ts > lastAt) lastAt = ts
      }
    }
    if (obj.type !== 'assistant') continue
    const msg = obj.message as Record<string, unknown> | undefined
    if (!msg) continue
    const m = typeof msg.model === 'string' ? msg.model : null
    const usage = (msg.usage ?? null) as TokenUsage | null
    if (!m || !usage) continue
    totalCostUsd += priceFor(m, usage)
    model = m
    turns += 1
  }

  if (firstAt === Number.POSITIVE_INFINITY) firstAt = 0

  return {
    sessionId,
    projectPath: projectPath ?? dirName,
    totalCostUsd,
    model,
    firstAt,
    lastAt,
    turns
  }
}
