import { ToolCardChrome, trunc, type ToolCardProps } from './index'
import { BashIcon } from './tool-icons'
import { HighlightedText } from '../JsonModeChatFind'

export function BashCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const cmd = String(block.input?.command ?? '')
  const description = block.input?.description as string | undefined
  return (
    <ToolCardChrome
      id={block.id}
      name="Bash"
      subtitle={trunc(cmd, 80)}
      variant="warn"
      icon={BashIcon}
      isError={result?.isError}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {description && (
        <div className="px-2 py-1 text-xs text-muted">
          <HighlightedText text={description} />
        </div>
      )}
      <pre className="px-2 py-1 text-xs font-mono bg-app/40 whitespace-pre-wrap max-h-32 overflow-auto">
        $ <HighlightedText text={cmd} />
      </pre>
      {result && (
        <pre
          className={`px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-72 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          <HighlightedText text={trunc(result.content, 6000)} />
        </pre>
      )}
    </ToolCardChrome>
  )
}
