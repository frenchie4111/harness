import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'

/** Global registry so hotkeys can focus terminals without prop-drilling refs */
const terminalRegistry = new Map<string, Terminal>()
/** Serialize addons keyed by terminal id, so we can flush all on window unload */
const serializeRegistry = new Map<string, SerializeAddon>()
/** Ids whose history is being cleared — suppress saves from pending intervals
 * and the window beforeunload flush so we don't resurrect deleted history. */
const closingIds = new Set<string>()

export function focusTerminalById(id: string): void {
  terminalRegistry.get(id)?.focus()
}

/** Mark a terminal as closing: stop saving its history and clear any
 * already-persisted history file. Call this before removing the tab. */
export function markTerminalClosing(id: string): void {
  closingIds.add(id)
  window.api.clearTerminalHistory(id)
}

/** Flush every live terminal's scrollback to disk. Called on window unload —
 * uses the sync IPC variant so writes complete before the window closes. */
export function flushAllTerminalHistory(): void {
  for (const [id, addon] of serializeRegistry) {
    if (closingIds.has(id)) continue
    try {
      window.api.saveTerminalHistorySync(id, addon.serialize())
    } catch {
      // ignore
    }
  }
}

interface XTerminalProps {
  terminalId: string
  cwd: string
  type: 'claude' | 'shell'
  visible: boolean
  claudeCommand: string
}

export function XTerminal({ terminalId, cwd, type, visible, claudeCommand }: XTerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const visibleRef = useRef(visible)
  const initializedRef = useRef(false)

  // Keep ref in sync so the ResizeObserver callback sees current value
  visibleRef.current = visible

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return
    initializedRef.current = true

    // Pull background/foreground from the active app theme so the terminal
    // blends into the panel it's embedded in. xterm.js only accepts literal
    // color strings, so we read the resolved CSS variables at init time.
    const rootStyle = getComputedStyle(document.documentElement)
    const bg = rootStyle.getPropertyValue('--color-app').trim() || '#0a0a0a'
    const fg = rootStyle.getPropertyValue('--color-fg-bright').trim() || '#e5e5e5'

    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace",
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      theme: {
        background: bg,
        foreground: fg,
        cursor: fg,
        selectionBackground: '#33415580',
        black: bg,
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: fg,
        brightBlack: '#525252',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa'
      }
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    const serializeAddon = new SerializeAddon()
    terminal.loadAddon(serializeAddon)

    terminal.open(containerRef.current)

    requestAnimationFrame(() => {
      fitAddon.fit()
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    terminalRegistry.set(terminalId, terminal)
    serializeRegistry.set(terminalId, serializeAddon)

    // Restore scrollback (if any) before spawning the PTY so historical output
    // appears above the fresh shell's prompt.
    let cleanupData: (() => void) | null = null
    let disposed = false

    const spawnPty = (): void => {
      if (disposed) return
      const shell = '/bin/zsh'
      const args = type === 'claude' ? ['-ilc', claudeCommand] : ['-il']
      window.api.createTerminal(terminalId, cwd, shell, args)

      terminal.onData((data) => {
        window.api.writeTerminal(terminalId, data)
      })

      cleanupData = window.api.onTerminalData((id, data) => {
        if (id === terminalId) {
          terminal.write(data)
        }
      })
    }

    window.api.loadTerminalHistory(terminalId).then((history) => {
      if (disposed) return
      if (history) {
        terminal.write(history)
        // Visual separator between restored history and the fresh shell session
        terminal.write('\r\n\x1b[2m── session restored ──\x1b[0m\r\n')
      }
      spawnPty()
    }).catch(() => {
      spawnPty()
    })

    // Handle resize — only fit when actually visible
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      const w = Math.round(entry?.contentRect.width ?? 0)
      const h = Math.round(entry?.contentRect.height ?? 0)
      console.log(`[xterm] ResizeObserver id=${terminalId} visible=${visibleRef.current} size=${w}x${h}`)
      if (!visibleRef.current) return
      if (!entry || w === 0 || h === 0) return
      requestAnimationFrame(() => {
        if (!fitAddonRef.current) return
        fitAddonRef.current.fit()
        const dims = fitAddonRef.current.proposeDimensions()
        if (dims) {
          console.log(`[xterm] ResizeObserver fit id=${terminalId} cols=${dims.cols} rows=${dims.rows}`)
          window.api.resizeTerminal(terminalId, dims.cols, dims.rows)
        }
      })
    })
    resizeObserver.observe(containerRef.current)

    // Periodic snapshot so a crash doesn't lose too much scrollback
    const snapshotInterval = setInterval(() => {
      if (closingIds.has(terminalId)) return
      try {
        window.api.saveTerminalHistory(terminalId, serializeAddon.serialize())
      } catch {
        // ignore
      }
    }, 30_000)

    return () => {
      disposed = true
      // NOTE: intentionally do NOT save here. Unmount happens on both
      // tab-close (history should be cleared) and app-quit (history is
      // flushed via beforeunload). Saving here would race with
      // clearTerminalHistory on close.
      clearInterval(snapshotInterval)
      terminalRegistry.delete(terminalId)
      serializeRegistry.delete(terminalId)
      closingIds.delete(terminalId)
      resizeObserver.disconnect()
      cleanupData?.()
      terminal.dispose()
      window.api.killTerminal(terminalId)
    }
  }, [terminalId, cwd, type])

  // Re-fit when the terminal becomes visible
  useEffect(() => {
    if (!visible || !fitAddonRef.current || !containerRef.current) return

    const doFit = (reason: string): void => {
      if (!fitAddonRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      console.log(`[xterm] doFit reason=${reason} id=${terminalId} rect=${Math.round(rect.width)}x${Math.round(rect.height)}`)
      if (rect.width === 0 || rect.height === 0) return
      fitAddonRef.current.fit()
      const dims = fitAddonRef.current.proposeDimensions()
      if (dims) {
        console.log(`[xterm] resize id=${terminalId} cols=${dims.cols} rows=${dims.rows}`)
        window.api.resizeTerminal(terminalId, dims.cols, dims.rows)
      }
    }

    // Multiple passes to handle layout settling after display:none removal
    requestAnimationFrame(() => doFit('visible-raf'))
    const t1 = setTimeout(() => doFit('visible-50ms'), 50)
    const t2 = setTimeout(() => doFit('visible-150ms'), 150)

    const onFocus = (): void => doFit('window-focus')
    const onVisChange = (): void => doFit('visibility-change')
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisChange)

    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisChange)
    }
  }, [visible, terminalId])

  return <div ref={containerRef} className="w-full h-full" />
}
