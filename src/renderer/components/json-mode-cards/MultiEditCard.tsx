import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'
import { UnifiedDiff } from './UnifiedDiff'

interface RawEdit {
  old_string?: unknown
  new_string?: unknown
}

export function MultiEditCard({
  block,
  result,
  autoApproved,
  sessionAllowed
}: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const rawEdits = Array.isArray(block.input?.edits)
    ? (block.input?.edits as RawEdit[])
    : []
  const edits = rawEdits.map((e) => ({
    oldStr: String(e?.old_string ?? ''),
    newStr: String(e?.new_string ?? '')
  }))

  return (
    <ToolCardChrome
      name="MultiEdit"
      subtitle={`${basename(fp)} (${edits.length} edit${edits.length === 1 ? '' : 's'})`}
      variant="warn"
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {fp && <div className="px-2 py-1 text-[10px] text-muted truncate font-mono">{fp}</div>}
      {edits.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-muted italic">No edits.</div>
      ) : (
        edits.map((e, i) => (
          <div key={i}>
            <div className="px-2 py-0.5 text-[10px] text-muted bg-app/30 border-y border-border/30">
              Edit {i + 1} of {edits.length}
            </div>
            <UnifiedDiff oldStr={e.oldStr} newStr={e.newStr} filePath={fp} />
          </div>
        ))
      )}
      {result && result.isError && (
        <pre className="px-2 py-1 text-[11px] font-mono text-danger whitespace-pre-wrap">
          {trunc(result.content, 1000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
