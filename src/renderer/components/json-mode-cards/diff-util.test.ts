import { describe, expect, it } from 'vitest'
import { unifiedDiff } from './diff-util'

describe('unifiedDiff', () => {
  it('returns empty array for identical input', () => {
    expect(unifiedDiff('foo\nbar\n', 'foo\nbar\n')).toEqual([])
  })

  it('marks added lines as +, with newLn line number set', () => {
    const out = unifiedDiff('a\nb\n', 'a\nb\nc\n')
    const adds = out.filter((l) => l.kind === 'add')
    expect(adds.length).toBe(1)
    expect(adds[0]).toMatchObject({ kind: 'add', text: 'c', newLn: 3, oldLn: null })
  })

  it('marks removed lines as -, with oldLn line number set', () => {
    const out = unifiedDiff('a\nb\nc\n', 'a\nc\n')
    const removes = out.filter((l) => l.kind === 'remove')
    expect(removes.length).toBe(1)
    expect(removes[0]).toMatchObject({ kind: 'remove', text: 'b', oldLn: 2, newLn: null })
  })

  it('emits context lines around a single-line change with both line numbers', () => {
    const oldStr = 'a\nb\nc\nd\ne\n'
    const newStr = 'a\nb\nC\nd\ne\n'
    const out = unifiedDiff(oldStr, newStr)
    const ctx = out.filter((l) => l.kind === 'context')
    expect(ctx.length).toBeGreaterThan(0)
    for (const c of ctx) {
      expect(c.oldLn).toBeGreaterThan(0)
      expect(c.newLn).toBeGreaterThan(0)
    }
    const remove = out.find((l) => l.kind === 'remove')
    const add = out.find((l) => l.kind === 'add')
    expect(remove?.text).toBe('c')
    expect(add?.text).toBe('C')
  })

  it('emits a hunk-sep between disjoint hunks', () => {
    const oldStr = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n')
    const newLines = oldStr.split('\n')
    newLines[2] = 'CHANGED-3'
    newLines[27] = 'CHANGED-28'
    const newStr = newLines.join('\n')
    const out = unifiedDiff(oldStr, newStr)
    const seps = out.filter((l) => l.kind === 'hunk-sep')
    expect(seps.length).toBe(1)
  })
})
