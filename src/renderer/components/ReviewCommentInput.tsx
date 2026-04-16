import { useState, useRef, useEffect } from 'react'
import { X } from 'lucide-react'

interface ReviewCommentInputProps {
  lineNumber: number
  onSubmit: (body: string) => void
  onCancel: () => void
}

export function ReviewCommentInput({
  lineNumber,
  onSubmit,
  onCancel
}: ReviewCommentInputProps): JSX.Element {
  const [body, setBody] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (body.trim()) onSubmit(body.trim())
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="flex flex-col gap-1.5 p-2 mx-2 my-1 rounded border border-border-strong bg-panel-raised">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-faint font-mono">Line {lineNumber}</span>
        <button
          onClick={onCancel}
          className="text-faint hover:text-fg transition-colors cursor-pointer"
        >
          <X size={12} />
        </button>
      </div>
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Leave a comment..."
        rows={2}
        className="w-full bg-surface text-fg text-xs rounded border border-border px-2 py-1.5 resize-none focus:outline-none focus:border-accent"
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-faint">⌘Enter to submit</span>
        <button
          onClick={() => {
            if (body.trim()) onSubmit(body.trim())
          }}
          disabled={!body.trim()}
          className="text-[11px] px-2 py-0.5 rounded bg-accent text-fg hover:bg-accent/80 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
        >
          Add Comment
        </button>
      </div>
    </div>
  )
}
