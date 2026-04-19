// Runs `claude -p --input-format stream-json --output-format stream-json`
// as a long-lived subprocess per json-claude tab. Mirrors PtyManager's
// lifecycle shape (create / send / kill / killAll) and dispatches state
// into the jsonClaude slice so the renderer re-renders through the normal
// store path.
//
// Permissions: we pass --permission-mode default and
// --permission-prompt-tool mcp__harness-permissions__approve, where that
// MCP server is the bundled out/main/permission-prompt-mcp.js (see
// ApprovalBridge for the socket side of that).
//
// Memory isolation: Claude Code's auto-memory subsystem writes to
// ~/.claude/projects/<cwd-encoded>/memory/ by default. Running this as a
// child process would pollute the user's personal memory dir with
// conversations they didn't have in their "real" Claude Code sessions.
// We redirect that by setting CLAUDE_CONFIG_DIR to a per-session temp
// dir so all project-dir-derived reads and writes land there instead.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import type { Store } from './store'
import type {
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock,
  JsonClaudeSessionState
} from '../shared/state/json-claude'
import { log } from './debug'

interface JsonClaudeInstance {
  proc: ChildProcessWithoutNullStreams
  sessionId: string
  worktreePath: string
  buf: string
  /** Monotonically increasing counter used to build stable chat entry ids. */
  entryCounter: number
}

export interface JsonClaudeManagerOptions {
  getClaudeCommand: () => string
  getApprovalSocketPath: (sessionId: string) => string
  closeApprovalSession: (sessionId: string) => void
  getClaudeEnvVars: () => Record<string, string>
}

/** Path to the bundled stdio MCP server we point Claude's
 *  --permission-prompt-tool at. Mirrors src/main/mcp-config.ts: in dev
 *  the file lives in resources/ at the repo root; in packaged builds
 *  it's copied by electron-builder to process.resourcesPath. */
function permissionPromptScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'permission-prompt-mcp.js')
  }
  return join(__dirname, '..', '..', 'resources', 'permission-prompt-mcp.js')
}


export class JsonClaudeManager {
  private instances = new Map<string, JsonClaudeInstance>()
  private store: Store
  private opts: JsonClaudeManagerOptions

  constructor(store: Store, opts: JsonClaudeManagerOptions) {
    this.store = store
    this.opts = opts
  }

  hasSession(sessionId: string): boolean {
    return this.instances.has(sessionId)
  }

  create(sessionId: string, worktreePath: string): void {
    if (this.instances.has(sessionId)) {
      log('json-claude', `create no-op — already running sessionId=${sessionId}`)
      return
    }
    const socketPath = this.opts.getApprovalSocketPath(sessionId)

    // MCP config points at the bundled permission-prompt server. Claude
    // resolves the tool as mcp__<server>__<tool>; the server we advertise
    // is named 'harness-permissions' and its only tool is 'approve'.
    const mcpConfig = {
      mcpServers: {
        'harness-permissions': {
          command: process.execPath,
          args: [permissionPromptScriptPath()],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            HARNESS_APPROVAL_SOCKET: socketPath,
            HARNESS_JSON_CLAUDE_SESSION_ID: sessionId
          }
        }
      }
    }

    const claudeCommand = this.opts.getClaudeCommand() || 'claude'
    const existingSession = existsSync(
      join(homedir(), '.claude', 'projects', worktreePath.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
    )
    const resumeOrSet = existingSession
      ? ['--resume', sessionId]
      : ['--session-id', sessionId]

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'default',
      '--permission-prompt-tool',
      'mcp__harness-permissions__approve',
      '--mcp-config',
      JSON.stringify(mcpConfig),
      ...resumeOrSet
    ]

    // Build the command line via login shell so the user's full PATH
    // (Homebrew, nvm, etc.) is available — same pattern PtyManager uses
    // for classic Claude tabs. Using zsh -ilc also gives us a single
    // string we can shellQuote-free because zsh handles its own quoting.
    const quoted = args.map((a) => JSON.stringify(a)).join(' ')
    const cmdLine = `${claudeCommand} ${quoted}`

    log('json-claude', `spawn sessionId=${sessionId} cwd=${worktreePath}`)

    const envVars = this.opts.getClaudeEnvVars() || {}
    // Build env for the subprocess. We start from process.env, scrub
    // env vars that the user-scope Harness hooks key off of so the
    // subprocess's hook firings don't masquerade as the parent agent
    // tab, then layer on json-claude-specific vars.
    const childEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') childEnv[k] = v
    }
    delete childEnv.CLAUDE_HARNESS_ID
    delete childEnv.HARNESS_TERMINAL_ID
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn('/bin/zsh', ['-ilc', cmdLine], {
        cwd: worktreePath,
        env: {
          ...childEnv,
          ...envVars,
          // Memory isolation: the auto-memory subsystem writes into
          // ~/.claude/projects/<project>/memory/ by default, which
          // means json-claude sessions would scribble into the user's
          // personal memory dir for whatever project their worktree
          // belongs to. This env var skips that path entirely. Session
          // jsonls still persist (needed for --resume), they just land
          // in projects/<project>/ without a sibling memory/ dir.
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          // So our bundled MCP server can identify its parent session
          // when it opens the approval socket.
          HARNESS_JSON_CLAUDE_SESSION_ID: sessionId
        },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      log(
        'json-claude',
        `spawn failed sessionId=${sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
      this.dispatchState(sessionId, 'exited', {
        exitReason: err instanceof Error ? err.message : String(err)
      })
      this.opts.closeApprovalSession(sessionId)
      return
    }

    const instance: JsonClaudeInstance = {
      proc,
      sessionId,
      worktreePath,
      buf: '',
      entryCounter: 0
    }
    this.instances.set(sessionId, instance)
    this.dispatchState(sessionId, 'running')

    proc.stdout.on('data', (chunk: Buffer) => {
      instance.buf += chunk.toString('utf8')
      let idx: number
      while ((idx = instance.buf.indexOf('\n')) >= 0) {
        const line = instance.buf.slice(0, idx).trim()
        instance.buf = instance.buf.slice(idx + 1)
        if (!line) continue
        this.handleStreamLine(instance, line)
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      log('json-claude', `stderr sessionId=${sessionId}: ${text.slice(0, 200)}`)
    })

    proc.on('exit', (code, signal) => {
      log(
        'json-claude',
        `exit sessionId=${sessionId} code=${code} signal=${signal}`
      )
      this.dispatchState(sessionId, 'exited', {
        exitCode: code,
        exitReason: signal ? `signal ${signal}` : code === 0 ? 'clean' : `exit ${code}`
      })
      this.dispatchBusy(sessionId, false)
      this.instances.delete(sessionId)
      this.opts.closeApprovalSession(sessionId)
    })
  }

  send(sessionId: string, text: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    this.appendEntry(inst, {
      kind: 'user',
      text,
      timestamp: Date.now(),
      entryId: `${sessionId}-u-${inst.entryCounter++}`
    })
    this.dispatchBusy(sessionId, true)
    const payload = {
      type: 'user',
      message: { role: 'user', content: text }
    }
    try {
      inst.proc.stdin.write(JSON.stringify(payload) + '\n')
    } catch (err) {
      log(
        'json-claude',
        `stdin write failed sessionId=${sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  /** SIGINT the subprocess's turn. Per the plan, this leaves the session
   *  resumable — the model's partial turn is captured in the session
   *  jsonl transcript. */
  interrupt(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    log('json-claude', `interrupt sessionId=${sessionId}`)
    try {
      inst.proc.kill('SIGINT')
    } catch {
      /* ignore */
    }
    // Flip busy off optimistically; the result event (if any) will also
    // clear it via handleStreamLine.
    this.dispatchBusy(sessionId, false)
  }

  kill(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    log('json-claude', `kill sessionId=${sessionId}`)
    this.instances.delete(sessionId)
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
    this.opts.closeApprovalSession(sessionId)
    // Leave the session entry in the store so the renderer can still show
    // the transcript if the user re-opens it; it'll be replaced on next
    // create(). Dispatch exited so the UI stops showing "running".
    this.dispatchState(sessionId, 'exited', {
      exitReason: 'killed by user'
    })
  }

  killAll(): void {
    for (const id of Array.from(this.instances.keys())) this.kill(id)
  }

  private handleStreamLine(instance: JsonClaudeInstance, line: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      log(
        'json-claude',
        `parse error sessionId=${instance.sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
      return
    }
    const type = parsed['type']
    const subtype = parsed['subtype']
    if (type === 'system' && subtype === 'init') {
      // Session id already known (we pinned it). Nothing to dispatch.
      return
    }
    if (type === 'assistant') {
      const blocks = extractAssistantBlocks(parsed)
      if (blocks.length === 0) return
      this.appendEntry(instance, {
        kind: 'assistant',
        blocks,
        timestamp: Date.now(),
        entryId: `${instance.sessionId}-a-${instance.entryCounter++}`
      })
      return
    }
    if (type === 'user') {
      const results = extractToolResults(parsed)
      for (const r of results) {
        this.store.dispatch({
          type: 'jsonClaude/toolResultAttached',
          payload: {
            sessionId: instance.sessionId,
            toolUseId: r.toolUseId,
            content: r.content,
            isError: r.isError
          }
        })
      }
      return
    }
    if (type === 'result') {
      this.dispatchBusy(instance.sessionId, false)
      return
    }
    // Ignore rate_limit_event and unknown types for now — they become
    // Phase 3 UX.
  }

  private appendEntry(
    instance: JsonClaudeInstance,
    entry: JsonClaudeChatEntry
  ): void {
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: { sessionId: instance.sessionId, entry }
    })
  }

  private dispatchState(
    sessionId: string,
    state: JsonClaudeSessionState,
    extra?: { exitCode?: number | null; exitReason?: string | null }
  ): void {
    this.store.dispatch({
      type: 'jsonClaude/sessionStateChanged',
      payload: { sessionId, state, ...extra }
    })
  }

  private dispatchBusy(sessionId: string, busy: boolean): void {
    this.store.dispatch({
      type: 'jsonClaude/busyChanged',
      payload: { sessionId, busy }
    })
  }
}

function extractAssistantBlocks(ev: Record<string, unknown>): JsonClaudeMessageBlock[] {
  const message = ev['message'] as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out: JsonClaudeMessageBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    const t = block['type']
    if (t === 'text' && typeof block['text'] === 'string') {
      out.push({ type: 'text', text: block['text'] as string })
    } else if (t === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: typeof block['id'] === 'string' ? (block['id'] as string) : undefined,
        name: typeof block['name'] === 'string' ? (block['name'] as string) : undefined,
        input:
          block['input'] && typeof block['input'] === 'object' && !Array.isArray(block['input'])
            ? (block['input'] as Record<string, unknown>)
            : undefined
      })
    }
  }
  return out
}

function extractToolResults(
  ev: Record<string, unknown>
): Array<{ toolUseId: string; content: string; isError: boolean }> {
  const message = ev['message'] as { content?: unknown } | undefined
  const content = message?.content
  if (!Array.isArray(content)) return []
  const out: Array<{ toolUseId: string; content: string; isError: boolean }> = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Record<string, unknown>
    if (b['type'] !== 'tool_result') continue
    const id = typeof b['tool_use_id'] === 'string' ? (b['tool_use_id'] as string) : ''
    if (!id) continue
    const rawContent = b['content']
    const text =
      typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent
              .map((p) => {
                if (typeof p === 'object' && p && 'text' in (p as Record<string, unknown>)) {
                  return String((p as Record<string, unknown>)['text'])
                }
                return ''
              })
              .join('\n')
          : JSON.stringify(rawContent)
    out.push({
      toolUseId: id,
      content: text,
      isError: Boolean(b['is_error'])
    })
  }
  return out
}

