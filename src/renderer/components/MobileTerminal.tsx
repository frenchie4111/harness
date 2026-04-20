import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, X, Send, Keyboard, ArrowDownToLine } from 'lucide-react'
import { XTerminal, scrollTerminalById, scrollTerminalToBottomById, getTerminalLineHeight, isTerminalAtBottom } from './XTerminal'
import type { TerminalTab } from '../types'

interface MobileTerminalProps {
  worktreePath: string
  tab: TerminalTab & { type: 'agent' | 'shell' }
}

// Escape sequences sent to the PTY for special keys. xterm.js itself
// generates these for hardware keyboards, but on mobile we synthesize them
// from a soft keyboard / toolbar so the terminal sees the same bytes either
// way.
const KEY_ESC: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F'
}

function ctrlByte(key: string): string | null {
  const k = key.toLowerCase()
  if (k.length !== 1) return null
  const code = k.charCodeAt(0)
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96)
  if (k === ' ') return '\x00'
  if (k === '[') return '\x1b'
  if (k === '\\') return '\x1c'
  if (k === ']') return '\x1d'
  return null
}

export function MobileTerminal({ worktreePath, tab }: MobileTerminalProps): JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const draggedRef = useRef(false)
  const [ctrlSticky, setCtrlSticky] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [scrolledBack, setScrolledBack] = useState(false)
  const terminalId = tab.id

  const writeRaw = useCallback(
    (data: string): void => {
      window.api.writeTerminal(terminalId, data)
    },
    [terminalId]
  )

  const sendKey = useCallback(
    (key: string): void => {
      if (ctrlSticky) {
        const byte = ctrlByte(key)
        if (byte !== null) {
          writeRaw(byte)
          setCtrlSticky(false)
          return
        }
      }
      const esc = KEY_ESC[key]
      writeRaw(esc ?? key)
    },
    [ctrlSticky, writeRaw]
  )

  // Capture characters typed into the hidden textarea. Wipe it back to
  // empty so long buffers don't accumulate — only the delta matters. iOS
  // can insert whole autocorrected words at once.
  const handleInput = useCallback(
    (event: React.FormEvent<HTMLTextAreaElement>) => {
      if (composingRef.current) return
      const value = event.currentTarget.value ?? ''
      if (value.length === 0) return
      event.currentTarget.value = ''
      let buf = ''
      for (const ch of value) {
        if (ch === '\n') {
          if (buf) {
            writeRaw(buf)
            buf = ''
          }
          writeRaw('\r')
        } else {
          buf += ch
        }
      }
      if (buf) writeRaw(buf)
    },
    [writeRaw]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (composingRef.current) return
      const k = event.key
      if (k.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (ctrlSticky) {
          event.preventDefault()
          sendKey(k)
        }
        return
      }
      if (k in KEY_ESC) {
        event.preventDefault()
        sendKey(k)
        return
      }
      if (event.ctrlKey && k.length === 1) {
        const byte = ctrlByte(k)
        if (byte !== null) {
          event.preventDefault()
          writeRaw(byte)
        }
      }
    },
    [ctrlSticky, sendKey, writeRaw]
  )

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true
  }, [])
  const handleCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLTextAreaElement>) => {
      composingRef.current = false
      const value = event.currentTarget.value ?? ''
      if (value.length > 0) {
        event.currentTarget.value = ''
        writeRaw(value)
      }
    },
    [writeRaw]
  )

  // Keyboard visibility derives from our textarea's focus state. iOS 15+
  // shrinks both visualViewport.height AND window.innerHeight when the
  // keyboard opens, so a viewport-size heuristic can't tell them apart;
  // focus/blur is the reliable signal.
  const handleInputFocus = useCallback(() => setKeyboardOpen(true), [])
  const handleInputBlur = useCallback(() => setKeyboardOpen(false), [])

  // While the textarea has focus, pin the document height to the
  // visualViewport so the toolbar rides above the keyboard. On blur,
  // clear the var — MobileApp's root falls back to 100dvh and the
  // layout fills the entire visible viewport (no void below the
  // toolbar). We also re-read on vv resize because iOS reports the
  // keyboard height a beat after it finishes animating in.
  useEffect(() => {
    if (!keyboardOpen) {
      document.documentElement.style.removeProperty('--viewport-h')
      return
    }
    const vv = window.visualViewport
    if (!vv) return
    const apply = (): void => {
      document.documentElement.style.setProperty('--viewport-h', `${vv.height}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [keyboardOpen])

  const focusInput = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  // Touch-scroll the xterm viewport. xterm v6 ships with no touch-scroll
  // implementation of its own (see xtermjs/xterm.js#5377, #594), but it
  // DOES attach a document-level gesture recognizer that calls
  // preventDefault/stopPropagation on touches it interprets — which races
  // and wins against a wrapper-level listener, silently killing our
  // handlers. We attach directly to the `.xterm` element in the capture
  // phase and stopPropagation ourselves so xterm's document handlers
  // don't see the event at all. touch-action:none also has to live on the
  // `.xterm` element (not the wrapper) since it only affects the element
  // it's on.
  useEffect(() => {
    const wrap = wrapperRef.current
    if (!wrap) return
    const xtermEl = wrap.querySelector('.xterm') as HTMLElement | null
    if (!xtermEl) return
    xtermEl.style.touchAction = 'none'
    let lastY: number | null = null
    let accum = 0
    let lineHeight = 16
    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1) { lastY = null; return }
      lastY = e.touches[0].clientY
      accum = 0
      draggedRef.current = false
      lineHeight = getTerminalLineHeight(terminalId)
    }
    const onMove = (e: TouchEvent): void => {
      if (lastY === null || e.touches.length !== 1) return
      const y = e.touches[0].clientY
      accum += y - lastY
      lastY = y
      const lines = Math.trunc(accum / lineHeight)
      if (lines !== 0) {
        accum -= lines * lineHeight
        scrollTerminalById(terminalId, -lines)
        setScrolledBack(!isTerminalAtBottom(terminalId))
        draggedRef.current = true
        e.preventDefault()
        e.stopPropagation()
      } else if (Math.abs(accum) > 4) {
        draggedRef.current = true
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onEnd = (): void => {
      lastY = null
      accum = 0
      setScrolledBack(!isTerminalAtBottom(terminalId))
    }
    xtermEl.addEventListener('touchstart', onStart, { passive: true, capture: true })
    xtermEl.addEventListener('touchmove', onMove, { passive: false, capture: true })
    xtermEl.addEventListener('touchend', onEnd, { passive: true, capture: true })
    xtermEl.addEventListener('touchcancel', onEnd, { passive: true, capture: true })
    return () => {
      xtermEl.removeEventListener('touchstart', onStart, { capture: true })
      xtermEl.removeEventListener('touchmove', onMove, { capture: true })
      xtermEl.removeEventListener('touchend', onEnd, { capture: true })
      xtermEl.removeEventListener('touchcancel', onEnd, { capture: true })
    }
  }, [terminalId])

  const handleWrapperClick = useCallback(() => {
    // Tap focuses the input (pops the keyboard). A drag just scrolled —
    // skip focus so we don't surprise the user with a keyboard at the end
    // of a pan gesture.
    if (draggedRef.current) {
      draggedRef.current = false
      return
    }
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  const handleJumpToBottom = useCallback(() => {
    scrollTerminalToBottomById(terminalId)
    setScrolledBack(false)
  }, [terminalId])

  const toolbarButtons = useMemo(
    () => [
      { label: 'esc', onPress: () => sendKey('Escape') },
      { label: 'tab', onPress: () => sendKey('Tab') },
      { label: 'ctrl', sticky: true, onPress: () => setCtrlSticky((v) => !v) },
      { label: '↑', onPress: () => sendKey('ArrowUp') },
      { label: '↓', onPress: () => sendKey('ArrowDown') },
      { label: '←', onPress: () => sendKey('ArrowLeft') },
      { label: '→', onPress: () => sendKey('ArrowRight') },
      { label: '⌫', onPress: () => sendKey('Backspace') },
      { label: '⏎', onPress: () => sendKey('Enter') }
    ],
    [sendKey]
  )

  const quickActions = useMemo(
    () => [
      { label: 'Cancel', icon: <X className="w-3 h-3" />, onPress: () => writeRaw('\x03') },
      { label: 'Submit', icon: <Send className="w-3 h-3" />, onPress: () => writeRaw('\r') },
      { label: 'Newline', icon: <CornerDownLeft className="w-3 h-3" />, onPress: () => writeRaw('\\\r') }
    ],
    [writeRaw]
  )

  return (
    // absolute inset-0 instead of w-full h-full: on iOS Safari, h-full
    // inside a flex-1 parent sometimes resolves to 0 / the intrinsic
    // content size, leaving a gap between MobileTerminal's bottom and
    // the parent's bottom that shows through as a black void under the
    // toolbar. The parent already has `relative`, so inset-0 just fills
    // it deterministically.
    <div className="absolute inset-0 flex flex-col bg-app">
      <div
        ref={wrapperRef}
        onClick={handleWrapperClick}
        className="relative flex-1 min-h-0"
      >
        {/* key by tab.id so switching tabs (or worktrees) forces a fresh
            XTerminal instance. Desktop renders one XTerminal per tab
            inside portals; on mobile we reuse a single slot, so without
            the key the init effect's `initializedRef` guard short-
            circuits on the new id and the PTY for the new tab never
            spawns — the user sees a black screen on cold worktrees. */}
        <XTerminal
          key={tab.id}
          terminalId={tab.id}
          cwd={worktreePath}
          type={tab.type}
          agentKind={tab.agentKind}
          visible={true}
          sessionName={tab.label}
          sessionId={tab.sessionId}
        />
        {/* Hidden textarea — pointer-events:none so touch scrolling on the
            wrapper above isn't eaten; the wrapper's onClick focuses the
            textarea programmatically on a tap. Keyboard input still
            works once focused (pointer-events only blocks mouse/touch). */}
        <textarea
          ref={inputRef}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          inputMode="text"
          aria-label="Terminal input"
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          className="absolute inset-0 w-full h-full resize-none border-0 bg-transparent text-transparent caret-transparent outline-none"
          style={{ opacity: 0, pointerEvents: 'none' }}
        />
        {scrolledBack && (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleJumpToBottom}
            className="absolute right-3 bottom-3 z-10 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] bg-surface/90 text-fg-bright border border-border shadow-lg"
          >
            <ArrowDownToLine className="w-3 h-3" />
            Jump to bottom
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-panel-raised">
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border/60 overflow-x-auto scrollbar-hidden">
          {quickActions.map((q) => (
            <button
              key={q.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={q.onPress}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-fg bg-panel border border-border hover:bg-surface"
            >
              {q.icon}
              {q.label}
            </button>
          ))}
          {!keyboardOpen && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={focusInput}
              className="shrink-0 ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-fg-bright bg-accent/20 border border-accent/40"
            >
              <Keyboard className="w-3 h-3" />
              Keyboard
            </button>
          )}
        </div>
        <div className="flex items-stretch gap-1 px-2 py-1.5 overflow-x-auto scrollbar-hidden">
          {toolbarButtons.map((b) => {
            const isActive = b.sticky && b.label === 'ctrl' && ctrlSticky
            return (
              <button
                key={b.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={b.onPress}
                className={
                  'shrink-0 min-w-[44px] h-8 px-2 rounded text-[11px] font-mono border ' +
                  (isActive
                    ? 'bg-accent/30 text-fg-bright border-accent/50'
                    : 'bg-panel text-fg border-border hover:bg-surface')
                }
              >
                {b.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
