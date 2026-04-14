import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { log } from './debug'
import { cleanupTerminalLog } from './hooks'
import type { Store } from './store'
import type { PtyStatus } from '../shared/state/terminals'

export type { PtyStatus }

interface PtyInstance {
  pty: pty.IPty
  status: PtyStatus
  windowId: number
  isShell: boolean
  activityActive: boolean
  activityProcess?: string
  hasBeenIdle: boolean
}

const SHELL_ACTIVITY_POLL_MS = 1500

export class PtyManager {
  private ptys = new Map<string, PtyInstance>()
  private activityTimer: NodeJS.Timeout | null = null
  private store: Store | null = null

  /** Wire the authoritative store after it's constructed. PTY status,
   * shell activity, and cleanup events dispatch through it; terminal:data
   * and terminal:exit stay on direct window channels (high-frequency and
   * view-layer respectively). */
  setStore(store: Store): void {
    this.store = store
  }

  hasTerminal(id: string): boolean {
    return this.ptys.has(id)
  }

  create(
    id: string,
    cwd: string,
    command: string,
    args: string[],
    window: BrowserWindow,
    extraEnv?: Record<string, string>,
    isShell: boolean = false
  ): void {
    log('pty', `create id=${id} cmd=${command} args=${JSON.stringify(args)} cwd=${cwd}`)
    if (this.ptys.has(id)) {
      this.kill(id)
    }

    const env = {
      ...process.env,
      ...(extraEnv || {}),
      CLAUDE_HARNESS_ID: id
    } as Record<string, string>
    const shell = command || env.SHELL || '/bin/zsh'
    let ptyProcess: pty.IPty
    try {
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env
      })
    } catch (err) {
      log('pty', `spawn failed id=${id}`, err instanceof Error ? err.message : err)
      const msg = `\r\n\x1b[31mFailed to spawn "${shell}": ${err instanceof Error ? err.message : err}\x1b[0m\r\n`
      window.webContents.send('terminal:data', id, msg)
      this.store?.dispatch({
        type: 'terminals/statusChanged',
        payload: { id, status: 'idle', pendingTool: null }
      })
      return
    }

    const instance: PtyInstance = {
      pty: ptyProcess,
      status: 'processing',
      windowId: window.id,
      isShell,
      activityActive: false,
      hasBeenIdle: false
    }

    ptyProcess.onData((data: string) => {
      // Route data to the owning window (if it still exists)
      const win = BrowserWindow.fromId(instance.windowId)
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:data', id, data)
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      log('pty', `exit id=${id} code=${exitCode}`)
      this.store?.dispatch({
        type: 'terminals/statusChanged',
        payload: { id, status: 'idle', pendingTool: null }
      })
      this.store?.dispatch({ type: 'terminals/removed', payload: id })
      const win = BrowserWindow.fromId(instance.windowId)
      if (win && !win.isDestroyed()) {
        // terminal:exit stays on a direct window channel so XTerminal can
        // mark the specific xterm instance as closed. Status + terminals/
        // removed propagate via the store to every client.
        win.webContents.send('terminal:exit', id, exitCode)
      }
      this.ptys.delete(id)
      cleanupTerminalLog(id)
    })

    this.ptys.set(id, instance)
    if (isShell) this.ensureActivityPoller()
  }

  private ensureActivityPoller(): void {
    if (this.activityTimer) return
    this.activityTimer = setInterval(() => this.pollShellActivity(), SHELL_ACTIVITY_POLL_MS)
  }

  private pollShellActivity(): void {
    const shellInstances: Array<[string, PtyInstance]> = []
    for (const entry of this.ptys) {
      if (entry[1].isShell) shellInstances.push(entry)
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
    for (const [id] of this.ptys) {
      this.kill(id, signal)
    }
    if (this.activityTimer) {
      clearInterval(this.activityTimer)
      this.activityTimer = null
    }
  }

  /** Get the window that owns a terminal, for routing status updates */
  getWindowForTerminal(id: string): BrowserWindow | null {
    const instance = this.ptys.get(id)
    if (!instance) return null
    const win = BrowserWindow.fromId(instance.windowId)
    return win && !win.isDestroyed() ? win : null
  }
}
