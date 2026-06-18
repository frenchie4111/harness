import { ToolCardChrome, trunc, type ToolCardProps } from './index'
import { GlobIcon } from './tool-icons'

export function GlobCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const pattern = String(block.input?.pattern ?? '')
  return (
    <ToolCardChrome
      name="Glob"
      subtitle={pattern}
      variant="info"
      icon={GlobIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {result && (
        <pre className="px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto opacity-80">
          {trunc(result.content, 2000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
