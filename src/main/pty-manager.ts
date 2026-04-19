import * as pty from 'node-pty'
import { execFile } from 'child_process'
import { log } from './debug'
import { cleanupTerminalLog } from './hooks'
import {
  saveTerminalHistory,
  loadTerminalHistory,
  clearTerminalHistory
} from './persistence'
import type { Store } from './store'
import type { PerfMonitor } from './perf-monitor'
import type { PtyStatus } from '../shared/state/terminals'

export type { PtyStatus }

interface PtyInstance {
  pty: pty.IPty
  status: PtyStatus
  isShell: boolean
  /** True when the shell was spawned in exec mode (`zsh -ilc <command>`).
   * For these the activity poller's "direct children" signal is unreliable
   * (the shell often exec's into the command itself, sharing PID), so we
   * skip polling and treat them as active for the PTY's lifetime. */
  isCommandShell: boolean
  activityActive: boolean
  activityProcess?: string
  hasBeenIdle: boolean
}

const SHELL_ACTIVITY_POLL_MS = 1500
// Cap per-terminal raw scrollback at ~1MB. The renderer replays this into a
// fresh xterm.js instance on reload; 1MB of ANSI-wrapped output is enough to
// cover a long Claude session without ballooning disk usage.
const HISTORY_CAP_BYTES = 1024 * 1024
const HISTORY_FLUSH_INTERVAL_MS = 30_000

// Cap per-terminal live tail at ~200KB. The tail is the short rolling window
// handed to late-joining clients on attach (a second Electron window, a WS
// client, or an existing client after a reconnect) so they don't see a blank
// screen. 200KB × ~100 terminals ≈ 20MB — fine for desktops. Kept separate
// from the disk-persisted `history` so tail cost is bounded independently of
// scrollback depth. Tune here. Char length is used rather than true byte
// length: a long run of multi-byte runes will use more RAM than the cap
// suggests, but for ASCII-dominant terminal output the two are equivalent.
const TAIL_CAP_BYTES = 200 * 1024

// Ring-buffered raw PTY output. Appends truncate from the front when we exceed
// the cap. Stored as strings because `terminal:data` already ships strings
// (node-pty decodes UTF-8 for us), and we replay through xterm's string write.
class RingBuffer {
  private chunks: string[] = []
  private size = 0

  constructor(private readonly capBytes: number) {}

  append(data: string): void {
    this.chunks.push(data)
    this.size += data.length
    while (this.size > this.capBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!
      this.size -= dropped.length
    }
    if (this.size > this.capBytes) {
      // Single chunk exceeds cap — trim it from the front.
      const only = this.chunks[0]
      const overflow = this.size - this.capBytes
      this.chunks[0] = only.slice(overflow)
      this.size -= overflow
    }
  }

  seed(data: string): void {
    this.chunks = [data]
    this.size = data.length
  }

  toString(): string {
    if (this.chunks.length > 1) {
      const joined = this.chunks.join('')
      this.chunks = [joined]
      return joined
    }
    return this.chunks[0] || ''
  }
}

export class PtyManager {
  private ptys = new Map<string, PtyInstance>()
  private activityTimer: NodeJS.Timeout | null = null
  private store: Store | null = null
  private sendSignal: ((channel: string, ...args: unknown[]) => void) | null = null
  // Per-terminal raw-byte scrollback owned by main. Populated from disk on
  // create() (if a history file exists), appended to from the PTY onData
  // stream, and returned on getHistory(id). Persistence to
  // userData/terminal-history/<id> happens on a throttled cadence and on
  // before-quit via flushAllHistory().
  private history = new Map<string, RingBuffer>()
  private historyDirty = new Set<string>()
  private historyFlushTimer: NodeJS.Timeout | null = null
  // Per-terminal rolling tail owned by main. Fresh at create(), appended to
  // from the PTY onData stream, dropped on PTY close. Distinct from `history`:
  // tail is in-memory-only, not seeded from disk, and bounded by TAIL_CAP_BYTES
  // rather than HISTORY_CAP_BYTES. Returned verbatim on getTerminalTail(id)
  // so late-joining clients see recent output on attach.
  private tails = new Map<string, RingBuffer>()
  private perfMonitor: PerfMonitor | null = null

  /** Wire the authoritative store after it's constructed. PTY status,
   * shell activity, and cleanup events dispatch through it. */
  setStore(store: Store): void {
    this.store = store
  }

  setPerfMonitor(monitor: PerfMonitor): void {
    this.perfMonitor = monitor
  }

  getActivePtyCount(): number {
    return this.ptys.size
  }

  /** Wire the transport's sendSignal so terminal:data and terminal:exit
   * flow through the transport abstraction instead of reaching for
   * BrowserWindow.webContents directly. */
  setSendSignal(fn: (channel: string, ...args: unknown[]) => void): void {
    this.sendSignal = fn
  }

  hasTerminal(id: string): boolean {
    return this.ptys.has(id)
  }

  create(
    id: string,
    cwd: string,
    command: string,
    args: string[],
    extraEnv?: Record<string, string>,
    isShell: boolean = false,
    cols: number = 120,
    rows: number = 30
  ): void {
    log('pty', `create id=${id} cmd=${command} args=${JSON.stringify(args)} cwd=${cwd} cols=${cols} rows=${rows}`)
    if (this.ptys.has(id)) {
      // A PTY for this id is already running — most likely a second
      // client (web) just connected and its XTerminal mounted for the
      // same tab the desktop window already has open. Don't kill +
      // respawn; that would emit a terminal:exit to every connected
      // client and force-restart Claude. The new client gets the live
      // data stream via the existing terminal:data broadcast, and the
      // history it already loaded via getTerminalHistory replays the
      // scrollback up to the join point.
      log('pty', `create id=${id} no-op — PTY already exists, treating as attach`)
      return
    }

    const env = {
      ...process.env,
      ...(extraEnv || {}),
      CLAUDE_HARNESS_ID: id,
      HARNESS_TERMINAL_ID: id
    } as Record<string, string>
    const shell = command || env.SHELL || '/bin/zsh'
    let ptyProcess: pty.IPty
    try {
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        // Spawn at the renderer's fitted dimensions so the first burst of
        // output paints at the correct grid size. Falling back to 120x30
        // races the eventual ResizeObserver fit, and any cursor-positioned
        // output that arrives in the gap lands at the wrong column.
        cols,
        rows,
        cwd,
        env
      })
    } catch (err) {
      log('pty', `spawn failed id=${id}`, err instanceof Error ? err.message : err)
      const msg = `\r\n\x1b[31mFailed to spawn "${shell}": ${err instanceof Error ? err.message : err}\x1b[0m\r\n`
      this.sendSignal?.('terminal:data', id, msg)
      this.store?.dispatch({
        type: 'terminals/statusChanged',
        payload: { id, status: 'idle', pendingTool: null }
      })
      return
    }

    // Shells spawned with an exec-mode flag (`-c`, `-ilc`, `-lc`, `-ic`) run
    // a single command and exit. The activity poller can't reliably track
    // them via `ps` direct children — zsh often exec's into the target
    // command, so the PTY pid becomes the command itself (no children until
    // the command forks workers). Mark them so pollShellActivity skips
    // them, and fire an active=true dispatch right now so the spinner shows
    // from t=0 and keeps showing until onExit clears shellActivity.
    const isCommandShell =
      isShell &&
      args.some((a) => a === '-c' || a === '-ilc' || a === '-lc' || a === '-ic')

    const instance: PtyInstance = {
      pty: ptyProcess,
      status: 'processing',
      isShell,
      isCommandShell,
      activityActive: isCommandShell,
      hasBeenIdle: isCommandShell
    }

    // Seed the history buffer from disk if a file exists. Renderer calls
    // getHistory(id) right after createTerminal and writes the bytes into a
    // fresh xterm instance before wiring up live data.
    let buf = this.history.get(id)
    if (!buf) {
      buf = new RingBuffer(HISTORY_CAP_BYTES)
      const existing = loadTerminalHistory(id)
      if (existing) buf.seed(existing)
      this.history.set(id, buf)
    }
    // Fresh tail buffer per PTY lifetime. Not seeded from disk — tail is
    // "what this process has emitted so far", which is the right thing for
    // a late-joining client.
    const tailBuf = new RingBuffer(TAIL_CAP_BYTES)
    this.tails.set(id, tailBuf)

    ptyProcess.onData((data: string) => {
      // Tee into both buffers before forwarding, so a reload or a late-join
      // right after output arrives still sees it.
      buf!.append(data)
      tailBuf.append(data)
      this.historyDirty.add(id)
      this.ensureHistoryFlushTimer()
      this.perfMonitor?.recordTerminalBytes(id, data.length)
      this.sendSignal?.('terminal:data', id, data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      log('pty', `exit id=${id} code=${exitCode}`)
      this.store?.dispatch({
        type: 'terminals/statusChanged',
        payload: { id, status: 'idle', pendingTool: null }
      })
      this.store?.dispatch({ type: 'terminals/removed', payload: id })
      this.sendSignal?.('terminal:exit', id, exitCode)
      this.ptys.delete(id)
      this.tails.delete(id)
      cleanupTerminalLog(id)
    })

    this.ptys.set(id, instance)
    if (isShell) this.ensureActivityPoller()

    if (isCommandShell) {
      // Extract the first whitespace-delimited token of the command for a
      // human-readable processName label ("npm run dev" → "npm"). The last
      // arg to `zsh -ilc` is the command string.
      const cmdStr = args[args.length - 1] || ''
      const firstWord = cmdStr.trim().split(/\s+/)[0] || cmdStr
      instance.activityProcess = firstWord
      this.store?.dispatch({
        type: 'terminals/shellActivityChanged',
        payload: { id, active: true, processName: firstWord }
      })
    }
  }

  /** Raw PTY scrollback for `id`, or empty string if none. */
  getHistory(id: string): string {
    return this.history.get(id)?.toString() || ''
  }

  /** Rolling tail of recent output for `id`, or empty string if the terminal
   * isn't running. Unlike getHistory, this is current-session-only and is
   * dropped when the PTY exits — callers use it to paint a late-joining
   * client's screen with "what's been happening in this terminal" before
   * subscribing to the live data signal. */
  getTerminalTail(id: string): string {
    return this.tails.get(id)?.toString() || ''
  }

  /** Drop the in-memory buffer + delete the persisted file. Called on tab
   * close (before killTerminal) so a new tab with a fresh id doesn't
   * inherit stale content, and also used for any explicit "clear". */
  forgetHistory(id: string): void {
    this.history.delete(id)
    this.historyDirty.delete(id)
    clearTerminalHistory(id)
  }

  private ensureHistoryFlushTimer(): void {
    if (this.historyFlushTimer) return
    this.historyFlushTimer = setInterval(
      () => this.flushAllHistory(),
      HISTORY_FLUSH_INTERVAL_MS
    )
  }

  /** Persist any dirty buffers to disk. Called on a throttled cadence and on
   * before-quit so scrollback survives reload/quit without a sync IPC. */
  flushAllHistory(): void {
    if (this.historyDirty.size === 0) return
    for (const id of this.historyDirty) {
      const buf = this.history.get(id)
      if (!buf) continue
      saveTerminalHistory(id, buf.toString())
    }
    this.historyDirty.clear()
  }

  private ensureActivityPoller(): void {
    if (this.activityTimer) return
    this.activityTimer = setInterval(() => this.pollShellActivity(), SHELL_ACTIVITY_POLL_MS)
  }

  private pollShellActivity(): void {
    const shellInstances: Array<[string, PtyInstance]> = []
    for (const entry of this.ptys) {
      // Command shells manage their own activity state (set active=true at
      // create, cleared on exit via terminals/removed), so skip them here.
      if (entry[1].isShell && !entry[1].isCommandShell) shellInstances.push(entry)
    }
    if (shellInstances.length === 0) {
      if (this.activityTimer) {
        clearInterval(this.activityTimer)
        this.activityTimer = null
      }
      return
    }

    execFile('ps', ['-A', '-o', 'pid=,ppid=,comm='], (err, stdout) => {
      if (err) return
      // Build ppid → first child comm map (walk once)
      const childrenByPpid = new Map<number, string[]>()
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!match) continue
        const ppid = parseInt(match[2], 10)
        const comm = match[3].trim()
        const list = childrenByPpid.get(ppid)
        if (list) list.push(comm)
        else childrenByPpid.set(ppid, [comm])
      }

      for (const [id, instance] of shellInstances) {
        const shellPid = instance.pty.pid
        if (!shellPid) continue

        const directChildren = childrenByPpid.get(shellPid) || []
        const rawActive = directChildren.length > 0

        // Arm detection only after we've seen the shell quiescent at least
        // once. This skips login-shell init (nvm, starship, git subprocs)
        // without needing a hardcoded timer.
        if (!instance.hasBeenIdle) {
          if (!rawActive) instance.hasBeenIdle = true
          continue
        }

        const active = rawActive
        const processName = active ? directChildren[0] : undefined
        if (
          active !== instance.activityActive ||
          processName !== instance.activityProcess
        ) {
          instance.activityActive = active
          instance.activityProcess = processName
          this.store?.dispatch({
            type: 'terminals/shellActivityChanged',
            payload: { id, active, processName }
          })
        }
      }
    })
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    log('pty', `resize id=${id} cols=${cols} rows=${rows}`)
    try {
      this.ptys.get(id)?.pty.resize(cols, rows)
    } catch {
      // ignore resize errors on dead PTYs
    }
  }

  kill(id: string, signal?: string): void {
    log('pty', `kill id=${id}${signal ? ` signal=${signal}` : ''}`)
    const instance = this.ptys.get(id)
    if (!instance) return
    this.ptys.delete(id)
    // Tail is tied to the PTY's lifetime. Dropping here covers both explicit
    // kills and the onExit path (onExit will delete again — idempotent).
    this.tails.delete(id)

    const pid = instance.pty.pid
    // node-pty calls setsid() for each spawn, so the shell is its own
    // process-group leader and PGID === pid. Signalling -pid delivers to
    // the whole group (zsh + claude + any descendants) in one syscall,
    // instead of leaving grandchildren attached to our libuv handles.
    if (pid && pid > 0) {
      try {
        process.kill(-pid, (signal as NodeJS.Signals) || 'SIGKILL')
      } catch {
        // Group may already be dead.
      }
    }
    try {
      // Belt & suspenders: close the master fd and let node-pty tear down
      // its own handles. Without this, the read stream on the master can
      // keep Electron's quit sequence waiting even after the descendants
      // are gone.
      instance.pty.kill(signal)
    } catch {
      // pty already dead
    }
    cleanupTerminalLog(id)
  }

  killAll(signal?: string): void {
    // Persist any dirty scrollback before tearing down. kill() itself leaves
    // the history buffer intact — reload relies on that — so flushing here
    // ensures a subsequent process start reads the latest bytes from disk.
    this.flushAllHistory()
    for (const [id] of this.ptys) {
      this.kill(id, signal)
    }
    if (this.activityTimer) {
      clearInterval(this.activityTimer)
      this.activityTimer = null
    }
    if (this.historyFlushTimer) {
      clearInterval(this.historyFlushTimer)
      this.historyFlushTimer = null
    }
  }
}
