import { Fragment, useState } from 'react'
import {
  ToolCardChrome,
  extractArgs,
  getToolDisplay,
  isHarnessControl,
  trunc,
  type ArgEntry,
  type ToolCardProps
} from './index'

function CompactSubtitle({ args }: { args: ArgEntry[] }): JSX.Element {
  // Inline key + value pairs, keys italicised + muted so values pop.
  // Lives inside ToolCardChrome's `truncate` span, so we keep nodes
  // inline (no flex/block) to let CSS ellipsis the overflow.
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

function ParsedArgs({ args }: { args: ArgEntry[] }): JSX.Element {
  return (
    <dl className="px-3 py-2 text-xs space-y-2">
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

export function GenericToolCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const brand = isHarnessControl(block.name)
  const display = getToolDisplay(block.name)
  const args = extractArgs(block.input)
  const hasArgs = args.length > 0
  const [viewMode, setViewMode] = useState<'parsed' | 'raw'>('parsed')

  return (
    <ToolCardChrome
      name={display.label}
      subtitle={hasArgs ? <CompactSubtitle args={args} /> : ''}
      variant="info"
      isError={result?.isError}
      brand={brand}
      icon={display.icon}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {hasArgs && (
        <>
          <div className="flex justify-end px-2 pt-1 pb-0">
            <button
              type="button"
              onClick={() => setViewMode((v) => (v === 'parsed' ? 'raw' : 'parsed'))}
              className="text-xs text-muted hover:text-fg cursor-pointer underline-offset-2 hover:underline"
            >
              {viewMode === 'parsed' ? 'show raw' : 'show parsed'}
            </button>
          </div>
          {viewMode === 'parsed' ? (
            <ParsedArgs args={args} />
          ) : (
            <pre className="px-2 py-1 text-xs font-mono bg-app/40 whitespace-pre-wrap max-h-60 overflow-auto">
              {JSON.stringify(block.input, null, 2)}
            </pre>
          )}
        </>
      )}
      {result && (
        <pre
          className={`px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          {trunc(result.content, 3000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
