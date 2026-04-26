import { ToolCardChrome, trunc, type ToolCardProps } from './index'

export function GenericToolCard({ block, result }: ToolCardProps): JSX.Element {
  const summary = block.input ? trunc(JSON.stringify(block.input), 100) : ''
  return (
    <ToolCardChrome
      name={block.name || 'Tool'}
      subtitle={summary}
      variant="info"
      isError={result?.isError}
    >
      {block.input && (
        <pre className="px-2 py-1 text-[11px] font-mono bg-app/40 whitespace-pre-wrap max-h-40 overflow-auto">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
      {result && (
        <pre
          className={`px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-60 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          {trunc(result.content, 3000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
