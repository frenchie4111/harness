import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { BrowserWindow } from 'electron'
import { log } from './debug'

interface JsonClaudeInstance {
  proc: ChildProcessWithoutNullStreams
  windowId: number
  cwd: string
  buf: string
  sessionId: string | null
}

export class JsonClaudeManager {
  private instances = new Map<string, JsonClaudeInstance>()

  create(id: string, cwd: string, window: BrowserWindow, claudeCommand: string = 'claude'): void {
    if (this.instances.has(id)) this.kill(id)

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions'
    ]

    log('json-claude', `spawn id=${id} cwd=${cwd} cmd=${claudeCommand} args=${args.join(' ')}`)

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn('/bin/zsh', ['-ilc', `${claudeCommand} ${args.map((a) => JSON.stringify(a)).join(' ')}`], {
        cwd,
        env: { ...process.env, CLAUDE_HARNESS_ID: id },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      log('json-claude', `spawn failed id=${id}`, err instanceof Error ? err.message : err)
      this.sendEvent(window, id, { type: 'harness_error', error: String(err) })
      return
    }

    const instance: JsonClaudeInstance = {
      proc,
      windowId: window.id,
      cwd,
      buf: '',
      sessionId: null
    }
    this.instances.set(id, instance)

    proc.stdout.on('data', (chunk: Buffer) => {
      instance.buf += chunk.toString('utf8')
      let idx: number
      while ((idx = instance.buf.indexOf('\n')) >= 0) {
        const line = instance.buf.slice(0, idx).trim()
        instance.buf = instance.buf.slice(idx + 1)
        if (!line) continue
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(line)
        } catch {
          this.sendEvent(window, id, { type: 'harness_parse_error', raw: line })
          continue
        }
        if (parsed.type === 'system' && parsed.subtype === 'init' && typeof parsed.session_id === 'string') {
          instance.sessionId = parsed.session_id
        }
        this.sendEvent(window, id, parsed)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      log('json-claude', `stderr id=${id}: ${text.slice(0, 200)}`)
      this.sendEvent(window, id, { type: 'harness_stderr', text })
    })

    proc.on('exit', (code, signal) => {
      log('json-claude', `exit id=${id} code=${code} signal=${signal}`)
      this.sendEvent(window, id, { type: 'harness_exit', code, signal })
      this.instances.delete(id)
    })
  }

  send(id: string, text: string): void {
    const inst = this.instances.get(id)
    if (!inst) return
    const msg = {
      type: 'user',
      message: { role: 'user', content: text }
    }
    try {
      inst.proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      log('json-claude', `stdin write failed id=${id}`, err instanceof Error ? err.message : err)
    }
  }

  kill(id: string): void {
    const inst = this.instances.get(id)
    if (!inst) return
    this.instances.delete(id)
    try {
      inst.proc.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      inst.proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }

  killAll(): void {
    for (const id of Array.from(this.instances.keys())) this.kill(id)
  }

  private sendEvent(window: BrowserWindow, id: string, event: unknown): void {
    const win = BrowserWindow.fromId(window.id) || window
    if (win && !win.isDestroyed()) {
      win.webContents.send('json-claude:event', id, event)
    }
  }
}
