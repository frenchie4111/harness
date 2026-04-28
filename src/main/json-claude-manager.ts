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
import type { ClaudeLaunchSettings } from './claude-launch'
import { log } from './debug'
import { shellQuote } from './shell-quote'

interface JsonClaudeInstance {
  proc: ChildProcessWithoutNullStreams
  sessionId: string
  worktreePath: string
  buf: string
  /** Monotonically increasing counter used to build stable chat entry ids. */
  entryCounter: number
  /** In-flight assistant message tracked for --include-partial-messages.
   *  Cleared when the consolidated `assistant` event arrives (or the
   *  proc exits). One assistant turn at a time — claude doesn't
   *  multiplex turns through stream-json. */
  partial: PartialMessageState | null
}

interface PartialMessageState {
  messageId: string
  entryId: string
  pendingText: string
  pendingThinking: string
  flushTimer: NodeJS.Timeout | null
  placeholderCreated: boolean
}

/** ms to coalesce text deltas before dispatching. Below ~16ms re-renders
 *  start to dominate; much higher feels laggy. */
const PARTIAL_TEXT_FLUSH_MS = 30

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
  /** Resolves the Claude launch flags (--append-system-prompt, --model,
   *  --name) at spawn time from the live config + worktree list. Same
   *  source of truth as the xterm spawn path; see buildClaudeLaunchSettings
   *  in claude-launch.ts. */
  getLaunchSettings: (worktreePath: string) => ClaudeLaunchSettings
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
  /** Per-cwd slash command list, sourced from a one-shot probe (see
   *  probeSlashCommands). Cached because the list is stable across
   *  sessions in the same worktree — it depends on the user's installed
   *  Skills + plugin commands + project-local `.claude/commands/*.md`,
   *  none of which change during normal use. */
  private slashCommandsByCwd = new Map<string, string[]>()
  /** Inflight probes per cwd so concurrent create() calls share one. */
  private probeInflightByCwd = new Map<string, Promise<string[]>>()

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

    const launchSettings = this.opts.getLaunchSettings(worktreePath)
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      permissionMode,
      '--permission-prompt-tool',
      'mcp__harness-permissions__approve',
      '--mcp-config',
      JSON.stringify(mcpConfig),
      ...resumeOrSet
    ]
    if (launchSettings.systemPrompt) {
      args.push('--append-system-prompt', launchSettings.systemPrompt)
    }
    if (launchSettings.model && !claudeCommand.includes('--model')) {
      args.push('--model', launchSettings.model)
    }
    if (launchSettings.sessionName) {
      args.push('--name', launchSettings.sessionName)
    }

    // Build the command line via login shell so the user's full PATH
    // (Homebrew, nvm, etc.) is available — same pattern PtyManager uses
    // for classic Claude tabs. We use POSIX single-quote escaping
    // because the system prompt contains backticks (e.g. `key`,
    // `zsh -ilc <command>`) which would be command-substituted inside
    // JSON.stringify's double quotes.
    const quoted = args.map(shellQuote).join(' ')
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
      entryCounter: 0,
      partial: null
    }
    this.instances.set(sessionId, instance)
    log('json-claude', `create spawned sessionId=${sessionId} pid=${proc.pid ?? '?'} → running`)
    this.dispatchState(sessionId, 'running')

    // Kick a slash-command probe in the background. Result populates the
    // slice so the autocomplete popover can render before the user sends
    // their first turn (the real session's init won't fire until then).
    void this.ensureSlashCommandsForCwd(worktreePath).then((list) => {
      if (list.length === 0) return
      // Guard: the session may have been killed between probe start and
      // probe finish.
      const live = this.store.getSnapshot().state.jsonClaude.sessions[sessionId]
      if (!live) return
      this.store.dispatch({
        type: 'jsonClaude/slashCommandsChanged',
        payload: { sessionId, slashCommands: list }
      })
    })

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
      this.clearPartial(instance)
      this.dispatchState(sessionId, 'exited', {
        exitCode: code,
        exitReason: signal ? `signal ${signal}` : code === 0 ? 'clean' : `exit ${code}`
      })
      this.dispatchBusy(sessionId, false)
      this.instances.delete(sessionId)
      this.opts.closeApprovalSession(sessionId)
    })
  }

  send(
    sessionId: string,
    text: string,
    images?: Array<{ mediaType: string; data: string; path: string }>
  ): void {
    const inst = this.instances.get(sessionId)
    if (!inst) return
    const hasImages = !!images && images.length > 0
    this.appendEntry(inst, {
      kind: 'user',
      text,
      timestamp: Date.now(),
      entryId: `${sessionId}-u-${inst.entryCounter++}`,
      // Path-only image refs (no bytes) so the renderer can fetch each
      // for thumbnail rendering without bloating the state event.
      ...(hasImages
        ? {
            images: images!
              .filter((img) => img.path.length > 0)
              .map((img) => ({ path: img.path, mediaType: img.mediaType }))
          }
        : {})
    })
    this.dispatchBusy(sessionId, true)
    // Build content array when images are attached. The Anthropic
    // Messages API (which claude -p stream-json proxies) expects:
    //   [{type:'text', text}, {type:'image', source:{type:'base64',
    //     media_type, data}}]
    // String content stays the wire shape when there are no images so
    // we don't change the format for the most common path.
    //
    // We also annotate the text block with a "(image attached at <path>)"
    // line per image so Claude has both the inline pixels (for instant
    // recognition) and an on-disk path (for Read/Bash/Write tool calls
    // — moving, transforming, copying). Pasted images are written by
    // the renderer via writeJsonClaudeAttachmentImage; dropped images
    // reuse the original disk path.
    const annotatedText = hasImages
      ? [
          text,
          ...images!
            .filter((img) => img.path.length > 0)
            .map((img) => `(image attached at ${img.path})`)
        ]
          .filter((s) => s.length > 0)
          .join('\n')
      : text
    const content: unknown = hasImages
      ? [
          ...(annotatedText ? [{ type: 'text', text: annotatedText }] : []),
          ...images!.map((img) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mediaType,
              data: img.data
            }
          }))
        ]
      : text
    const payload = {
      type: 'user',
      message: { role: 'user', content }
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
    this.clearPartial(inst)
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
    this.clearPartial(inst)
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

  /** Spawn a one-shot `claude -p` probe to harvest the system/init event's
   *  slash_commands list. We need this because claude in stream-json input
   *  mode never emits init until a real user message arrives — so the
   *  popover would be empty for the user's first turn. The probe sends a
   *  trivial user message immediately followed by an interrupt, which
   *  fires init then aborts before any model tokens are spent ($0 cost,
   *  verified by spike). Result is cached per-cwd so subsequent sessions
   *  in the same worktree get it instantly. */
  private probeSlashCommands(cwd: string): Promise<string[]> {
    return new Promise((resolve) => {
      const claudeCommand = this.opts.getClaudeCommand() || 'claude'
      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose'
      ]
      const quoted = args.map((a) => JSON.stringify(a)).join(' ')
      const cmdLine = `${claudeCommand} ${quoted}`
      const envVars = this.opts.getClaudeEnvVars() || {}
      const childEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') childEnv[k] = v
      }
      delete childEnv.CLAUDE_HARNESS_ID
      delete childEnv.HARNESS_TERMINAL_ID
      log('json-claude', `probe spawn cwd=${cwd}`)
      let proc: ChildProcessWithoutNullStreams
      try {
        proc = spawn('/bin/zsh', ['-ilc', cmdLine], {
          cwd,
          env: {
            ...childEnv,
            ...envVars,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
          },
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (err) {
        log(
          'json-claude',
          `probe spawn failed cwd=${cwd}`,
          err instanceof Error ? err.message : String(err)
        )
        resolve([])
        return
      }
      let buf = ''
      let resolved = false
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true
          log('json-claude', `probe timeout cwd=${cwd}`)
          try {
            proc.kill('SIGTERM')
          } catch {
            /* ignore */
          }
          resolve([])
        }
      }, 15_000)
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line || resolved) continue
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          if (parsed['type'] === 'system' && parsed['subtype'] === 'init') {
            const slashCommands = parsed['slash_commands']
            const filtered = Array.isArray(slashCommands)
              ? slashCommands.filter((s): s is string => typeof s === 'string')
              : []
            log(
              'json-claude',
              `probe init received cwd=${cwd} count=${filtered.length}`
            )
            resolved = true
            clearTimeout(timeout)
            try {
              proc.kill('SIGTERM')
            } catch {
              /* ignore */
            }
            resolve(filtered)
            return
          }
        }
      })
      proc.on('exit', () => {
        if (!resolved) {
          resolved = true
          clearTimeout(timeout)
          log('json-claude', `probe exited before init cwd=${cwd}`)
          resolve([])
        }
      })
      // Pump the message + interrupt. Send-then-interrupt makes claude emit
      // init (which is what we want) then abort the turn at $0 cost.
      try {
        proc.stdin.write(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: '.' }
          }) + '\n'
        )
        proc.stdin.write(
          JSON.stringify({
            type: 'control_request',
            request_id: randomUUID(),
            request: { subtype: 'interrupt' }
          }) + '\n'
        )
      } catch (err) {
        log(
          'json-claude',
          `probe stdin write failed cwd=${cwd}`,
          err instanceof Error ? err.message : String(err)
        )
      }
    })
  }

  private ensureSlashCommandsForCwd(cwd: string): Promise<string[]> {
    const cached = this.slashCommandsByCwd.get(cwd)
    if (cached) return Promise.resolve(cached)
    const inflight = this.probeInflightByCwd.get(cwd)
    if (inflight) return inflight
    const p = this.probeSlashCommands(cwd).then((list) => {
      if (list.length > 0) this.slashCommandsByCwd.set(cwd, list)
      this.probeInflightByCwd.delete(cwd)
      return list
    })
    this.probeInflightByCwd.set(cwd, p)
    return p
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
      // Session id is already known (we pinned it via --session-id), but
      // the init payload includes the canonical slash_commands list — keep
      // it as a freshness signal in case anything's been installed since
      // the per-cwd probe ran. (Init only fires once a real user message
      // arrives — see probeSlashCommands for why we also probe up-front.)
      const slashCommands = parsed['slash_commands']
      if (Array.isArray(slashCommands)) {
        const filtered = slashCommands.filter(
          (s): s is string => typeof s === 'string'
        )
        this.slashCommandsByCwd.set(instance.worktreePath, filtered)
        this.store.dispatch({
          type: 'jsonClaude/slashCommandsChanged',
          payload: { sessionId: instance.sessionId, slashCommands: filtered }
        })
      }
      return
    }
    if (type === 'stream_event') {
      this.handleStreamEvent(instance, parsed)
      return
    }
    if (type === 'assistant') {
      const blocks = extractAssistantBlocks(parsed)
      if (blocks.length === 0) {
        // No content (e.g. stop-only turn). Still clear any in-flight
        // partial so the cursor disappears.
        this.clearPartial(instance)
        return
      }
      // Drain any pending coalesced deltas before reconciling.
      this.flushPartialDeltas(instance)
      const message = parsed['message'] as { id?: string } | undefined
      const messageId = message?.id
      if (
        instance.partial &&
        messageId &&
        instance.partial.messageId === messageId
      ) {
        const entryId = instance.partial.entryId
        const placeholderCreated = instance.partial.placeholderCreated
        this.clearPartial(instance)
        if (placeholderCreated) {
          this.store.dispatch({
            type: 'jsonClaude/assistantEntryFinalized',
            payload: { sessionId: instance.sessionId, entryId, blocks }
          })
        } else {
          // No placeholder ever materialized (e.g. message was tool_use
          // only, no text deltas). Append normally with the message-
          // derived id so future deltas for the same id reconcile.
          this.appendEntry(instance, {
            kind: 'assistant',
            blocks,
            timestamp: Date.now(),
            entryId
          })
        }
        return
      }
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

  /** Stream-event handler for the SDK delta events claude emits when
   *  --include-partial-messages is on. Mirrors the Anthropic Messages
   *  SDK shapes: message_start declares the message id, content_block_*
   *  brackets each block, content_block_delta carries text_delta or
   *  input_json_delta. We only render text deltas progressively today;
   *  input_json_delta is on the backlog (see plans/json-mode-native-chat.md).
   *  Text deltas are coalesced (~30ms) before dispatch so a fast model
   *  doesn't trigger a re-render per token. */
  private handleStreamEvent(
    instance: JsonClaudeInstance,
    parsed: Record<string, unknown>
  ): void {
    const event = parsed['event'] as Record<string, unknown> | undefined
    if (!event) return
    const eventType = event['type']
    if (eventType === 'message_start') {
      const message = event['message'] as { id?: string } | undefined
      const messageId = message?.id
      if (!messageId) return
      // Drop any prior in-flight partial defensively (shouldn't happen
      // unless the consolidated event was missed).
      this.clearPartial(instance)
      instance.partial = {
        messageId,
        entryId: `${instance.sessionId}-a-${messageId}`,
        pendingText: '',
        pendingThinking: '',
        flushTimer: null,
        placeholderCreated: false
      }
      return
    }
    if (!instance.partial) return
    if (eventType === 'content_block_start') {
      const rawBlock = event['content_block'] as Record<string, unknown> | undefined
      const newBlock = streamEventBlockToMessageBlock(rawBlock)
      if (!newBlock) return
      // Make sure any pending deltas land in the previous block before
      // we introduce a new block.
      this.flushPartialDeltas(instance)
      if (!instance.partial.placeholderCreated) {
        this.appendStoreEntry(instance.sessionId, {
          kind: 'assistant',
          blocks: [newBlock],
          timestamp: Date.now(),
          entryId: instance.partial.entryId,
          isPartial: true
        })
        instance.partial.placeholderCreated = true
      } else {
        this.store.dispatch({
          type: 'jsonClaude/assistantBlockAppended',
          payload: {
            sessionId: instance.sessionId,
            entryId: instance.partial.entryId,
            block: newBlock
          }
        })
      }
      return
    }
    if (eventType === 'content_block_delta') {
      const delta = event['delta'] as
        | { type?: string; text?: string; thinking?: string }
        | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        instance.partial.pendingText += delta.text
        this.scheduleDeltaFlush(instance)
      } else if (
        delta?.type === 'thinking_delta' &&
        typeof delta.thinking === 'string'
      ) {
        instance.partial.pendingThinking += delta.thinking
        this.scheduleDeltaFlush(instance)
      }
      // input_json_delta is intentionally dropped — see backlog.
      // signature_delta carries the cryptographic signature for a
      // thinking block; nothing to render in the UI.
      return
    }
    if (eventType === 'content_block_stop' || eventType === 'message_stop') {
      this.flushPartialDeltas(instance)
      return
    }
    // message_delta carries stop_reason + usage; we don't render either
    // here. Cost meter / rate-limit work can pick those up later.
  }

  private ensurePlaceholderEntry(instance: JsonClaudeInstance): void {
    if (!instance.partial || instance.partial.placeholderCreated) return
    this.appendStoreEntry(instance.sessionId, {
      kind: 'assistant',
      blocks: [{ type: 'text', text: '' }],
      timestamp: Date.now(),
      entryId: instance.partial.entryId,
      isPartial: true
    })
    instance.partial.placeholderCreated = true
  }

  private scheduleDeltaFlush(instance: JsonClaudeInstance): void {
    if (!instance.partial || instance.partial.flushTimer) return
    instance.partial.flushTimer = setTimeout(() => {
      // Re-fetch instance state under timer — the instance object may
      // have been torn down between schedule and fire.
      const live = this.instances.get(instance.sessionId)
      if (!live) return
      this.flushPartialDeltas(live)
    }, PARTIAL_TEXT_FLUSH_MS)
  }

  /** Drain whichever delta buffers have content. Both share a single
   *  flush timer because there's only ever one block actively receiving
   *  deltas at a time. */
  private flushPartialDeltas(instance: JsonClaudeInstance): void {
    if (!instance.partial) return
    if (instance.partial.flushTimer) {
      clearTimeout(instance.partial.flushTimer)
      instance.partial.flushTimer = null
    }
    this.flushPartialText(instance)
    this.flushPartialThinking(instance)
  }

  private flushPartialText(instance: JsonClaudeInstance): void {
    if (!instance.partial) return
    if (!instance.partial.pendingText) return
    const text = instance.partial.pendingText
    instance.partial.pendingText = ''
    this.ensurePlaceholderEntry(instance)
    this.store.dispatch({
      type: 'jsonClaude/assistantTextDelta',
      payload: {
        sessionId: instance.sessionId,
        entryId: instance.partial.entryId,
        textDelta: text
      }
    })
  }

  private flushPartialThinking(instance: JsonClaudeInstance): void {
    if (!instance.partial) return
    if (!instance.partial.pendingThinking) return
    const text = instance.partial.pendingThinking
    instance.partial.pendingThinking = ''
    this.ensurePlaceholderEntry(instance)
    this.store.dispatch({
      type: 'jsonClaude/assistantThinkingDelta',
      payload: {
        sessionId: instance.sessionId,
        entryId: instance.partial.entryId,
        textDelta: text
      }
    })
  }

  private clearPartial(instance: JsonClaudeInstance): void {
    if (!instance.partial) return
    if (instance.partial.flushTimer) {
      clearTimeout(instance.partial.flushTimer)
      instance.partial.flushTimer = null
    }
    instance.partial.pendingText = ''
    instance.partial.pendingThinking = ''
    instance.partial = null
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

function streamEventBlockToMessageBlock(
  block: Record<string, unknown> | undefined
): JsonClaudeMessageBlock | null {
  if (!block) return null
  const t = block['type']
  if (t === 'text') {
    return {
      type: 'text',
      text: typeof block['text'] === 'string' ? (block['text'] as string) : ''
    }
  }
  if (t === 'thinking') {
    return {
      type: 'thinking',
      text:
        typeof block['thinking'] === 'string'
          ? (block['thinking'] as string)
          : ''
    }
  }
  if (t === 'tool_use') {
    return {
      type: 'tool_use',
      id: typeof block['id'] === 'string' ? (block['id'] as string) : undefined,
      name:
        typeof block['name'] === 'string' ? (block['name'] as string) : undefined,
      // Input arrives via input_json_delta — we don't accumulate those
      // today, so the placeholder card renders the tool name only until
      // the consolidated assistant event reconciles with the full
      // input. See "Backlog follow-ups from partial-message streaming"
      // in plans/json-mode-native-chat.md.
      input: {}
    }
  }
  return null
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
    } else if (t === 'thinking') {
      out.push({
        type: 'thinking',
        text:
          typeof block['thinking'] === 'string'
            ? (block['thinking'] as string)
            : ''
      })
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

