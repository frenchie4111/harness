import { useEffect, useRef, useState } from 'react'
import { XTerminal, focusTerminalById, scrollTerminalToBottomById } from './XTerminal'

// Quake-style drop-down shell overlay. It floats over the active pane/tab
// regardless of what that tab is, slides down from the top, and slides back
// up on dismiss.
//
// State ownership: there is no slice here. The shell is a real PTY owned by
// main's PtyManager (addressed by id `quake:<worktreePath>`) exactly like any
// other shell — PTY lifecycle is already main-owned shared state, survives
// reload, and is shared across clients. The only new state is the overlay's
// open/visible flag, which is per-client UI focus and lives as `useState` in
// App.tsx. The terminal is deliberately NOT a pane and not in the `terminals`
// slice.
//
// Persistence: XTerminal never kills its PTY on unmount (only `leaveTerminal`),
// so the session survives close/reopen and worktree switches. To keep
// re-toggling within a worktree instant AND bannerless, we keep the XTerminal
// mounted (slid off-screen) once it's been opened for the current worktree
// rather than unmounting on close.

const MIN_HEIGHT_PX = 160
const HEIGHT_KEY = 'harness.quakeTerminalHeight'

// Easter egg: the first time the drop-down console opens this session, it
// boots like id Software's Quake — the game whose console this overlay apes.
// Written straight to the xterm display (visual only) above the shell prompt.
// `\r\n` line endings because xterm wants carriage returns; wrapped in amber
// (SGR 33) to read as a retro console dump, reset (SGR 0) before the prompt.
const QUAKE_BANNER =
  '\x1b[33m' +
  [
    'WGL_EXT_SWAP_CONTROL',
    '',
    'SOUND INITIALIZATION',
    'SET PRIMARY SOUND BUFFER FORMAT: YES',
    'USING SECONDARY SOUND BUFFER',
    '    2 CHANNEL(S)',
    '    16 BITS/SAMPLE',
    '    11025 BYTES/SEC',
    'DIRECTSOUND INITIALIZED',
    'SOUND SAMPLING RATE: 11025',
    'CDAUDIO_INIT: No CD IN PLAYER.',
    'CD AUDIO INITIALIZED',
    '',
    'JOYSTICK NOT FOUND -- NO VALID JOYSTICKS (45)',
    '',
    'EXECING HARNESS.RC',
    'EXECING DEFAULT.CFG',
    'EXECING CONFIG.CFG',
    'EXECING AUTOEXEC.CFG',
    '',
    'YOU GOT THE GRENADE LAUNCHER'
  ].join('\r\n') +
  '\x1b[0m\r\n\r\n'

function initialHeight(): number {
  const stored = Number(localStorage.getItem(HEIGHT_KEY))
  if (Number.isFinite(stored) && stored >= MIN_HEIGHT_PX) return stored
  return Math.round(window.innerHeight * 0.45)
}

interface QuakeTerminalProps {
  worktreePath: string | null
  open: boolean
  onClose: () => void
  /** Inset of the workspace region within the content row, so the overlay
   * descends from below the tab bar and stays between the left and right
   * sidebars rather than covering them. */
  leftPx: number
  rightPx: number
  topPx: number
}

export function QuakeTerminal({ worktreePath, open, onClose, leftPx, rightPx, topPx }: QuakeTerminalProps): JSX.Element | null {
  const [height, setHeight] = useState(initialHeight)
  // The worktree whose quake shell is currently mounted. Lazy on first open;
  // kept mounted across close so reopen is instant. Tracks the active worktree
  // while open so switching worktrees with the overlay down swaps to that
  // worktree's contextual shell.
  const [mountedFor, setMountedFor] = useState<string | null>(null)
  // The terminal that should receive the one-time boot banner: the very first
  // quake shell opened this session. Switching worktrees mounts a fresh shell
  // but the banner shows only on this one. Set in the same state batch as the
  // first `mountedFor` so the banner prop is already present when that
  // XTerminal first mounts (mounts only happen once per id).
  const [bannerTerminalId, setBannerTerminalId] = useState<string | null>(null)
  const firstOpenHandled = useRef(false)

  useEffect(() => {
    if (!open || !worktreePath) return
    if (!firstOpenHandled.current) {
      firstOpenHandled.current = true
      setBannerTerminalId(`quake:${worktreePath}`)
    }
    setMountedFor(worktreePath)
  }, [open, worktreePath])

  const terminalId = mountedFor ? `quake:${mountedFor}` : null

  // Esc dismisses while open.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // Focus the shell and pin it to the bottom once it slides into view, then
  // restore focus to wherever it came from on close. Restoring matters because
  // the open hotkey only fires when a workspace tab is focused — without it,
  // focus would be left in the (now-hidden) shell and the next toggle couldn't
  // reopen. The retries cover first-mount scrollback replay (async) and
  // XTerminal's deferred visible-refit passes, either of which can land after
  // the initial frame and leave the viewport mid-buffer.
  useEffect(() => {
    if (!open || !terminalId) return
    const prevFocus = document.activeElement as HTMLElement | null
    const settle = (): void => {
      focusTerminalById(terminalId)
      scrollTerminalToBottomById(terminalId)
    }
    const timers = [80, 200, 400].map((ms) => setTimeout(settle, ms))
    return () => {
      timers.forEach(clearTimeout)
      if (prevFocus && prevFocus.isConnected) prevFocus.focus()
    }
  }, [open, terminalId])

  const handleResizeDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    const onMove = (ev: MouseEvent): void => {
      const next = Math.max(
        MIN_HEIGHT_PX,
        Math.min(window.innerHeight - 80, startHeight + (ev.clientY - startY))
      )
      setHeight(next)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem(HEIGHT_KEY, String(height))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }

  // Persist the latest height when a drag settles (handleResizeDown closes over
  // a stale `height`, so mirror it on every change).
  useEffect(() => {
    localStorage.setItem(HEIGHT_KEY, String(height))
  }, [height])

  return (
    <>
      <div
        onClick={onClose}
        className={`absolute z-30 bg-black/40 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{ left: leftPx, right: rightPx, top: topPx, bottom: 0 }}
      />
      {/* Clip wrapper anchored at the tab-bar line. overflow-hidden means the
          panel translated up is hidden above this edge, so it rolls down from
          under the tab bar instead of sweeping over it. */}
      <div
        className="absolute z-40 overflow-hidden"
        style={{ left: leftPx, right: rightPx, top: topPx, bottom: 0, pointerEvents: 'none' }}
      >
        <div
          className="absolute inset-x-0 top-0 flex flex-col bg-panel border-b-2 border-accent/60 shadow-2xl transition-transform duration-200 ease-out"
          style={{
            height,
            transform: open ? 'translateY(0)' : 'translateY(-100%)',
            pointerEvents: open ? 'auto' : 'none'
          }}
        >
          <div className="relative flex-1 min-h-0">
            {terminalId && (
              <XTerminal
                key={terminalId}
                terminalId={terminalId}
                cwd={mountedFor!}
                type="shell"
                visible={open}
                backgroundVar="--color-panel"
                preamble={terminalId === bannerTerminalId ? QUAKE_BANNER : undefined}
                hideRestoreNotice
              />
            )}
          </div>
          <div
            onMouseDown={handleResizeDown}
            className="absolute inset-x-0 -bottom-1 h-2 cursor-row-resize hover:bg-accent/40 active:bg-accent/60 transition-colors"
          />
        </div>
      </div>
    </>
  )
}
