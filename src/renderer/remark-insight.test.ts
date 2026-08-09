import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root, RootContent } from 'mdast'
import { remarkInsight, classifyInsightLine, type InsightLineKind } from './remark-insight'

// Test classifier — deliberately different from the user's real impl so
// the plugin logic tests don't depend on their rules. We use "OPEN:" as
// opener and "CLOSE:" as closer for maximum unambiguity.
const testClassify = (line: string): InsightLineKind => {
  if (line === 'OPEN:') return 'opener'
  if (line === 'CLOSE:') return 'closer'
  return null
}

function transform(md: string): Root {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(md) as Root
  remarkInsight({ classify: testClassify })(tree)
  return tree
}

function nodeIsInsight(node: RootContent): boolean {
  return node.type === 'paragraph' && node.data?.hName === 'insight-card'
}

function insightStreaming(node: RootContent): boolean {
  const p = node.data?.hProperties as { streaming?: boolean } | undefined
  return p?.streaming === true
}

describe('remarkInsight (plugin logic)', () => {
  it('leaves text without markers untouched', () => {
    const tree = transform('just some prose\n\nanother paragraph')
    expect(tree.children.every((n) => !nodeIsInsight(n))).toBe(true)
    expect(tree.children).toHaveLength(2)
  })

  it('wraps a single-paragraph insight (opener + body + closer)', () => {
    const tree = transform('OPEN:\nthe body\nCLOSE:')
    expect(tree.children).toHaveLength(1)
    expect(nodeIsInsight(tree.children[0])).toBe(true)
    expect(insightStreaming(tree.children[0])).toBe(false)
  })

  it('wraps a multi-paragraph insight (blank line inside body)', () => {
    const tree = transform('OPEN:\npara one\n\npara two\nCLOSE:')
    expect(tree.children).toHaveLength(1)
    expect(nodeIsInsight(tree.children[0])).toBe(true)
  })

  it('flags an unterminated insight as streaming', () => {
    const tree = transform('OPEN:\nbody still coming')
    expect(tree.children).toHaveLength(1)
    expect(nodeIsInsight(tree.children[0])).toBe(true)
    expect(insightStreaming(tree.children[0])).toBe(true)
  })

  it('preserves pre-opener content as its own paragraph', () => {
    const tree = transform('intro line\nOPEN:\nbody\nCLOSE:')
    expect(tree.children).toHaveLength(2)
    expect(nodeIsInsight(tree.children[0])).toBe(false)
    expect(nodeIsInsight(tree.children[1])).toBe(true)
  })

  it('preserves post-closer content as its own paragraph', () => {
    const tree = transform('OPEN:\nbody\nCLOSE:\ntrailing prose')
    expect(tree.children).toHaveLength(2)
    expect(nodeIsInsight(tree.children[0])).toBe(true)
    expect(nodeIsInsight(tree.children[1])).toBe(false)
  })

  it('handles two insights in one message', () => {
    const tree = transform('OPEN:\nfirst\nCLOSE:\n\nOPEN:\nsecond\nCLOSE:')
    const insights = tree.children.filter(nodeIsInsight)
    expect(insights).toHaveLength(2)
    expect(insights.every((n) => !insightStreaming(n))).toBe(true)
  })

  it('terminates in-progress insight before a block-level node (code fence)', () => {
    const tree = transform('OPEN:\nbody\n\n```\ncode\n```')
    const insight = tree.children.find(nodeIsInsight)
    expect(insight).toBeDefined()
    // The code block should still appear as its own node.
    expect(tree.children.some((n) => n.type === 'code')).toBe(true)
  })
})

describe('classifyInsightLine', () => {
  // The canonical shape we see most often in practice.
  it('recognises the canonical opener', () => {
    expect(classifyInsightLine('★ Insight ─────────────────────────────────────')).toBe('opener')
  })
  it('recognises the canonical closer', () => {
    expect(classifyInsightLine('─────────────────────────────────────────────────')).toBe('closer')
  })

  // Rule 1: minimum three dashes on either side.
  it('accepts exactly three dashes', () => {
    expect(classifyInsightLine('★ Insight ───')).toBe('opener')
    expect(classifyInsightLine('───')).toBe('closer')
  })
  it('rejects two dashes', () => {
    expect(classifyInsightLine('★ Insight ──')).toBeNull()
    expect(classifyInsightLine('──')).toBeNull()
  })

  // Rule 2: permissive on the star character.
  it('accepts alternate star characters', () => {
    for (const star of ['★', '☆', '•', '*']) {
      expect(classifyInsightLine(`${star} Insight ─────`)).toBe('opener')
    }
  })
  it('rejects openers with no star', () => {
    expect(classifyInsightLine('Insight ─────')).toBeNull()
  })

  // Rule 3: case-insensitive label.
  it('accepts label in any case', () => {
    for (const label of ['insight', 'INSIGHT', 'InSiGhT']) {
      expect(classifyInsightLine(`★ ${label} ─────`)).toBe('opener')
    }
  })

  // Rule 4: trailing periods (and residual whitespace, though the caller
  // has already trimmed) are tolerated.
  it('tolerates a trailing period on the marker', () => {
    expect(classifyInsightLine('★ Insight ─────.')).toBe('opener')
    expect(classifyInsightLine('─────.')).toBe('closer')
  })

  // Rule 5: opener and closer bar lengths do NOT need to match. Verified
  // structurally by the "canonical opener + canonical closer" pair above
  // (opener 45 dashes, closer 49 dashes) both classifying correctly.

  it('classifies random prose as null', () => {
    expect(classifyInsightLine('just a normal sentence.')).toBeNull()
    expect(classifyInsightLine('★ Some other bullet, no dashes')).toBeNull()
    expect(classifyInsightLine('')).toBeNull()
  })
})
