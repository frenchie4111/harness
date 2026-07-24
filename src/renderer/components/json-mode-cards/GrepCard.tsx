import { ToolCardChrome, basename, trunc, type ToolCardProps } from './index'
import { GrepIcon } from './tool-icons'

export function GrepCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const pattern = String(block.input?.pattern ?? '')
  const path = String(block.input?.path ?? '')
  return (
    <ToolCardChrome
      name="Grep"
      subtitle={`/${pattern}/${path ? ` in ${basename(path)}` : ''}`}
      variant="info"
      icon={GrepIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {result && (
        <pre className="px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto opacity-80">
          {trunc(result.content, 3000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
