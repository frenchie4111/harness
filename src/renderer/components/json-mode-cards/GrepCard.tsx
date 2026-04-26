import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'

export function GrepCard({ block, result }: ToolCardProps): JSX.Element {
  const pattern = String(block.input?.pattern ?? '')
  const path = String(block.input?.path ?? '')
  return (
    <ToolCardChrome
      name="Grep"
      subtitle={`/${pattern}/${path ? ` in ${basename(path)}` : ''}`}
      variant="info"
      isError={result?.isError}
    >
      {result && (
        <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-60 overflow-auto opacity-80">
          {trunc(result.content, 3000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
