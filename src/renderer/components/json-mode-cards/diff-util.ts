import { structuredPatch } from 'diff'

export type DiffLine =
  | { kind: 'add'; text: string; oldLn: null; newLn: number }
  | { kind: 'remove'; text: string; oldLn: number; newLn: null }
  | { kind: 'context'; text: string; oldLn: number; newLn: number }
  | { kind: 'hunk-sep'; text: string; oldLn: null; newLn: null }

export function unifiedDiff(oldStr: string, newStr: string, context = 3): DiffLine[] {
  const patch = structuredPatch('a', 'b', oldStr, newStr, '', '', { context })
  const out: DiffLine[] = []
  patch.hunks.forEach((hunk, hi) => {
    if (hi > 0) out.push({ kind: 'hunk-sep', text: '…', oldLn: null, newLn: null })
    let oldLn = hunk.oldStart
    let newLn = hunk.newStart
    for (const ln of hunk.lines) {
      const marker = ln[0]
      if (marker === '\\') continue
      const text = ln.slice(1)
      if (marker === '-') {
        out.push({ kind: 'remove', text, oldLn, newLn: null })
        oldLn++
      } else if (marker === '+') {
        out.push({ kind: 'add', text, oldLn: null, newLn })
        newLn++
      } else {
        out.push({ kind: 'context', text, oldLn, newLn })
        oldLn++
        newLn++
      }
    }
  })
  return out
}

export {
  detectLanguage as langForPath,
  highlightLine,
  highlightToLines
} from '../../syntax'
