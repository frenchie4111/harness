// Shared key/value rendering for tool input args. Used by
// GenericToolCard (inside the per-tool chrome) and
// JsonClaudeApprovalCard (in the pending-approval body), so the two
// surfaces match: bold-bright keys, muted values, multi-line strings
// in a wrapped code block.

import { Fragment, useState, type ReactNode } from 'react'
import type { ArgEntry } from './tool-display'

/** Inline `key value key value …` for chrome subtitles. Lives inside
 *  a `truncate` parent, so we keep nodes inline (no flex/block) to
 *  let CSS ellipsis the overflow. */
export function CompactArgs({ args }: { args: ArgEntry[] }): JSX.Element {
  return (
    <>
      {args.map((a, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className="font-semibold text-fg-bright">{a.key}</span>{' '}
          <span className="text-muted">{a.value.replace(/\s+/g, ' ')}</span>
        </Fragment>
      ))}
    </>
  )
}

/** Block dl-style view for expanded tool cards / approval bodies.
 *  Multi-line values get a wrapped code block; scalars render inline.
 *  Wrap in a parent that owns padding — this component just renders
 *  the list. */
export function ParsedArgs({ args }: { args: ArgEntry[] }): JSX.Element {
  return (
    <dl className="text-xs space-y-2">
      {args.map((a, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          <dt className="font-semibold text-xs text-fg-bright">{a.key}</dt>
          {a.multiline ? (
            <dd className="font-mono whitespace-pre-wrap bg-app/40 rounded px-2 py-1 max-h-60 overflow-auto text-muted">
              {a.value}
            </dd>
          ) : (
            <dd className="break-words text-muted">{a.value}</dd>
          )}
        </div>
      ))}
    </dl>
  )
}

/** Parsed-by-default args block with a small `show raw` toggle that
 *  flips to JSON.stringify of the original input. The toggle floats
 *  to the right inside `header` (a ReactNode the caller renders
 *  alongside the toggle — useful for matching a sibling header row's
 *  baseline). Pass `rawInput` so the raw view has access to nested
 *  structure that `extractArgs` flattens. */
export function ArgsBlock({
  args,
  rawInput,
  header
}: {
  args: ArgEntry[]
  rawInput: unknown
  header?: ReactNode
}): JSX.Element {
  const [viewMode, setViewMode] = useState<'parsed' | 'raw'>('parsed')
  return (
    <>
      <div className="flex items-center gap-2 px-2 pt-1 pb-0">
        <div className="flex-1 min-w-0">{header}</div>
        <button
          type="button"
          onClick={() => setViewMode((v) => (v === 'parsed' ? 'raw' : 'parsed'))}
          className="text-xs text-muted hover:text-fg cursor-pointer underline-offset-2 hover:underline shrink-0"
        >
          {viewMode === 'parsed' ? 'show raw' : 'show parsed'}
        </button>
      </div>
      {viewMode === 'parsed' ? (
        <div className="px-3 py-2">
          <ParsedArgs args={args} />
        </div>
      ) : (
        <pre className="mx-2 my-1 px-2 py-1 text-xs font-mono bg-app/40 whitespace-pre-wrap max-h-60 overflow-auto rounded">
          {JSON.stringify(rawInput, null, 2)}
        </pre>
      )}
    </>
  )
}
