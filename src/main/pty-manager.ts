import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { log } from './debug'
import { cleanupTerminalLog } from './hooks'

export type PtyStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval'

interface PtyInstance {
  pty: pty.IPty
  status: PtyStatus
  windowId: number
}

export class PtyManager {
  private ptys = new Map<string, PtyInstance>()

  hasTerminal(id: string): boolean {
    return this.ptys.has(id)
  }

  create(
    id: string,
    cwd: string,
    command: string,
    args: string[],
    window: BrowserWindow,
    extraEnv?: Record<string, string>
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
      window.webContents.send('terminal:status', id, 'idle', null)
      return
    }

    const instance: PtyInstance = {
      pty: ptyProcess,
      status: 'processing',
      windowId: window.id
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
      const win = BrowserWindow.fromId(instance.windowId)
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:status', id, 'idle', null)
        win.webContents.send('terminal:exit', id, exitCode)
      }
      this.ptys.delete(id)
      cleanupTerminalLog(id)
    })

    this.ptys.set(id, instance)
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
  }

  /** Get the window that owns a terminal, for routing status updates */
  getWindowForTerminal(id: string): BrowserWindow | null {
    const instance = this.ptys.get(id)
    if (!instance) return null
    const win = BrowserWindow.fromId(instance.windowId)
    return win && !win.isDestroyed() ? win : null
  }
}
