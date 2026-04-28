import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'

export function WriteCard({ block, result, autoApproved }: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const content = String(block.input?.content ?? '')
  return (
    <ToolCardChrome
      name="Write"
      subtitle={basename(fp)}
      variant="warn"
      isError={result?.isError}
      autoApproved={autoApproved}
    >
      {fp && <div className="px-2 py-1 text-[10px] text-muted truncate font-mono">{fp}</div>}
      <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-60 overflow-auto bg-app/40">
        {trunc(content, 4000)}
      </pre>
      {result && result.isError && (
        <pre className="px-2 py-1 text-[11px] font-mono text-danger whitespace-pre-wrap">
          {trunc(result.content, 1000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
