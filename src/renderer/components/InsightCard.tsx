// Collapsible card that renders "★ Insight ─────" blocks emitted by
// remark-insight. Expanded by default; the header toggles it. While the
// insight is still streaming from Claude (closer bar hasn't arrived) we
// show a blinking "…" so it's clear more content is coming.

import { useState, type ReactNode } from 'react'

interface InsightCardProps {
  children?: ReactNode
  // Value comes through hast property forwarding; the source is a JS
  // boolean set in remark-insight's hProperties, but rehype may serialize
  // it as the string "true" depending on the react-markdown version.
  // Accept both and coerce.
  streaming?: boolean | string
}

export function InsightCard({ children, streaming }: InsightCardProps) {
  const [expanded, setExpanded] = useState(true)
  const isStreaming = streaming === true || streaming === 'true'
  return (
    <div className={`insight-card ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      <button
        type="button"
        className="insight-card-header"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="insight-card-star" aria-hidden>★</span>
        <span className="insight-card-label">Insight</span>
        <span className="insight-card-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="insight-card-body markdown">
          {children}
          {isStreaming && (
            <span className="insight-card-streaming" aria-label="more coming">…</span>
          )}
        </div>
      )}
    </div>
  )
}
