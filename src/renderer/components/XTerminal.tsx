import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'

function ClaudeLoader() {
  return (
    <div className="claude-loader" aria-label="Starting Claude">
      <div className="claude-loader-halo" />
      <div className="claude-loader-pulser">
        <div className="claude-loader-rotator">
          <svg viewBox="0 0 56 56" width="56" height="56">
            <defs>
              <linearGradient id="claudeLoaderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#f59e0b" />
                <stop offset="55%" stopColor="#ef4444" />
                <stop offset="100%" stopColor="#a855f7" />
              </linearGradient>
            </defs>
            <g fill="url(#claudeLoaderGrad)" transform="translate(28 28)">
              {[0, 45, 90, 135].map((deg) => (
                <path
                  key={deg}
                  d="M 0 -24 Q 3 0 0 24 Q -3 0 0 -24 Z"
                  transform={`rotate(${deg})`}
                />
              ))}
            </g>
          </svg>
        </div>
      </div>
    </div>
  )
}

const DEFAULT_TERMINAL_FONT_FAMILY =
  "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace"
const DEFAULT_TERMINAL_FONT_SIZE = 13

/** Global registry so hotkeys can focus terminals without prop-drilling refs */
const terminalRegistry = new Map<string, Terminal>()
/** Fit addons keyed by terminal id, so font-change listeners can refit. */
const fitRegistry = new Map<string, FitAddon>()
/** Serialize addons keyed by terminal id, so we can flush all on window unload */
const serializeRegistry = new Map<string, SerializeAddon>()
/** Ids whose history is being cleared — suppress saves from pending intervals
 * and the window beforeunload flush so we don't resurrect deleted history. */
const closingIds = new Set<string>()

export function focusTerminalById(id: string): void {
  terminalRegistry.get(id)?.focus()
}

/** Live cache of terminal font settings. Hydrated once at module load and
 * kept in sync via main-process broadcasts so newly created terminals open
 * with the user's chosen values without any prop drilling. */
let currentFontFamily = DEFAULT_TERMINAL_FONT_FAMILY
let currentFontSize = DEFAULT_TERMINAL_FONT_SIZE

function applyFontToAll(): void {
  for (const [id, term] of terminalRegistry) {
    term.options.fontFamily = currentFontFamily
    term.options.fontSize = currentFontSize
    const fit = fitRegistry.get(id)
    if (!fit) continue
    try {
      fit.fit()
      const dims = fit.proposeDimensions()
      if (dims) window.api.resizeTerminal(id, dims.cols, dims.rows)
    } catch {
      // ignore — terminal may not be visible
    }
  }
}

void window.api.getTerminalFontFamily().then((v) => {
  currentFontFamily = v || DEFAULT_TERMINAL_FONT_FAMILY
  applyFontToAll()
})
void window.api.getTerminalFontSize().then((v) => {
  currentFontSize = v || DEFAULT_TERMINAL_FONT_SIZE
  applyFontToAll()
})
window.api.onTerminalFontFamilyChanged((v) => {
  currentFontFamily = v || DEFAULT_TERMINAL_FONT_FAMILY
  applyFontToAll()
})
window.api.onTerminalFontSizeChanged((v) => {
  currentFontSize = v || DEFAULT_TERMINAL_FONT_SIZE
  applyFontToAll()
})

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
  sessionName?: string
  sessionId?: string
  initialPrompt?: string
  teleportSessionId?: string
  onRestartClaude?: () => void
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export function XTerminal({ terminalId, cwd, type, visible, claudeCommand, sessionName, sessionId, initialPrompt, teleportSessionId, onRestartClaude }: XTerminalProps): JSX.Element {
  const [exited, setExited] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [loading, setLoading] = useState(type === 'claude')
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
      fontSize: currentFontSize,
      fontFamily: currentFontFamily,
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

    // Translate Shift+Enter into "backslash + Enter" (\\\r). By default xterm
    // sends bare \r for both Enter and Shift+Enter, so Claude Code can't tell
    // them apart and treats Shift+Enter as submit. Sending `\` then Enter
    // matches Claude Code's documented line-continuation pattern and inserts
    // a newline regardless of cursor position.
    terminal.attachCustomKeyEventHandler((e) => {
      if (
        e.type === 'keydown' &&
        e.key === 'Enter' &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        e.stopPropagation()
        window.api.writeTerminal(terminalId, '\\\r')
        return false
      }
      return true
    })

    terminal.open(containerRef.current)

    requestAnimationFrame(() => {
      fitAddon.fit()
    })

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    terminalRegistry.set(terminalId, terminal)
    serializeRegistry.set(terminalId, serializeAddon)
    fitRegistry.set(terminalId, fitAddon)

    // Restore scrollback (if any) before spawning the PTY so historical output
    // appears above the fresh shell's prompt.
    let cleanupData: (() => void) | null = null
    let cleanupExit: (() => void) | null = null
    let disposed = false

    if (type === 'claude') {
      cleanupExit = window.api.onTerminalExit((id) => {
        if (id === terminalId && !disposed) setExited(true)
      })
    }

    const buildClaudeArg = async (): Promise<string> => {
      const mcpPath = await window.api.prepareMcpForTerminal(terminalId)
      const mcpFlag = mcpPath ? ` --mcp-config ${shellQuote(mcpPath)}` : ''
      const nameFlag = sessionName ? ` --name ${shellQuote(sessionName)}` : ''
      const cmd = `${claudeCommand}${mcpFlag}${nameFlag}`
      if (teleportSessionId && sessionId) {
        // If the session file already exists (e.g. user restarted the tab
        // after teleport already replayed history), fall through to the
        // regular --resume path — re-running --teleport would hit
        // "Session ID is already in use".
        const exists = await window.api.claudeSessionFileExists(cwd, sessionId)
        if (!exists) {
          return `${cmd} --teleport ${teleportSessionId} --session-id ${sessionId}`
        }
      }
      if (!sessionId) {
        return initialPrompt ? `${cmd} ${shellQuote(initialPrompt)}` : cmd
      }
      // If a session file already exists for this id, resume it; otherwise
      // create a new session with this id. `claude --session-id <id>` errors
      // with "is already in use" when the file exists, so we can't use it
      // idempotently across launches. Only forward the kickoff prompt on a
      // fresh session — a resume should never replay it.
      const exists = await window.api.claudeSessionFileExists(cwd, sessionId)
      if (exists) return `${cmd} --resume ${sessionId}`
      const base = `${cmd} --session-id ${sessionId}`
      return initialPrompt ? `${base} ${shellQuote(initialPrompt)}` : base
    }

    const spawnPty = async (): Promise<void> => {
      if (disposed) return
      const shell = '/bin/zsh'
      const claudeArg = type === 'claude' ? await buildClaudeArg() : ''
      if (disposed) return
      const args = type === 'claude' ? ['-ilc', claudeArg] : ['-il']
      window.api.createTerminal(terminalId, cwd, shell, args, type === 'claude')

      terminal.onData((data) => {
        window.api.writeTerminal(terminalId, data)
      })

      cleanupData = window.api.onTerminalData((id, data) => {
        if (id === terminalId) {
          terminal.write(data)
          setLoading(false)
        }
      })
    }

    window.api.loadTerminalHistory(terminalId).then((history) => {
      if (disposed) return
      if (!history) {
        spawnPty()
        return
      }
      // Replay scrollback. Wait for xterm to finish parsing before attaching
      // onData, otherwise any response sequences xterm generates mid-parse
      // (e.g. focus reports from CSI ?1004h in the saved history) get sent to
      // the freshly spawned PTY — which is how a stray "O" was leaking into
      // Claude on session resume (focus-out = ESC [ O).
      terminal.write(history, () => {
        if (disposed) return
        // Reset any reporting modes the restored session may have left on, so
        // the fresh process starts in a clean state.
        const RESET_MODES =
          '\x1b[?1004l' + // focus reporting
          '\x1b[?1000l' + // mouse click tracking
          '\x1b[?1002l' + // mouse cell tracking
          '\x1b[?1003l' + // mouse all tracking
          '\x1b[?1006l' + // SGR mouse encoding
          '\x1b[?2004l'   // bracketed paste
        terminal.write(RESET_MODES + '\r\n\x1b[2m── session restored ──\x1b[0m\r\n', () => {
          if (disposed) return
          spawnPty()
        })
      })
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
      fitRegistry.delete(terminalId)
      closingIds.delete(terminalId)
      resizeObserver.disconnect()
      cleanupData?.()
      cleanupExit?.()
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

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    e.preventDefault()
    const paths = files
      .map((f) => window.api.getFilePath(f))
      .filter((p) => p && p.length > 0)
    if (paths.length === 0) return
    // Match iTerm2: shell-quote each path, join with spaces, wrap in
    // bracketed-paste markers so Claude (and other readline-style prompts)
    // treat it as a paste rather than per-keystroke input.
    // Claude Code detects image paths in pasted text and renders them as
    // attachments, but only when escaped iTerm2-style (backslash-escaped
    // special chars, not POSIX single-quoting).
    const escapeForDrop = (p: string): string => p.replace(/([ \t"'`$\\!?*()[\]{}|;<>&#])/g, '\\$1')
    const text = paths.map(escapeForDrop).join(' ')
    window.api.writeTerminal(terminalId, '\x1b[200~' + text + '\x1b[201~')
    terminalRef.current?.focus()
  }

  return (
    <div
      className="w-full h-full relative"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div ref={containerRef} className="w-full h-full" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-app/70 pointer-events-none">
          <div className="flex flex-col items-center gap-3 text-dim text-sm">
            <ClaudeLoader />
            <div className="flex items-center">
              <span>Starting Claude</span>
              <span className="claude-loader-dots ml-1">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        </div>
      )}
      {exited && type === 'claude' && onRestartClaude && (
        <div className="absolute inset-0 flex items-center justify-center bg-app/80">
          <div className="flex flex-col items-center gap-3 text-sm">
            <div className="text-dim">Claude exited.</div>
            <button
              onClick={onRestartClaude}
              className="px-3 py-1.5 rounded border border-border bg-panel text-fg-bright hover:bg-border transition-colors"
            >
              Start a new session
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
