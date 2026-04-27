import { ToolCardChrome, trunc, type ToolCardProps } from './index'

export function GlobCard({ block, result }: ToolCardProps): JSX.Element {
  const pattern = String(block.input?.pattern ?? '')
  return (
    <ToolCardChrome
      name="Glob"
      subtitle={pattern}
      variant="info"
      isError={result?.isError}
    >
      {result && (
        <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-60 overflow-auto opacity-80">
          {trunc(result.content, 2000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
