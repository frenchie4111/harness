import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'

export function ReadCard({ block, result }: ToolCardProps): JSX.Element {
  const fp = String(block.input?.file_path ?? '')
  const offset = Number(block.input?.offset) || 0
  const limit = Number(block.input?.limit) || 0
  const range = offset || limit ? ` (${offset || 1}–${(offset || 1) + limit})` : ''
  return (
    <ToolCardChrome name="Read" subtitle={`${basename(fp)}${range}`} variant="info">
      {fp && <div className="px-2 py-1 text-[10px] text-muted truncate font-mono">{fp}</div>}
      {result && (
        <pre
          className={`px-2 py-1 text-[11px] font-mono whitespace-pre-wrap max-h-72 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          {trunc(result.content, 4000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
