// Context-window sizes per model, in tokens. Separate from pricing.ts
// because the two tables drift independently — a price change doesn't
// move the window, and the 1M beta moves the window without moving the
// price.
//
// Model ids can carry a `[1m]` suffix when the long-context beta is
// active (`claude-sonnet-4-5[1m]`). That suffix is checked before the
// prefix table so a 1M session isn't reported against a 200k limit.

export const DEFAULT_CONTEXT_LIMIT = 200_000
export const LONG_CONTEXT_LIMIT = 1_000_000

const LIMITS: Record<string, number> = {
  'claude-fable-5': DEFAULT_CONTEXT_LIMIT,
  'claude-mythos-5': DEFAULT_CONTEXT_LIMIT,
  'claude-opus-5': DEFAULT_CONTEXT_LIMIT,
  'claude-opus-4': DEFAULT_CONTEXT_LIMIT,
  'claude-sonnet-5': DEFAULT_CONTEXT_LIMIT,
  'claude-sonnet-4': DEFAULT_CONTEXT_LIMIT,
  'claude-haiku-4-5': DEFAULT_CONTEXT_LIMIT,
  // Codex / OpenAI models, for terminal tabs running `codex`.
  'gpt-5-codex': 400_000,
  'gpt-4.1': LONG_CONTEXT_LIMIT,
  o3: 200_000,
  'o4-mini': 200_000
}

/** Context window for a model id, in tokens. Unknown models fall back to
 *  200k rather than 0 so the UI shows a plausible bar instead of an
 *  instantly-full one. */
export function contextLimitFor(model: string | null | undefined): number {
  if (!model) return DEFAULT_CONTEXT_LIMIT
  if (model.includes('[1m]')) return LONG_CONTEXT_LIMIT
  if (LIMITS[model]) return LIMITS[model]
  for (const key of Object.keys(LIMITS)) {
    if (model.startsWith(key)) return LIMITS[key]
  }
  return DEFAULT_CONTEXT_LIMIT
}

/** Window tiers, ascending. Used to promote a session whose observed
 *  prompt sizes overshoot what the model table predicted. Anthropic ships
 *  200k and the 1M beta — no intermediate tier, so don't invent one or
 *  the denominator is a number no session actually had. */
const TIERS = [DEFAULT_CONTEXT_LIMIT, LONG_CONTEXT_LIMIT]

/** The context limit for `model`, corrected against what the session was
 *  actually observed to hold.
 *
 *  The table can't be trusted on its own: the 1M beta is enabled per
 *  session and the transcript's model id doesn't always carry the `[1m]`
 *  marker. Real sessions show prompt sizes of 596k against a model the
 *  table calls 200k. When that happens the session is the evidence and
 *  the table is wrong, so promote to the smallest tier that fits. */
export function inferContextLimit(
  model: string | null | undefined,
  observedPeakTokens: number
): number {
  const table = contextLimitFor(model)
  if (observedPeakTokens <= table) return table
  for (const tier of TIERS) {
    if (tier > table && observedPeakTokens <= tier) return tier
  }
  // Beyond every known tier — round up to the next whole million so the
  // bar stays meaningful rather than pinning at >100%.
  return Math.max(table, Math.ceil(observedPeakTokens / LONG_CONTEXT_LIMIT) * LONG_CONTEXT_LIMIT)
}

/** Fraction of the window at which Claude Code triggers an auto-compact.
 *  Only a fallback: `analyzeContext` prefers the `preTokens` recorded on
 *  a session's own past compact_boundary, which is the observed truth for
 *  that model + harness version. Sampled at ~0.84 of a 200k window. */
export const AUTOCOMPACT_FRACTION = 0.84

/** Rough chars-per-token for English + code. Only used for content that
 *  no usage record covers yet (the current in-flight tail, and the items
 *  preceding a session's first assistant turn). Everything else is
 *  anchored to measured token deltas. */
export const CHARS_PER_TOKEN = 4
