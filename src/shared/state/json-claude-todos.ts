import type { JsonClaudeSession } from './json-claude'

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export function extractTodos(
  input: Record<string, unknown> | undefined
): TodoItem[] {
  return (input?.todos as TodoItem[] | undefined) ?? []
}

export function getLatestTodos(
  session: JsonClaudeSession | null | undefined
): TodoItem[] | null {
  if (!session) return null
  const entries = session.entries
  for (let i = entries.length - 1; i >= 0; i--) {
    const blocks = entries[i].blocks
    if (!blocks) continue
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]
      if (b.type === 'tool_use' && b.name === 'TodoWrite') {
        return extractTodos(b.input)
      }
    }
  }
  return null
}
