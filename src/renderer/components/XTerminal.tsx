import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/** Global registry so hotkeys can focus terminals without prop-drilling refs */
const terminalRegistry = new Map<string, Terminal>()

export function focusTerminalById(id: string): void {
  terminalRegistry.get(id)?.focus()
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

    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace",
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      theme: {
        background: '#0a0a0a',
        foreground: '#e5e5e5',
        cursor: '#e5e5e5',
        selectionBackground: '#33415580',
        black: '#0a0a0a',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e5e5e5',
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

    terminal.open(containerRef.current)

    requestAnimationFrame(() => {
      fitAddon.fit()
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    terminalRegistry.set(terminalId, terminal)

    // Spawn the PTY
    const shell = '/bin/zsh'
    const args = type === 'claude' ? ['-ilc', claudeCommand] : ['-il']
    window.api.createTerminal(terminalId, cwd, shell, args)

    terminal.onData((data) => {
      window.api.writeTerminal(terminalId, data)
    })

    const cleanupData = window.api.onTerminalData((id, data) => {
      if (id === terminalId) {
        terminal.write(data)
      }
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

    return () => {
      terminalRegistry.delete(terminalId)
      resizeObserver.disconnect()
      cleanupData()
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
