import {
  ToolCardChrome,
  extractArgs,
  getToolDisplay,
  isHarnessControl,
  trunc,
  type ToolCardProps
} from './index'
import { ArgsBlock, CompactArgs } from './ArgsDisplay'

export function GenericToolCard({ block, result, autoApproved, sessionAllowed }: ToolCardProps): JSX.Element {
  const brand = isHarnessControl(block.name)
  const display = getToolDisplay(block.name)
  const args = extractArgs(block.input)
  const hasArgs = args.length > 0

  return (
    <ToolCardChrome
      name={display.label}
      subtitle={hasArgs ? <CompactArgs args={args} /> : ''}
      variant="info"
      isError={result?.isError}
      brand={brand}
      icon={display.icon}
      autoApproved={autoApproved}
      sessionAllowed={sessionAllowed}
    >
      {hasArgs && <ArgsBlock args={args} rawInput={block.input} />}
      {result && (
        <pre
          className={`px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-auto ${
            result.isError ? 'text-danger' : 'opacity-80'
          }`}
        >
          {trunc(result.content, 3000)}
        </pre>
      )}
    </ToolCardChrome>
  )
}
