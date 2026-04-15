import { useEffect, useMemo, useRef, useState } from 'react'

interface JsonModeChatProps {
  terminalId: string
  worktreePath: string
}

type ChatEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-use'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool-result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }

interface StreamEvent {
  type?: string
  subtype?: string
  message?: {
    role?: string
    content?: Array<Record<string, unknown>>
  }
  error?: string
  text?: string
}

function renderInlineMarkdown(text: string): JSX.Element[] {
  // minimalist: bold **x**, code `x`
  const parts: Array<JSX.Element | string> = []
  let rest = text
  let i = 0
  while (rest.length) {
    const b = rest.match(/\*\*([^*]+)\*\*/)
    const c = rest.match(/`([^`]+)`/)
    const first = [b, c]
      .filter((m): m is RegExpMatchArray => !!m)
      .sort((a, z) => (a.index ?? 0) - (z.index ?? 0))[0]
    if (!first) {
      parts.push(rest)
      break
    }
    const idx = first.index ?? 0
    if (idx > 0) parts.push(rest.slice(0, idx))
    if (first === b) {
      parts.push(<strong key={i++}>{first[1]}</strong>)
    } else {
      parts.push(
        <code key={i++} className="px-1 py-0.5 bg-black/20 rounded text-xs">
          {first[1]}
        </code>
      )
    }
    rest = rest.slice(idx + first[0].length)
  }
  return parts.map((p, k) => (typeof p === 'string' ? <span key={k}>{p}</span> : p))
}

function renderMarkdown(text: string): JSX.Element {
  const lines = text.split('\n')
  const out: JSX.Element[] = []
  let inCode = false
  let codeBuf: string[] = []
  lines.forEach((line, idx) => {
    if (line.startsWith('```')) {
      if (inCode) {
        out.push(
          <pre
            key={`c${idx}`}
            className="bg-black/30 rounded p-2 my-2 text-xs overflow-x-auto"
          >
            <code>{codeBuf.join('\n')}</code>
          </pre>
        )
        codeBuf = []
        inCode = false
      } else {
        inCode = true
      }
      return
    }
    if (inCode) {
      codeBuf.push(line)
      return
    }
    if (line.startsWith('# ')) {
      out.push(
        <h1 key={idx} className="text-lg font-bold mt-2">
          {line.slice(2)}
        </h1>
      )
    } else if (line.startsWith('## ')) {
      out.push(
        <h2 key={idx} className="text-base font-semibold mt-2">
          {line.slice(3)}
        </h2>
      )
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      out.push(
        <li key={idx} className="ml-4 list-disc">
          {renderInlineMarkdown(line.slice(2))}
        </li>
      )
    } else if (line.trim() === '') {
      out.push(<div key={idx} className="h-2" />)
    } else {
      out.push(
        <p key={idx} className="leading-relaxed">
          {renderInlineMarkdown(line)}
        </p>
      )
    }
  })
  if (inCode && codeBuf.length) {
    out.push(
      <pre key="tail" className="bg-black/30 rounded p-2 my-2 text-xs overflow-x-auto">
        <code>{codeBuf.join('\n')}</code>
      </pre>
    )
  }
  return <div>{out}</div>
}

function ToolCard({
  name,
  input,
  result
}: {
  name: string
  input: unknown
  result?: { content: string; isError: boolean }
}): JSX.Element {
  const summary = useMemo(() => {
    if (name === 'Read' && typeof input === 'object' && input) {
      const fp = (input as Record<string, unknown>).file_path
      return typeof fp === 'string' ? fp.split('/').slice(-2).join('/') : ''
    }
    if (name === 'Bash' && typeof input === 'object' && input) {
      const cmd = (input as Record<string, unknown>).command
      return typeof cmd === 'string' ? cmd : ''
    }
    return JSON.stringify(input).slice(0, 80)
  }, [name, input])

  return (
    <div className="border border-border rounded my-2 bg-panel">
      <div className="px-2 py-1 text-xs flex items-center gap-2 border-b border-border">
        <span className="font-mono font-semibold text-accent">{name}</span>
        <span className="opacity-70 truncate">{summary}</span>
      </div>
      {result && (
        <pre
          className={`px-2 py-1 text-xs font-mono whitespace-pre-wrap max-h-48 overflow-y-auto ${
            result.isError ? 'text-red-400' : 'opacity-80'
          }`}
        >
          {result.content.slice(0, 2000)}
          {result.content.length > 2000 ? '\n…' : ''}
        </pre>
      )}
    </div>
  )
}

export function JsonModeChat({ terminalId, worktreePath }: JsonModeChatProps): JSX.Element {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (started) return
    window.api.startJsonClaude(terminalId, worktreePath)
    setStarted(true)
    return () => {
      window.api.killJsonClaude(terminalId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, worktreePath])

  useEffect(() => {
    const unsub = window.api.onJsonClaudeEvent((id, raw) => {
      if (id !== terminalId) return
      const ev = raw as StreamEvent
      setEntries((prev) => {
        const next = [...prev]
        if (ev.type === 'system' && ev.subtype === 'init') {
          next.push({ kind: 'system', text: 'session started' })
        } else if (ev.type === 'assistant') {
          const content = ev.message?.content || []
          for (const c of content) {
            const ct = (c as Record<string, unknown>).type
            if (ct === 'text') {
              const t = (c as Record<string, unknown>).text
              if (typeof t === 'string') next.push({ kind: 'assistant-text', text: t })
            } else if (ct === 'tool_use') {
              next.push({
                kind: 'tool-use',
                toolUseId: String((c as Record<string, unknown>).id || ''),
                name: String((c as Record<string, unknown>).name || ''),
                input: (c as Record<string, unknown>).input
              })
            }
          }
        } else if (ev.type === 'user') {
          const content = ev.message?.content
          if (Array.isArray(content)) {
            for (const c of content) {
              const ct = (c as Record<string, unknown>).type
              if (ct === 'tool_result') {
                const tuid = String((c as Record<string, unknown>).tool_use_id || '')
                const rawContent = (c as Record<string, unknown>).content
                const text =
                  typeof rawContent === 'string'
                    ? rawContent
                    : Array.isArray(rawContent)
                    ? rawContent
                        .map((p) =>
                          typeof p === 'object' && p && 'text' in p
                            ? String((p as Record<string, unknown>).text)
                            : ''
                        )
                        .join('\n')
                    : JSON.stringify(rawContent)
                next.push({
                  kind: 'tool-result',
                  toolUseId: tuid,
                  content: text,
                  isError: !!(c as Record<string, unknown>).is_error
                })
              }
            }
          }
        } else if (ev.type === 'result') {
          setBusy(false)
        } else if (ev.type === 'harness_error' || ev.type === 'harness_exit') {
          next.push({
            kind: 'error',
            text:
              ev.type === 'harness_exit'
                ? 'claude process exited'
                : String(ev.error || 'error')
          })
          setBusy(false)
        }
        return next
      })
    })
    return unsub
  }, [terminalId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries])

  function send(): void {
    const text = input.trim()
    if (!text || busy) return
    setEntries((prev) => [...prev, { kind: 'user', text }])
    setInput('')
    setBusy(true)
    window.api.sendJsonClaudeMessage(terminalId, text)
  }

  // Merge tool-use + tool-result pairs for rendering.
  const renderedEntries = useMemo(() => {
    const results = new Map<string, ChatEntry & { kind: 'tool-result' }>()
    for (const e of entries) {
      if (e.kind === 'tool-result') results.set(e.toolUseId, e)
    }
    return entries.filter((e) => e.kind !== 'tool-result').map((e) => {
      if (e.kind === 'tool-use') {
        const r = results.get(e.toolUseId)
        return { entry: e, result: r }
      }
      return { entry: e }
    })
  }, [entries])

  return (
    <div className="absolute inset-0 flex flex-col bg-app text-fg">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm"
      >
        {renderedEntries.map((r, idx) => {
          const e = r.entry
          if (e.kind === 'user') {
            return (
              <div key={idx} className="flex justify-end">
                <div className="max-w-[80%] bg-accent/20 rounded px-3 py-2 whitespace-pre-wrap">
                  {e.text}
                </div>
              </div>
            )
          }
          if (e.kind === 'assistant-text') {
            return (
              <div key={idx} className="max-w-[90%]">
                {renderMarkdown(e.text)}
              </div>
            )
          }
          if (e.kind === 'tool-use') {
            return (
              <ToolCard
                key={idx}
                name={e.name}
                input={e.input}
                result={
                  'result' in r && r.result
                    ? { content: r.result.content, isError: r.result.isError }
                    : undefined
                }
              />
            )
          }
          if (e.kind === 'system') {
            return (
              <div key={idx} className="text-xs opacity-50 italic">
                {e.text}
              </div>
            )
          }
          if (e.kind === 'error') {
            return (
              <div key={idx} className="text-xs text-red-400">
                {e.text}
              </div>
            )
          }
          return null
        })}
        {busy && <div className="text-xs opacity-50 italic">thinking…</div>}
      </div>
      <div className="border-t border-border p-2 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Message Claude… (Enter to send, Shift+Enter for newline)"
          className="flex-1 bg-panel border border-border rounded px-2 py-1 text-sm resize-none outline-none focus:border-accent"
          rows={3}
          disabled={busy}
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="px-3 py-1 bg-accent text-white rounded text-sm disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  )
}
