// Best-effort parser for partial JSON arriving over `input_json_delta`
// stream events. Strategy: (1) strict JSON.parse, (2) close any open
// strings + objects + arrays, (3) walk back to the last top-level comma
// boundary and retry. Anything weirder returns null — the caller treats
// that as "skip this delta" and the per-tool card stays on its previous
// shown input.

export function tolerantJsonParse(
  partial: string
): Record<string, unknown> | null {
  if (!partial) return null
  const direct = tryParseObject(partial)
  if (direct) return direct
  const closed = closeOpenStructures(partial)
  if (closed !== null) {
    const parsed = tryParseObject(closed)
    if (parsed) return parsed
  }
  return trimToLastBoundary(partial)
}

function tryParseObject(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function closeOpenStructures(s: string): string | null {
  const stack: ('{' | '[')[] = []
  let inString = false
  let escape = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}') {
      if (stack[stack.length - 1] !== '{') return null
      stack.pop()
    } else if (ch === ']') {
      if (stack[stack.length - 1] !== '[') return null
      stack.pop()
    }
  }
  let result = s
  if (inString && escape) {
    result = result.slice(0, -1) + '"'
  } else if (inString) {
    result += '"'
  }
  for (let j = stack.length - 1; j >= 0; j--) {
    result += stack[j] === '{' ? '}' : ']'
  }
  return result
}

function trimToLastBoundary(s: string): Record<string, unknown> | null {
  const commas: number[] = []
  let inString = false
  let escape = false
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    else if (ch === ',' && depth >= 1) commas.push(i)
  }
  for (let p = commas.length - 1; p >= 0; p--) {
    const truncated = s.slice(0, commas[p])
    const closed = closeOpenStructures(truncated)
    if (closed === null) continue
    const parsed = tryParseObject(closed)
    if (parsed) return parsed
  }
  return null
}
