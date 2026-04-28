import { ToolCardChrome, type ToolCardProps } from './index'

interface TodoItem {
  content: string
  status: string
  activeForm?: string
}

export function TodoWriteCard({ block, autoApproved }: ToolCardProps): JSX.Element {
  const todos = (block.input?.todos as TodoItem[] | undefined) ?? []
  return (
    <ToolCardChrome
      name="TodoWrite"
      subtitle={`${todos.length} item${todos.length === 1 ? '' : 's'}`}
      variant="info"
      autoApproved={autoApproved}
    >
      <ul className="px-3 py-2 text-xs space-y-1">
        {todos.map((t, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span
              className={
                t.status === 'completed'
                  ? 'text-success'
                  : t.status === 'in_progress'
                    ? 'text-warning'
                    : 'text-faint'
              }
            >
              {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'}
            </span>
            <span
              className={t.status === 'completed' ? 'line-through opacity-60' : ''}
            >
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </ToolCardChrome>
  )
}
