import { ToolCardChrome, trunc, type ToolCardProps } from './index'

export function BashCard({ block, result }: ToolCardProps): JSX.Element {
  const cmd = String(block.input?.command ?? '')
  const description = block.input?.description as string | undefined
  return (
    <ToolCardChrome
      name="Bash"
      subtitle={trunc(cmd, 80)}
      variant="warn"
      isError={result?.isError}
    >
      {description && <div className="px-2 py-1 text-[11px] text-muted">{description}</div>}
      <pre className="px-2 py-1 text-[11px] font-mono bg-app/40 whitespace-pre-wrap max-h-32 overflow-auto">
        $ {cmd}
      </pre>
      {result && (
        <pre
          className={`px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-72 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          {trunc(result.content, 6000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
