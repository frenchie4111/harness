import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, X, Send, Keyboard } from 'lucide-react'
import { XTerminal } from './XTerminal'
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
  const composingRef = useRef(false)
  const [ctrlSticky, setCtrlSticky] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
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

  const focusInput = useCallback(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

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
      <div className="relative flex-1 min-h-0">
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
        {/* Hidden textarea, sized to fill the terminal area so iOS doesn't
            scroll oddly when it focuses. Pointer events stay on so a tap
            anywhere on the terminal opens the keyboard; the actual xterm
            canvas keeps rendering the cursor underneath. */}
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
          style={{ opacity: 0 }}
        />
      </div>

      <div
        className="shrink-0 border-t border-border bg-panel-raised"
        style={{
          // Honor the iPhone home-indicator inset when the keyboard is
          // down, but drop it when the keyboard is up — iOS anchors the
          // keyboard flush to the visualViewport bottom, so that inset
          // becomes dead space between the toolbar and the keys.
          paddingBottom: keyboardOpen ? 0 : 'env(safe-area-inset-bottom, 0px)'
        }}
      >
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
