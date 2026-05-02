import { useJsonClaudeSession } from '../store'
import { getLatestTodos } from '../../shared/state/json-claude-todos'
import { RightPanel } from './RightPanel'

interface JsonClaudeTodosPanelProps {
  focusedTabId: string | null
}

export function JsonClaudeTodosPanel({
  focusedTabId
}: JsonClaudeTodosPanelProps): JSX.Element | null {
  const session = useJsonClaudeSession(focusedTabId ?? '')
  const todos = getLatestTodos(session)
  if (!todos || todos.length === 0) return null

  const remaining = todos.filter((t) => t.status !== 'completed').length

  return (
    <RightPanel
      id="todos"
      title="Todos"
      actions={
        <span className="text-[10px] text-faint tabular-nums">
          {remaining}/{todos.length}
        </span>
      }
    >
      <ul className="px-3 py-2 text-xs space-y-1 overflow-y-auto">
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
              className={
                t.status === 'completed'
                  ? 'line-through opacity-60'
                  : t.status === 'in_progress'
                    ? 'text-fg-bright'
                    : 'text-fg'
              }
            >
              {t.content}
            </span>
          </li>
        ))}
      </ul>
    </RightPanel>
  )
}
