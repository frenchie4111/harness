import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { StateEvent } from '../../shared/state'
import { getClientId, useTerminalSession } from '../store'
import { Eye } from 'lucide-react'

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

export function focusTerminalById(id: string): void {
  terminalRegistry.get(id)?.focus()
}

export function scrollTerminalById(id: string, lines: number): void {
  terminalRegistry.get(id)?.scrollLines(lines)
}

export function scrollTerminalToBottomById(id: string): void {
  terminalRegistry.get(id)?.scrollToBottom()
}

export function getTerminalLineHeight(id: string): number {
  const term = terminalRegistry.get(id)
  if (!term?.element) return 16
  const viewport = term.element.querySelector('.xterm-viewport') as HTMLElement | null
  if (!viewport) return 16
  const rows = term.rows || 1
  const h = viewport.clientHeight / rows
  return h > 0 ? h : 16
}

export function isTerminalAtBottom(id: string): boolean {
  const term = terminalRegistry.get(id)
  if (!term) return true
  return term.buffer.active.viewportY >= term.buffer.active.baseY
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

// Seed from the state snapshot and then keep in sync via the state event
// stream. XTerminal's font cache lives at module scope (not in React state)
// because newly mounted xterm instances read it synchronously in the
// constructor, before any React hook could fire.
void window.api.getStateSnapshot().then(({ state }) => {
  currentFontFamily = state.settings.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY
  currentFontSize = state.settings.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE
  applyFontToAll()
})
window.api.onStateEvent((raw) => {
  const event = raw as StateEvent
  if (event.type === 'settings/terminalFontFamilyChanged') {
    currentFontFamily = event.payload || DEFAULT_TERMINAL_FONT_FAMILY
    applyFontToAll()
  } else if (event.type === 'settings/terminalFontSizeChanged') {
    currentFontSize = event.payload || DEFAULT_TERMINAL_FONT_SIZE
    applyFontToAll()
  }
})

// Browsers without `font-variant-emoji: text` (iOS Safari < 17.4) happily
// auto-emojify ambiguous codepoints via the Apple Color Emoji fallback,
// so Claude Code's U+23FA tool-call marker renders as a red-circle
// emoji on older phones even with our CSS rule in place. Detect support
// once and rewrite the known offender to U+25CF (●) in the data stream
// when the CSS can't do the job. On browsers that honor the property we
// ship the original glyph through unchanged.
const supportsTextEmoji =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('font-variant-emoji', 'text')
    : false

// On touch devices, xterm's alt-screen and mouse-tracking modes both
// make TUIs (Claude Code, vim) unscrollable: alt-screen has no
// scrollback at all, and mouse tracking forwards finger pans to the
// PTY as mouse reports that the TUI discards. Strip the CSI private
// modes that enable them so touch devices always stay in the primary
// buffer with scroll wheel / touch scroll. Desktop clients keep the
// full behavior.
const isTouchDevice =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || (window.navigator?.maxTouchPoints ?? 0) > 0)
const TUI_UNFRIENDLY_MODES =
  /\u001b\[\?(?:47|1000|1002|1003|1005|1006|1015|1047|1049)[hl]/g

function sanitizeTerminalData(data: string): string {
  let out = data
  if (!supportsTextEmoji) out = out.replace(/\u23FA/g, '\u25CF')
  if (isTouchDevice) out = out.replace(TUI_UNFRIENDLY_MODES, '')
  return out
}

/** Mark a terminal as closing: drop its main-side scrollback buffer + file so
 * a future tab with a different id doesn't inherit stale bytes. Scrollback
 * ownership lives in main (PtyManager), so this is a one-shot fire-and-forget
 * IPC with no renderer-side suppression needed. */
export function markTerminalClosing(id: string): void {
  window.api.clearTerminalHistory(id)
}

import type { AgentKind } from '../../shared/state/terminals'
import { agentDisplayName } from '../../shared/agent-registry'

interface XTerminalProps {
  terminalId: string
  cwd: string
  type: 'agent' | 'shell'
  agentKind?: AgentKind
  visible: boolean
  sessionName?: string
  sessionId?: string
  initialPrompt?: string
  teleportSessionId?: string
  /** Shell tabs only: when set, spawn `<user-shell> -ilc <command>` instead
   * of an interactive login shell. Used for agent-spawned shells. */
  shellCommand?: string
  /** Shell tabs only: directory to spawn in. Relative paths resolve against
   * `cwd` (the worktree root); absolute paths are used as-is. */
  shellCwd?: string
  onRestartAgent?: () => void
}

export function XTerminal({ terminalId, cwd, type, agentKind, visible, sessionName, sessionId, initialPrompt, teleportSessionId, shellCommand, shellCwd, onRestartAgent }: XTerminalProps): JSX.Element {
  const [exited, setExited] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [loading, setLoading] = useState(type === 'agent')
  const visibleRef = useRef(visible)
  const initializedRef = useRef(false)
  const session = useTerminalSession(terminalId)
  // The controllerClientId is null in the very narrow window between
  // mount and the first terminal:join dispatch landing back through the
  // state stream. Treat that as "we are controller" so input works
  // (main's gate allows writes when no session exists yet — see
  // pty:write handler).
  const myClientId = getClientId()
  const isController =
    session === null || session.controllerClientId === null || session.controllerClientId === myClientId
  const isControllerRef = useRef(isController)
  isControllerRef.current = isController
  // When the terminal mounts in a display:none wrapper (background tab or
  // non-active worktree), the container has zero size and FitAddon can't
  // compute dimensions. We stash the deferred spawn here so the visible
  // effect kicks it off once the container actually has layout.
  const pendingSpawnRef = useRef<(() => void) | null>(null)

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
      // Route OSC 8 hyperlink clicks to the system browser. Without this,
      // xterm's default handler shows a confirm prompt and then calls
      // window.open, which Electron silently swallows.
      linkHandler: {
        activate: (_event, uri) => {
          if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('mailto:')) {
            window.api.openExternal(uri)
          }
        },
        hover: () => {},
        leave: () => {}
      },
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

    // Translate Shift+Enter into "backslash + Enter" (\\\r). By default xterm
    // sends bare \r for both Enter and Shift+Enter, so Claude Code can't tell
    // them apart and treats Shift+Enter as submit. Sending `\` then Enter
    // matches Claude Code's documented line-continuation pattern and inserts
    // a newline regardless of cursor position.
    terminal.attachCustomKeyEventHandler((e) => {
      if (!isControllerRef.current) {
        // Spectators shouldn't inject even our Shift+Enter escape;
        // main would drop the write too, but swallowing here keeps
        // local copy/paste selection working while blocking input.
        return true
      }
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
    fitRegistry.set(terminalId, fitAddon)

    // Restore scrollback (if any) before spawning the PTY so historical output
    // appears above the fresh shell's prompt.
    let cleanupData: (() => void) | null = null
    let cleanupExit: (() => void) | null = null
    let disposed = false

    if (type === 'agent') {
      cleanupExit = window.api.onTerminalExit((id) => {
        if (id === terminalId && !disposed) setExited(true)
      })
    }

    const buildAgentArg = async (): Promise<string> => {
      return window.api.buildAgentSpawnArgs(agentKind || 'claude', {
        terminalId,
        cwd,
        sessionId,
        initialPrompt,
        teleportSessionId,
        sessionName
      })
    }

    const spawnPty = async (): Promise<void> => {
      if (disposed) return
      // If the container has no layout yet (display:none background tab),
      // defer the spawn. The visible useEffect below will call this again
      // once the tab becomes visible and FitAddon can compute real dims.
      // Spawning now would come up at the fallback 120x30 and every burst
      // of output before the first resize IPC would paint at the wrong
      // column, producing a visible "flash" when the worktree is opened.
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect || rect.width < 20 || rect.height < 20) {
        pendingSpawnRef.current = () => { void spawnPty() }
        return
      }
      pendingSpawnRef.current = null

      // Empty string falls through to env.SHELL in pty-manager — picks up the
      // user's actual shell instead of hardcoding zsh on bash-only systems.
      const shell = ''
      const agentArg = type === 'agent' ? await buildAgentArg() : ''
      if (disposed) return
      const args =
        type === 'agent'
          ? ['-ilc', agentArg]
          : shellCommand
            ? ['-ilc', shellCommand]
            : ['-il']
      const spawnCwd = shellCwd
        ? shellCwd.startsWith('/')
          ? shellCwd
          : `${cwd}/${shellCwd}`
        : cwd
      // Pass the renderer's fitted dimensions so the PTY spawns at the
      // right grid size instead of main's fallback 120x30.
      let spawnCols: number | undefined
      let spawnRows: number | undefined
      try {
        fitAddon.fit()
        const dims = fitAddon.proposeDimensions()
        if (dims && dims.cols > 0 && dims.rows > 0) {
          spawnCols = dims.cols
          spawnRows = dims.rows
        }
      } catch {
        // fall back to main's defaults
      }
      window.api.createTerminal(terminalId, spawnCwd, shell, args, type === 'agent' ? agentKind : undefined, spawnCols, spawnRows)

      terminal.onData((data) => {
        // Spectators silently drop input. Main also enforces this, but
        // gating here avoids the round-trip + any suggestion the keystroke
        // "took" (we don't echo back since xterm's local echo is off).
        if (!isControllerRef.current) return
        window.api.writeTerminal(terminalId, data)
      })

      cleanupData = window.api.onTerminalData((id, data) => {
        if (id === terminalId) {
          terminal.write(sanitizeTerminalData(data))
          setLoading(false)
        }
      })

      // Safety net: if no output has arrived by the time spawnPty
      // returns + a short grace window, clear the overlay anyway. This
      // covers the "attach to a running but idle Claude with no
      // accumulated history" case, where getTerminalHistory returns ''
      // and no new bytes will flow until the user does something — the
      // overlay would otherwise stay forever.
      setTimeout(() => {
        if (!disposed) setLoading(false)
      }, 800)
    }

    window.api.getTerminalHistory(terminalId).then((history) => {
      if (disposed) return
      if (!history) {
        spawnPty()
        return
      }
      // A non-empty history means main already has a live PTY for this id
      // — the agent isn't "starting," we're attaching to a running one.
      // Clear the loading overlay so the restored scrollback is visible
      // without waiting for new bytes (which may never come if the agent
      // is idle at its prompt).
      setLoading(false)
      // Replay raw scrollback. Wait for xterm to finish parsing before
      // attaching onData, otherwise any response sequences xterm generates
      // mid-parse (e.g. focus reports from CSI ?1004h in the saved history)
      // get sent to the freshly spawned PTY — which is how a stray "O" was
      // leaking into Claude on session resume (focus-out = ESC [ O).
      terminal.write(sanitizeTerminalData(history), () => {
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

    // Handle resize — only fit when actually visible. Spectators still
    // call fitAddon.fit() so the local xterm renders at the controller's
    // dimensions, but they don't forward resize signals — the PTY size
    // is authoritative and owned by the controller.
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
        if (dims && isControllerRef.current) {
          console.log(`[xterm] ResizeObserver fit id=${terminalId} cols=${dims.cols} rows=${dims.rows}`)
          window.api.resizeTerminal(terminalId, dims.cols, dims.rows)
        }
      })
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      disposed = true
      // PTY lifetime is owned by main now: panes:closeTab,
      // panes:restartAgentTab, and panes:clearForWorktree call
      // ptyManager.kill on the way out. We don't kill from XTerminal
      // unmount because unmount can fire for reasons unrelated to the
      // user wanting the agent dead — a web client closing a browser
      // tab, a renderer reload, etc. — and any one of those used to
      // take Claude down for every connected client.
      window.api.leaveTerminal(terminalId)
      terminalRegistry.delete(terminalId)
      fitRegistry.delete(terminalId)
      resizeObserver.disconnect()
      cleanupData?.()
      cleanupExit?.()
      terminal.dispose()
    }
  }, [terminalId, cwd, type])

  // Announce our presence on the session roster. For the spawn path
  // this is redundant with pty:create's implicit controlTaken, but
  // dispatching here too covers the attach case (second client mounts
  // an XTerminal for a terminal whose PTY already exists).
  useEffect(() => {
    window.api.joinTerminal(terminalId)
  }, [terminalId])

  // Re-fit when the terminal becomes visible
  useEffect(() => {
    if (!visible || !fitAddonRef.current || !containerRef.current) return

    const doFit = (reason: string): void => {
      if (!fitAddonRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      console.log(`[xterm] doFit reason=${reason} id=${terminalId} rect=${Math.round(rect.width)}x${Math.round(rect.height)}`)
      if (rect.width === 0 || rect.height === 0) return
      fitAddonRef.current.fit()
      // If the PTY spawn was deferred because the container was hidden at
      // mount, fire it now that we have real dimensions — before any
      // resize IPC, so the very first spawn lands at the right grid size.
      if (pendingSpawnRef.current) {
        const pending = pendingSpawnRef.current
        pendingSpawnRef.current = null
        pending()
        return
      }
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

  const handleTakeControl = (): void => {
    const controller = session?.controllerClientId ?? 'null'
    if (!fitAddonRef.current) {
      console.log(`[take-control] click id=${terminalId} myClientId=${myClientId} prevController=${controller} dims=fallback-120x30`)
      window.api.takeTerminalControl(terminalId, 120, 30)
      return
    }
    try {
      fitAddonRef.current.fit()
      const dims = fitAddonRef.current.proposeDimensions()
      if (dims && dims.cols > 0 && dims.rows > 0) {
        console.log(`[take-control] click id=${terminalId} myClientId=${myClientId} prevController=${controller} dims=${dims.cols}x${dims.rows}`)
        window.api.takeTerminalControl(terminalId, dims.cols, dims.rows)
      } else {
        console.log(`[take-control] click id=${terminalId} myClientId=${myClientId} prevController=${controller} dims=fallback-120x30`)
        window.api.takeTerminalControl(terminalId, 120, 30)
      }
    } catch {
      console.log(`[take-control] click id=${terminalId} myClientId=${myClientId} prevController=${controller} dims=fallback-caught`)
      window.api.takeTerminalControl(terminalId, 120, 30)
    }
  }

  const showSpectatorOverlay = session !== null && session.controllerClientId !== null && session.controllerClientId !== myClientId

  // Diagnostic for the controller/spectator UI flow. Logs the overlay
  // decision whenever the session roster or cached clientId changes
  // so we can correlate with the `[take-control]` lines from
  // renderer/store.ts and main's debug log.
  useEffect(() => {
    console.log(
      `[take-control] overlay id=${terminalId} myClientId=${myClientId} controller=${session?.controllerClientId ?? 'null'} showOverlay=${showSpectatorOverlay} isController=${isController}`
    )
  }, [terminalId, myClientId, session?.controllerClientId, showSpectatorOverlay, isController])

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
              <span>Starting {agentDisplayName(agentKind)}</span>
              <span className="claude-loader-dots ml-1">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        </div>
      )}
      {showSpectatorOverlay && (
        <div className="absolute top-2 right-2 flex items-center gap-2 pointer-events-auto">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-panel/90 border border-border text-xs text-dim">
            <Eye size={12} />
            <span>Spectating</span>
          </div>
          <button
            onClick={handleTakeControl}
            className="px-2 py-1 rounded-md text-xs bg-panel/90 border border-border text-fg-bright hover:bg-border transition-colors"
          >
            Take control
          </button>
        </div>
      )}
      {exited && type === 'agent' && onRestartAgent && (
        <div className="absolute inset-0 flex items-center justify-center bg-app/80">
          <div className="flex flex-col items-center gap-3 text-sm">
            <div className="text-dim">{agentDisplayName(agentKind)} exited.</div>
            <button
              onClick={onRestartAgent}
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
