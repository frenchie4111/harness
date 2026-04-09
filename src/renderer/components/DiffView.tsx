import { useState, useEffect } from 'react'

interface DiffViewProps {
  worktreePath: string
  filePath: string
  staged: boolean
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  content: string
  oldLine?: number
  newLine?: number
}

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of raw.split('\n')) {
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      lines.push({ type: 'header', content: line })
    } else if (line.startsWith('@@')) {
      // Parse hunk header: @@ -old,count +new,count @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
      }
      lines.push({ type: 'hunk', content: line })
    } else if (line.startsWith('+')) {
      lines.push({ type: 'add', content: line.slice(1), newLine })
      newLine++
    } else if (line.startsWith('-')) {
      lines.push({ type: 'remove', content: line.slice(1), oldLine })
      oldLine++
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'context', content: line.slice(1), oldLine, newLine })
      oldLine++
      newLine++
    }
  }

  return lines
}

const LINE_STYLES: Record<DiffLine['type'], string> = {
  add: 'bg-green-950/40 text-green-300',
  remove: 'bg-red-950/40 text-red-300',
  context: 'text-neutral-400',
  header: 'text-neutral-500 italic',
  hunk: 'text-blue-400 bg-blue-950/20'
}

const GUTTER_STYLES: Record<DiffLine['type'], string> = {
  add: 'text-green-700',
  remove: 'text-red-700',
  context: 'text-neutral-700',
  header: '',
  hunk: 'text-blue-800'
}

export function DiffView({ worktreePath, filePath, staged }: DiffViewProps): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.getFileDiff(worktreePath, filePath, staged).then((result) => {
      if (!cancelled) {
        setDiff(result)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [worktreePath, filePath, staged])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
        Loading diff...
      </div>
    )
  }

  if (!diff) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
        No diff available
      </div>
    )
  }

  const lines = parseDiff(diff)

  return (
    <div className="h-full overflow-auto bg-[#0a0a0a]">
      <div className="font-mono text-xs leading-5 min-w-fit">
        {lines.map((line, i) => (
          <div key={i} className={`flex ${LINE_STYLES[line.type]}`}>
            {/* Gutter */}
            <span className={`shrink-0 w-10 text-right pr-2 select-none ${GUTTER_STYLES[line.type]}`}>
              {line.type === 'add' || line.type === 'context' ? line.newLine : ''}
            </span>
            <span className={`shrink-0 w-10 text-right pr-2 select-none border-r border-neutral-800/50 ${GUTTER_STYLES[line.type]}`}>
              {line.type === 'remove' || line.type === 'context' ? line.oldLine : ''}
            </span>
            {/* Sign */}
            <span className="shrink-0 w-5 text-center select-none">
              {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ''}
            </span>
            {/* Content */}
            <span className="whitespace-pre pr-4">{line.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
