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
import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { isPackaged } from './paths'
import type { Store } from './store'
import type {
  JsonClaudeChatEntry,
  JsonClaudeMessageBlock,
  JsonClaudePermissionMode,
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

export interface JsonClaudeControlServerInfo {
  port: number
  token: string
}

export interface JsonClaudeCallerScope {
  worktreePath: string
  repoRoot: string
  isMain: boolean
}

export interface JsonClaudeManagerOptions {
  getClaudeCommand: () => string
  getApprovalSocketPath: (sessionId: string) => string
  closeApprovalSession: (sessionId: string) => void
  getClaudeEnvVars: () => Record<string, string>
  /** Looked up from main when building the inline MCP config. Returning
   *  null means the harness-control bridge isn't injected (settings flag
   *  off, or control server not yet up). */
  getControlServer: () => JsonClaudeControlServerInfo | null
  /** Returns the bundled harness-control bridge script path. Lives in
   *  resources/ same as permission-prompt-mcp.js — index.ts already
   *  knows how to resolve it via getBridgeScriptPath(). */
  getControlBridgeScriptPath: () => string
  /** True when the user has disabled the harness-control MCP via
   *  settings.harnessMcpEnabled. Skips the bridge entry entirely. */
  isHarnessMcpEnabled: () => boolean
  /** Looks up scope (worktree + repo + isMain) for a given session id.
   *  Mirrors resolveCallerScope() in index.ts but only needs the
   *  worktree/repo bits, not the terminalId echo. */
  getCallerScope: (sessionId: string) => JsonClaudeCallerScope | null
}

/** Path to the bundled stdio MCP server we point Claude's
 *  --permission-prompt-tool at. Mirrors src/main/mcp-config.ts: in dev
 *  the file lives in resources/ at the repo root; in packaged builds
 *  it's copied by electron-builder to process.resourcesPath. paths.ts's
 *  `isPackaged()` returns false outside Electron so the dev fallback
 *  path is what the headless build hits. */
function permissionPromptScriptPath(): string {
  if (isPackaged()) {
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

  /** Replay the on-disk session jsonl into the slice as chat entries.
   *  Called from the jsonClaude:start IPC handler before spawning the
   *  subprocess. Without this, --resume restores Claude's context but
   *  the renderer's chat scrollback is empty after a full app restart.
   *  No-op if the jsonl doesn't exist yet (first turn) or the session
   *  already has entries (renderer reload — main's slice survived). */
  seedFromTranscript(sessionId: string, worktreePath: string): void {
    const session =
      this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
    if (session && session.entries.length > 0) return

    const transcriptPath = join(
      homedir(),
      '.claude',
      'projects',
      worktreePath.replace(/[^a-zA-Z0-9]/g, '-'),
      `${sessionId}.jsonl`
    )
    if (!existsSync(transcriptPath)) return

    let counter = 0
    let raw: string
    try {
      raw = readFileSync(transcriptPath, 'utf8')
    } catch (err) {
      log(
        'json-claude',
        `seed read failed sessionId=${sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
      return
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }
      const type = parsed['type']
      // The session jsonl contains the same user/assistant message
      // shapes the live stream emits, plus internal bookkeeping types
      // (queue-operation, attachment, ai-title, last-prompt) we ignore.
      if (type === 'user') {
        const message = parsed['message'] as { content?: unknown } | undefined
        const content = message?.content
        if (typeof content === 'string') {
          this.appendStoreEntry(sessionId, {
            kind: 'user',
            text: content,
            timestamp: Date.now(),
            entryId: `${sessionId}-seed-u-${counter++}`
          })
        } else if (Array.isArray(content)) {
          for (const r of extractToolResultsFromArray(content)) {
            this.store.dispatch({
              type: 'jsonClaude/toolResultAttached',
              payload: {
                sessionId,
                toolUseId: r.toolUseId,
                content: r.content,
                isError: r.isError
              }
            })
          }
        }
      } else if (type === 'assistant') {
        const blocks = extractAssistantBlocks(parsed)
        if (blocks.length === 0) continue
        this.appendStoreEntry(sessionId, {
          kind: 'assistant',
          blocks,
          timestamp: Date.now(),
          entryId: `${sessionId}-seed-a-${counter++}`
        })
      }
    }
  }

  create(
    sessionId: string,
    worktreePath: string,
    permissionMode: JsonClaudePermissionMode = 'default'
  ): void {
    if (this.instances.has(sessionId)) {
      log('json-claude', `create no-op — already running sessionId=${sessionId}`)
      return
    }
    log('json-claude', `create begin sessionId=${sessionId} mode=${permissionMode}`)
    const socketPath = this.opts.getApprovalSocketPath(sessionId)

    // MCP config — two stdio servers, both spawned via
    // ELECTRON_RUN_AS_NODE=1 against the Electron binary so we don't
    // need a separate Node install in packaged builds.
    //   * harness-permissions: receives the per-tool approval requests
    //     Claude raises via --permission-prompt-tool. Tool is 'approve'.
    //   * harness-control: the same MCP bridge used by xterm-backed
    //     Claude tabs, exposing harness-control tools (worktree mgmt,
    //     browser tabs, shell tabs, etc.). Skipped when settings has
    //     harnessMcpEnabled=false or the control server isn't up.
    const mcpServers: Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    > = {
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
    if (this.opts.isHarnessMcpEnabled()) {
      const controlInfo = this.opts.getControlServer()
      if (controlInfo) {
        const scope = this.opts.getCallerScope(sessionId)
        const controlEnv: Record<string, string> = {
          ELECTRON_RUN_AS_NODE: '1',
          HARNESS_PORT: String(controlInfo.port),
          HARNESS_TOKEN: controlInfo.token,
          // The bridge keys every control-server call by terminal id —
          // for json-claude tabs the tab id IS the session id.
          HARNESS_TERMINAL_ID: sessionId,
          HARNESS_SESSION_ID: sessionId
        }
        if (scope) {
          controlEnv.HARNESS_WORKTREE_ID = scope.worktreePath
          controlEnv.HARNESS_REPO_ROOT = scope.repoRoot
          if (scope.isMain) controlEnv.HARNESS_IS_MAIN = '1'
        }
        mcpServers['harness-control'] = {
          command: process.execPath,
          args: [this.opts.getControlBridgeScriptPath()],
          env: controlEnv
        }
      }
    }
    const mcpConfig = { mcpServers }

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
      permissionMode,
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

    log(
      'json-claude',
      `spawn sessionId=${sessionId} cwd=${worktreePath} mode=${permissionMode}`
    )

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
    log('json-claude', `create spawned sessionId=${sessionId} pid=${proc.pid ?? '?'} → running`)
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
        `exit sessionId=${sessionId} code=${code} signal=${signal} pid=${proc.pid ?? '?'}`
      )
      // Stale-exit guard: SIGTERM is async, so a kill() + create() cycle
      // on the same sessionId (permission-mode toggle, tab-type swap)
      // can register a fresh instance before the old process's exit
      // event lands. Without this check, the late exit would mark the
      // freshly-started session 'exited' and close its approval socket.
      if (this.instances.get(sessionId) !== instance) {
        log('json-claude', `exit guard bailed — stale instance sessionId=${sessionId}`)
        return
      }
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

  /** Send a stdin control_request that aborts the current turn while
   *  keeping the subprocess alive. SIGINT was the spike's first guess
   *  but it tears the whole session down; the actual protocol — found
   *  by reading the binary — is:
   *    {type: "control_request", request_id: <uuid>,
   *     request: {subtype: "interrupt"}}
   *  Claude's handler hits b.abortController.abort() on receipt, which
   *  cancels mid-turn without exiting. The partial turn is still
   *  captured in the session jsonl, so --resume picks up cleanly. */
  interrupt(sessionId: string): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    log('json-claude', `interrupt sessionId=${sessionId}`)
    const frame = {
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' }
    }
    try {
      inst.proc.stdin.write(JSON.stringify(frame) + '\n')
    } catch (err) {
      log(
        'json-claude',
        `interrupt write failed sessionId=${sessionId}`,
        err instanceof Error ? err.message : String(err)
      )
    }
    // Flip busy off optimistically; the result event (when the abort
    // resolves into a turn boundary) will also clear it.
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

  /** Change --permission-mode mid-session. Kills the current subprocess
   *  and respawns with the new mode; --resume on the spawn path picks up
   *  the existing session jsonl, so conversation state is preserved.
   *  Noop if the session isn't currently running. */
  setPermissionMode(sessionId: string, mode: JsonClaudePermissionMode): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    const worktreePath = inst.worktreePath
    log(
      'json-claude',
      `permissionMode change sessionId=${sessionId} mode=${mode} — restarting`
    )
    // Kill the running subprocess synchronously so its 'exit' handler
    // drains the instances map before we re-create.
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
    this.create(sessionId, worktreePath, mode)
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
    this.appendStoreEntry(instance.sessionId, entry)
  }

  private appendStoreEntry(sessionId: string, entry: JsonClaudeChatEntry): void {
    this.store.dispatch({
      type: 'jsonClaude/entryAppended',
      payload: { sessionId, entry }
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
  return extractToolResultsFromArray(content)
}

function extractToolResultsFromArray(
  content: unknown[]
): Array<{ toolUseId: string; content: string; isError: boolean }> {
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

