import { useEffect, useRef, useState } from 'react'

/** Rolling per-terminal "last few lines of output" cache for the
 * CommandCenter preview. Taps the terminal:data stream the main process
 * already broadcasts; buffers chunks in a ref and flushes a derived state
 * map every 500ms so we don't re-render the world on every PTY byte.
 *
 * Returns the latest tail-line map keyed by terminal id. Strips ANSI
 * escape sequences and box-drawing characters, drops lines that are
 * mostly whitespace, and keeps the last 4 meaningful lines per terminal
 * truncated to 240 characters each. */
export function useTailLineBuffer(): Record<string, string> {
  const [tailLines, setTailLines] = useState<Record<string, string>>({})
  const tailBuffersRef = useRef<Record<string, string>>({})
  const tailDirtyRef = useRef(false)

  useEffect(() => {
    const stripAnsi = (s: string): string =>
      // eslint-disable-next-line no-control-regex
      s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')

    const cleanup = window.api.onTerminalData((id, data) => {
      const prev = tailBuffersRef.current[id] || ''
      const next = (prev + data).slice(-4096)
      tailBuffersRef.current[id] = next
      tailDirtyRef.current = true
    })

    const flush = setInterval(() => {
      if (!tailDirtyRef.current) return
      tailDirtyRef.current = false
      const out: Record<string, string> = {}
      const isMeaningful = (line: string): boolean => {
        const stripped = line.replace(/[\u2500-\u257F\u2580-\u259F]/g, '')
        const wordChars = stripped.match(/[\p{L}\p{N}]/gu)
        return !!wordChars && wordChars.length >= 3
      }
      for (const [id, buf] of Object.entries(tailBuffersRef.current)) {
        const stripped = stripAnsi(buf).replace(/\r/g, '')
        const lines = stripped
          .split('\n')
          .map((l) => l.replace(/[\u2500-\u257F\u2580-\u259F]+/g, ' ').replace(/\s+/g, ' ').trim())
          .filter(isMeaningful)
        const last = lines.slice(-4).map((l) => l.slice(0, 240))
        out[id] = last.join('\n')
      }
      setTailLines(out)
    }, 500)

    return () => {
      cleanup()
      clearInterval(flush)
    }
  }, [])

  return tailLines
}
