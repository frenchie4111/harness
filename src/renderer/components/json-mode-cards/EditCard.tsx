import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'

export function EditCard({ block, result, autoApproved }: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const oldStr = String(block.input?.old_string ?? '')
  const newStr = String(block.input?.new_string ?? '')
  const oldLines = oldStr ? oldStr.split('\n').length : 0
  const newLines = newStr ? newStr.split('\n').length : 0
  const diffSummary = oldStr || newStr ? ` (+${newLines} −${oldLines})` : ''
  return (
    <ToolCardChrome
      name="Edit"
      subtitle={`${basename(fp)}${diffSummary}`}
      variant="warn"
      isError={result?.isError}
      autoApproved={autoApproved}
    >
      {fp && <div className="px-2 py-1 text-[10px] text-muted truncate font-mono">{fp}</div>}
      <div className="px-2 py-1 text-[11px] font-mono">
        <pre className="bg-danger/10 text-danger/80 rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto">
          {trunc(oldStr, 1500)}
        </pre>
        <pre className="bg-success/10 text-success/80 rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto mt-1">
          {trunc(newStr, 1500)}
        </pre>
      </div>
      {result && result.isError && (
        <pre className="px-2 py-1 text-[11px] font-mono text-danger whitespace-pre-wrap">
          {trunc(result.content, 1000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
