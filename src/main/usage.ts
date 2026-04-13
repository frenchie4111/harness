import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log } from './debug'

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  estimatedCost: number
}

// $/MTok. Public Anthropic rates as of Apr 2026 — update here if pricing
// changes. Cache write is approximated at the 5-minute ephemeral rate; 1h
// cache writes are rare in practice and slightly under-counted as a result.
interface Rate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const OPUS: Rate = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }
const SONNET: Rate = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const HAIKU: Rate = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 }

function rateForModel(model: string): Rate | null {
  if (!model || model === '<synthetic>') return null
  if (model.includes('opus')) return OPUS
  if (model.includes('haiku')) return HAIKU
  if (model.includes('sonnet')) return SONNET
  return SONNET
}

interface CacheEntry {
  mtimeMs: number
  size: number
  totals: UsageTotals
}

const cache = new Map<string, CacheEntry>()

function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', sanitizeCwd(cwd), `${sessionId}.jsonl`)
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0
  }
}

function parseTotals(raw: string): UsageTotals {
  const totals = emptyTotals()
  let pos = 0
  while (pos < raw.length) {
    const nl = raw.indexOf('\n', pos)
    const end = nl === -1 ? raw.length : nl
    const line = raw.slice(pos, end)
    pos = end + 1
    if (!line) continue
    let evt: unknown
    try {
      evt = JSON.parse(line)
    } catch {
      continue
    }
    const e = evt as {
      type?: string
      message?: {
        model?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }
    }
    if (e.type !== 'assistant' || !e.message?.usage) continue
    const rate = rateForModel(e.message.model || '')
    if (!rate) continue
    const u = e.message.usage
    const inp = u.input_tokens || 0
    const out = u.output_tokens || 0
    const cacheRead = u.cache_read_input_tokens || 0
    const cacheWrite = u.cache_creation_input_tokens || 0
    totals.inputTokens += inp
    totals.outputTokens += out
    totals.cacheReadTokens += cacheRead
    totals.cacheWriteTokens += cacheWrite
    totals.estimatedCost +=
      (inp * rate.input +
        out * rate.output +
        cacheRead * rate.cacheRead +
        cacheWrite * rate.cacheWrite) /
      1_000_000
  }
  return totals
}

export function getUsageForSession(cwd: string, sessionId: string): UsageTotals | null {
  const path = transcriptPath(cwd, sessionId)
  let stat
  try {
    stat = statSync(path)
  } catch {
    return null
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.totals
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const totals = parseTotals(raw)
    cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, totals })
    return totals
  } catch (err) {
    log('usage', `failed to read ${path}`, err instanceof Error ? err.message : err)
    return null
  }
}
