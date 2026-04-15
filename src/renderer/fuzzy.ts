export interface FuzzyResult {
  item: string
  score: number
  indices: number[]
}

/**
 * Path-aware fuzzy match with smart case and segment bonuses.
 * Returns items with score > 0, sorted desc by score.
 *
 * Scoring:
 *  - base +1 per matched char
 *  - consecutive match +3
 *  - segment start (after '/') +5
 *  - filename start (after last '/') +8
 *  - full prefix of filename +10 bonus
 * Smart case: lowercase query → case-insensitive; any uppercase → case-sensitive.
 */
export function fuzzyMatch(query: string, candidates: string[]): FuzzyResult[] {
  if (!query) return []
  const caseSensitive = /[A-Z]/.test(query)
  const q = caseSensitive ? query : query.toLowerCase()
  const results: FuzzyResult[] = []

  for (const item of candidates) {
    const res = scoreOne(q, item, caseSensitive)
    if (res) results.push({ item, score: res.score, indices: res.indices })
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

function scoreOne(
  q: string,
  item: string,
  caseSensitive: boolean
): { score: number; indices: number[] } | null {
  const text = caseSensitive ? item : item.toLowerCase()
  const lastSlash = item.lastIndexOf('/')
  const fileStart = lastSlash + 1

  let score = 0
  let qi = 0
  let prevMatch = -2
  const indices: number[] = []

  for (let ti = 0; ti < text.length && qi < q.length; ti++) {
    if (text[ti] === q[qi]) {
      let charScore = 1
      if (ti === prevMatch + 1) charScore += 3
      if (ti === 0 || item[ti - 1] === '/') charScore += 5
      if (ti === fileStart) charScore += 8
      score += charScore
      indices.push(ti)
      prevMatch = ti
      qi++
    }
  }

  if (qi < q.length) return null

  // Prefix bonus if query matches start of filename contiguously.
  const filename = text.slice(fileStart)
  if (filename.startsWith(q)) score += 10

  return { score, indices }
}
