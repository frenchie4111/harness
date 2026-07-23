// Remark plugin that detects "★ Insight ─────" bracketed blocks in
// assistant messages and rewrites them into a custom `insight-card` node
// so the renderer can present them as collapsible styled cards.
//
// Streaming: when the closing "─────" hasn't arrived yet, the plugin
// still emits the card and marks it `streaming: true`. The card component
// uses that to draw a live "..." indicator until the closer streams in.
//
// The one thing you need to define is the LINE CLASSIFIER — see
// classifyInsightLine below. The rest is plumbing you shouldn't need to
// touch unless the shape of an Insight body changes.

import type { Root, RootContent, Paragraph, PhrasingContent } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

export type InsightLineKind = 'opener' | 'closer' | null

/**
 * TODO(you): decide what counts as an Insight opener / closer / neither.
 *
 * Openers look roughly like:  ★ Insight ─────────────────────
 * Closers look like:          ─────────────────────────────────
 *
 * The exact rules are your call — how strict is the star match, what's
 * the minimum bar length, does trailing whitespace count, is the label
 * case-sensitive. This is the one place the shape of an Insight is
 * defined; everything else in this file just acts on your verdict.
 *
 * Should return:
 *   'opener' for a line that begins an Insight block
 *   'closer' for a line that ends one
 *   null     for anything else
 *
 * Note: `line` is already trimmed of surrounding whitespace by the
 * caller, so you don't need to strip it yourself.
 */
// Any of these count as an Insight star. Kept permissive on purpose —
// Claude output has drifted between ★, ☆, •, and * across model versions.
const STAR = '[★☆•*]'
// Minimum 3 dashes. The label is case-insensitive (`i` flag).
// Trailing whitespace or periods after the bar are tolerated so a stray
// end-of-sentence period doesn't break the marker.
const OPENER_RE = new RegExp(`^${STAR}\\s*Insight\\s*─{3,}[\\s.]*$`, 'i')
// Closer is just a bar of at least 3 dashes; length doesn't need to
// match the opener.
const CLOSER_RE = /^─{3,}[\s.]*$/

export function classifyInsightLine(line: string): InsightLineKind {
  if (OPENER_RE.test(line)) return 'opener'
  if (CLOSER_RE.test(line)) return 'closer'
  return null
}

// ── Plumbing below ────────────────────────────────────────────────

export interface RemarkInsightOptions {
  /** Injectable for tests; defaults to the exported classifyInsightLine. */
  classify?: (line: string) => InsightLineKind
}

// Reconstruct plain-text lines from a paragraph. Inline markdown inside
// opener / closer lines is not preserved — they're prose markers, not
// content. Body inline formatting IS preserved because we re-parse the
// body string through remark below.
function paragraphToLines(p: Paragraph): string[] {
  const parts: string[] = []
  const walk = (nodes: PhrasingContent[]) => {
    for (const n of nodes) {
      if ('value' in n && typeof (n as { value: unknown }).value === 'string') {
        parts.push((n as { value: string }).value)
      } else if (n.type === 'break') {
        parts.push('\n')
      } else if ('children' in n && Array.isArray((n as { children: unknown }).children)) {
        walk((n as { children: PhrasingContent[] }).children)
      }
    }
  }
  walk(p.children)
  return parts.join('').split('\n')
}

// Re-parse the Insight body so links / code spans / lists inside a card
// still render as markdown. Same extensions as the main pipeline.
const bodyParser = unified().use(remarkParse).use(remarkGfm)

function parseBody(md: string): RootContent[] {
  const tree = bodyParser.parse(md) as Root
  return tree.children
}

function makeInsightNode(bodyMd: string, streaming: boolean): RootContent {
  // Any node type works because `data.hName` overrides the tag. We use
  // `paragraph` so mdast validators don't complain about an unknown type.
  return {
    type: 'paragraph',
    data: {
      hName: 'insight-card',
      hProperties: { streaming }
    },
    // The parsed body is a list of block-level nodes (paragraphs, lists,
    // code, etc.). We hand them to react-markdown as children of our
    // custom element, which is fine — the outer <insight-card> can wrap
    // arbitrary flow content.
    children: parseBody(bodyMd) as unknown as Paragraph['children']
  }
}

function makeParagraph(lines: string[]): Paragraph {
  return { type: 'paragraph', children: [{ type: 'text', value: lines.join('\n') }] }
}

export function remarkInsight(options: RemarkInsightOptions = {}) {
  const classify = options.classify ?? classifyInsightLine
  return (tree: Root) => {
    const out: RootContent[] = []
    type State = { mode: 'normal' } | { mode: 'inside'; body: string[] }
    let state: State = { mode: 'normal' }

    const flush = (streaming: boolean) => {
      if (state.mode !== 'inside') return
      out.push(makeInsightNode(state.body.join('\n'), streaming))
      state = { mode: 'normal' }
    }

    for (const node of tree.children) {
      if (node.type !== 'paragraph') {
        // Block-level content (code fence, list, heading) inside an
        // in-progress Insight body terminates it. This keeps the parser
        // simple and matches how Insights are actually written in prose.
        if (state.mode === 'inside') flush(false)
        out.push(node)
        continue
      }

      const lines = paragraphToLines(node)

      if (state.mode === 'normal') {
        const openIdx = lines.findIndex((l) => classify(l.trim()) === 'opener')
        if (openIdx === -1) {
          out.push(node)
          continue
        }
        if (openIdx > 0) out.push(makeParagraph(lines.slice(0, openIdx)))
        const rest = lines.slice(openIdx + 1)
        const closeIdx = rest.findIndex((l) => classify(l.trim()) === 'closer')
        if (closeIdx !== -1) {
          state = { mode: 'inside', body: rest.slice(0, closeIdx) }
          flush(false)
          const tail = rest.slice(closeIdx + 1)
          if (tail.length) out.push(makeParagraph(tail))
        } else {
          state = { mode: 'inside', body: rest }
        }
        continue
      }

      // state.mode === 'inside'
      const closeIdx = lines.findIndex((l) => classify(l.trim()) === 'closer')
      if (closeIdx === -1) {
        state.body.push('', ...lines)
      } else {
        state.body.push('', ...lines.slice(0, closeIdx))
        flush(false)
        const tail = lines.slice(closeIdx + 1)
        if (tail.length) out.push(makeParagraph(tail))
      }
    }

    // End of message with no closer seen → streaming Insight.
    if (state.mode === 'inside') flush(true)
    tree.children = out
  }
}
