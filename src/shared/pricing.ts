// Anthropic Claude pricing in USD per million tokens. Update when
// Anthropic posts new rates. Unknown models return 0 and are logged so
// we notice a mismatch rather than silently charging 0.
//
// Cache multipliers (the load-bearing math that's wrong by ~10x if you
// forget it):
//   cache read  = input rate x 0.10   (90% discount)
//   cache write = input rate x 1.25   (25% surcharge)

export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface ModelRate {
  in: number
  out: number
}

const RATES: Record<string, ModelRate> = {
  'claude-opus-4-6': { in: 15, out: 75 },
  'claude-opus-4-5': { in: 15, out: 75 },
  'claude-opus-4': { in: 15, out: 75 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 }
}

function rateFor(model: string): ModelRate | null {
  if (RATES[model]) return RATES[model]
  for (const key of Object.keys(RATES)) {
    if (model.startsWith(key)) return RATES[key]
  }
  return null
}

export function priceFor(model: string, usage: TokenUsage): number {
  const rate = rateFor(model)
  if (!rate) return 0
  const inTok = usage.input_tokens ?? 0
  const outTok = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  return (
    (inTok * rate.in +
      outTok * rate.out +
      cacheRead * rate.in * 0.1 +
      cacheWrite * rate.in * 1.25) /
    1_000_000
  )
}

export function isKnownModel(model: string): boolean {
  return rateFor(model) !== null
}
