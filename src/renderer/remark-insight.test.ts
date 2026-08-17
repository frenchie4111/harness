import { describe, it, expect } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
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

function run(md: string, classify?: (line: string) => InsightLineKind): Root {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(md) as Root
  remarkInsight(classify ? { classify } : {})(tree, { value: md })
  return tree
}

function transform(md: string): Root {
  return run(md, testClassify)
}

// Same pipeline, but with the shipping classifier — for the tests that
// exercise markdown Claude actually emits.
function transformReal(md: string): Root {
  return run(md)
}

function nodeIsInsight(node: RootContent): boolean {
  return node.type === 'paragraph' && node.data?.hName === 'insight-card'
}

function insightStreaming(node: RootContent): boolean {
  const p = node.data?.hProperties as { streaming?: boolean } | undefined
  return p?.streaming === true
}

// Flatten every text/code value under a node. Local rather than
// mdast-util-to-string so the test doesn't lean on a transitive dep.
function textOf(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { value?: unknown; children?: unknown }
  if (typeof n.value === 'string') return n.value
  if (Array.isArray(n.children)) return n.children.map(textOf).join(' ')
  return ''
}

function childTypes(node: RootContent): string[] {
  const kids = (node as { children?: RootContent[] }).children ?? []
  return kids.map((k) => k.type)
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

// Regression coverage for the shape Claude's output style actually
// emits: markers wrapped in backticks, body written as a bulleted list,
// and no blank line before the closer. The pre-fix tree-walking plugin
// produced an empty card with the bullets orphaned outside it, because
// the opener was its own block node and the list terminated the block.
describe('remarkInsight (markdown Claude actually emits)', () => {
  const BULLETED = [
    '`★ Insight ─────────────────────────────────────`',
    '- Gradle 9 uses three-part semver, so "9.5.0" is behind on **both** axes.',
    '- A "bad build" that does not compile teaches nothing.',
    '`─────────────────────────────────────────────────`'
  ].join('\n')

  it('keeps a bulleted body inside the card', () => {
    const tree = transformReal(BULLETED)
    expect(tree.children).toHaveLength(1)
    expect(nodeIsInsight(tree.children[0])).toBe(true)
    expect(childTypes(tree.children[0])).toEqual(['list'])
  })

  it('carries both bullets and neither marker bar into the card body', () => {
    const body = textOf(transformReal(BULLETED).children[0])
    expect(body).toContain('three-part semver')
    expect(body).toContain('teaches nothing')
    expect(body).not.toContain('─')
  })

  it('marks a closed bulleted insight as not streaming', () => {
    const tree = transformReal(BULLETED)
    expect(nodeIsInsight(tree.children[0])).toBe(true)
    expect(insightStreaming(tree.children[0])).toBe(false)
    expect(textOf(tree.children[0])).toContain('three-part semver')
  })

  // Guard tests for the line-oriented rewrite: these pass against the old
  // tree walk (remark stripped the backticks and hid fenced content), so
  // they exist to stop the new scanner from regressing either behaviour.
  it('recognises backtick-wrapped markers around a prose body', () => {
    const tree = transformReal('`★ Insight ─────`\nplain prose body\n`─────`')
    expect(tree.children).toHaveLength(1)
    expect(nodeIsInsight(tree.children[0])).toBe(true)
    expect(textOf(tree.children[0])).toContain('plain prose body')
  })

  it('keeps a fenced code block inside a closed insight', () => {
    const tree = transformReal(
      ['★ Insight ─────', 'before', '```', 'const x = 1', '```', 'after', '─────'].join('\n')
    )
    expect(tree.children).toHaveLength(1)
    expect(childTypes(tree.children[0])).toContain('code')
  })

  it('ignores marker-looking lines inside a fenced code block', () => {
    const tree = transformReal(
      ['some prose', '```', '★ Insight ─────', 'not a real marker', '─────', '```'].join('\n')
    )
    expect(tree.children.some(nodeIsInsight)).toBe(false)
  })

  it('preserves surrounding prose around a bulleted insight', () => {
    const tree = transformReal(`lead in\n\n${BULLETED}\n\ntrailing prose`)
    expect(tree.children).toHaveLength(3)
    expect(nodeIsInsight(tree.children[1])).toBe(true)
    expect(textOf(tree.children[0])).toContain('lead in')
    expect(textOf(tree.children[2])).toContain('trailing prose')
  })

  it('streams a bulleted insight whose closer has not arrived', () => {
    const tree = transformReal('`★ Insight ─────`\n- first point\n- second poi')
    expect(tree.children).toHaveLength(1)
    expect(nodeIsInsight(tree.children[0])).toBe(true)
    expect(insightStreaming(tree.children[0])).toBe(true)
    expect(childTypes(tree.children[0])).toEqual(['list'])
  })
})

// The plugin reads the raw markdown off the VFile that react-markdown
// passes to transformers. That contract is invisible to the unit tests
// above (they hand in a synthetic {value}), and breaking it would fail
// silently — the no-opener fast path would swallow every Insight rather
// than throw. So drive the real pipeline once.
describe('remarkInsight (through react-markdown)', () => {
  it('emits an insight-card element for a bulleted insight', () => {
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, {
        remarkPlugins: [remarkGfm, remarkInsight],
        components: {
          'insight-card': ({ children }: { children?: ReactNode }) =>
            createElement('section', { 'data-testid': 'insight' }, children)
        } as never,
        children: ['`★ Insight ─────`', '- a bulleted point', '`─────`'].join('\n')
      })
    )
    expect(html).toContain('data-testid="insight"')
    expect(html).toContain('<li>a bulleted point</li>')
    // The bullet must live inside the card, not after it.
    expect(html.indexOf('a bulleted point')).toBeGreaterThan(html.indexOf('data-testid'))
    expect(html).not.toContain('─')
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
