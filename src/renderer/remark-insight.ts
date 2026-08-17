// Remark plugin that detects "★ Insight ─────" bracketed blocks in
// assistant messages and rewrites them into a custom `insight-card` node
// so the renderer can present them as collapsible styled cards.
//
// Streaming: when the closing "─────" hasn't arrived yet, the plugin
// still emits the card and marks it `streaming: true`. The card component
// uses that to draw a live "..." indicator until the closer streams in.
//
// WHY THIS SCANS RAW SOURCE INSTEAD OF THE PARSED TREE
//
// "★ Insight ───" is a LINE-oriented marker format. mdast is BLOCK-
// oriented, and the two don't line up. An earlier version walked
// tree.children looking for marker text inside paragraph nodes, which
// broke on the markdown the output style actually emits:
//
//   `★ Insight ─────`          <- backticked, so it's its own paragraph
//   - a bulleted point         <- a `list` node, not a paragraph
//   `─────────────`            <- no blank line above, so CommonMark
//                                 lazy-continuation folds this INTO the
//                                 last list item; it never reaches the
//                                 tree as its own node at all
//
// The walker emitted an empty card, dumped the list outside it, and the
// closer rendered as a stray code span at the end of the last bullet.
// Both failures are structural, so we sidestep them: read the original
// markdown off the VFile, split the Insight out by line, and re-parse
// each segment independently. Body markdown of any shape survives.
//
// Cost: for a message containing an Insight we parse the source twice
// (once by remark before us, once by us in segments). Gated behind a
// no-opener fast path so the common case — no Insight — is free. See
// CLAUDE.md "High-frequency streams" for why that gate matters.
//
// The one thing you need to define is the LINE CLASSIFIER — see
// classifyInsightLine below. The rest is plumbing you shouldn't need to
// touch unless the shape of an Insight body changes.

import type { Root, RootContent, Paragraph } from 'mdast'
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
 * Note: the caller hands you one raw source line, already trimmed of
 * surrounding whitespace and of any wrapping backticks (the output style
 * emits the markers as code spans). Lines inside fenced code blocks never
 * reach you at all. So match the bare marker and nothing else.
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

/** The bit of unified's VFile we need: the original markdown string. */
export interface InsightSource {
  value?: unknown
}

// A marker may arrive wrapped in backticks — the output style's template
// is literally `` `★ Insight ───` ``. Strip surrounding whitespace and
// backticks so the classifier only ever sees the marker itself.
function normalizeMarkerLine(line: string): string {
  return line.trim().replace(/^`+/, '').replace(/`+$/, '').trim()
}

// Opening or closing fence of a code block, at CommonMark's max 3 spaces
// of indent. Captures the run so a closing fence must use the same char.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
// 4+ spaces of indent is an indented code block; markers there aren't
// markers. trimStart() length delta is enough — tabs count as one, which
// under-counts, but a tab-indented marker bar is not a real scenario.
const MAX_MARKER_INDENT = 3

interface ScannedLine {
  kind: InsightLineKind
  /** True when this line opens a fenced code block. */
  opensFence: boolean
}

// Classify every source line, skipping anything inside a fenced code
// block so a bar drawn in an example can't open or close a real card.
function scanLines(lines: string[], classify: (line: string) => InsightLineKind): ScannedLine[] {
  const scanned: ScannedLine[] = []
  let openFence: string | null = null

  for (const line of lines) {
    const fence = FENCE_RE.exec(line)?.[1]
    if (openFence !== null) {
      if (fence && fence[0] === openFence[0] && fence.length >= openFence.length) openFence = null
      scanned.push({ kind: null, opensFence: false })
      continue
    }
    if (fence) {
      openFence = fence
      scanned.push({ kind: null, opensFence: true })
      continue
    }
    const indent = line.length - line.trimStart().length
    const kind = indent > MAX_MARKER_INDENT ? null : classify(normalizeMarkerLine(line))
    scanned.push({ kind, opensFence: false })
  }
  return scanned
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

// Where an unterminated Insight ends: at the first fenced code block, or
// at end of message. A fence with no closer anywhere after it means the
// message moved on to showing code and the author forgot the bar; letting
// the card swallow the rest of the message reads worse than cutting it.
// A closer that DOES arrive later always wins, so a code block inside a
// properly-bracketed Insight stays in the body.
function findInsightEnd(
  scanned: ScannedLine[],
  from: number
): { end: number; resumeAt: number; streaming: boolean } {
  for (let i = from; i < scanned.length; i++) {
    if (scanned[i].kind === 'closer') return { end: i, resumeAt: i + 1, streaming: false }
  }
  for (let i = from; i < scanned.length; i++) {
    if (scanned[i].opensFence) return { end: i, resumeAt: i, streaming: false }
  }
  return { end: scanned.length, resumeAt: scanned.length, streaming: true }
}

export function remarkInsight(options: RemarkInsightOptions = {}) {
  const classify = options.classify ?? classifyInsightLine
  return (tree: Root, file?: InsightSource) => {
    const source = typeof file?.value === 'string' ? file.value : null
    // No source to scan (unexpected caller) → leave the tree alone rather
    // than silently dropping content.
    if (source === null) return

    const lines = source.split('\n')
    const scanned = scanLines(lines, classify)
    // Fast path: the overwhelming majority of messages have no Insight,
    // and this runs on every streamed token. Bail before re-parsing.
    if (!scanned.some((s) => s.kind === 'opener')) return

    const out: RootContent[] = []
    const pushMarkdown = (segment: string[]): void => {
      if (segment.every((l) => l.trim() === '')) return
      out.push(...parseBody(segment.join('\n')))
    }

    let segmentStart = 0
    let i = 0
    while (i < lines.length) {
      if (scanned[i].kind !== 'opener') {
        i++
        continue
      }
      pushMarkdown(lines.slice(segmentStart, i))
      const { end, resumeAt, streaming } = findInsightEnd(scanned, i + 1)
      out.push(makeInsightNode(lines.slice(i + 1, end).join('\n'), streaming))
      segmentStart = resumeAt
      i = resumeAt
    }
    pushMarkdown(lines.slice(segmentStart))

    tree.children = out
  }
}
