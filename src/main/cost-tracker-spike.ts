// Throwaway spike: read a Claude Code session jsonl and total up
// token usage + estimated cost per model. Run with:
//   npx tsx src/main/cost-tracker-spike.ts <path-to-session.jsonl>
//
// Findings this script verifies:
//   - Every `type:"assistant"` line carries `message.model` and
//     `message.usage` with input/output/cache_creation/cache_read tokens.
//   - Model is per-message, so /model switches mid-session are tracked.
//   - Cache reads are 10% of input price; cache writes (creation) are 125%.
//     Ignoring this would over/under-count by ~10x for cached sessions.

import { readFileSync } from 'fs'

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// $ per million tokens. Hardcoded for the spike — production should
// centralize this in a table that's easy to bump on rate changes.
const RATES: Record<string, { in: number; out: number }> = {
  'claude-opus-4-6': { in: 15, out: 75 },
  'claude-opus-4': { in: 15, out: 75 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 }
}

function priceFor(model: string, u: Usage): number {
  const rate = RATES[model]
  if (!rate) return 0
  const inTok = u.input_tokens ?? 0
  const outTok = u.output_tokens ?? 0
  const cacheRead = u.cache_read_input_tokens ?? 0
  const cacheWrite = u.cache_creation_input_tokens ?? 0
  // Anthropic pricing: cache read = 10% of input rate, cache write = 125%.
  return (
    (inTok * rate.in +
      outTok * rate.out +
      cacheRead * rate.in * 0.1 +
      cacheWrite * rate.in * 1.25) /
    1_000_000
  )
}

interface Tally {
  model: string
  messages: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export function tallyJsonl(path: string): Map<string, Tally> {
  const text = readFileSync(path, 'utf-8')
  const byModel = new Map<string, Tally>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type !== 'assistant') continue
    const msg = obj.message as Record<string, unknown> | undefined
    if (!msg) continue
    const model = (msg.model as string) ?? 'unknown'
    const usage = (msg.usage as Usage) ?? {}
    let t = byModel.get(model)
    if (!t) {
      t = { model, messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      byModel.set(model, t)
    }
    t.messages++
    t.input += usage.input_tokens ?? 0
    t.output += usage.output_tokens ?? 0
    t.cacheRead += usage.cache_read_input_tokens ?? 0
    t.cacheWrite += usage.cache_creation_input_tokens ?? 0
    t.cost += priceFor(model, usage)
  }
  return byModel
}

if (require.main === module) {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: tsx cost-tracker-spike.ts <session.jsonl>')
    process.exit(1)
  }
  const tally = tallyJsonl(path)
  let total = 0
  for (const t of tally.values()) {
    console.log(t)
    total += t.cost
  }
  console.log(`TOTAL: $${total.toFixed(4)}`)
}
