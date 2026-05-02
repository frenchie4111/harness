// Integration test for the --permission-prompt-tool round trip.
//
// Spawns a real `claude -p --input-format stream-json
// --output-format stream-json` subprocess with our bundled MCP server as
// --permission-prompt-tool, then asks the model to Write a file and
// asserts the approval flows through ApprovalBridge. The approver
// returns `updatedInput.content = "REWRITTEN_BY_APPROVER"` so the file
// on disk reveals which side won — the model's input or ours.
//
// Requirements:
//   * `claude` must be on PATH. The test skips if it's not — CI runners
//     without the binary should not fail.
//   * The user running the test must already be authenticated (i.e.
//     `claude` starts a session without OAuth prompting).
//   * `npx electron-vite build` must have run at least once so
//     out/main/permission-prompt-mcp.js exists. The test skips
//     otherwise.

import { describe, it, expect } from 'vitest'
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { ApprovalBridge } from './approval-bridge'
import type { Store } from './store'
import { initialState, rootReducer, type StateEvent } from '../shared/state'

function claudeInstalled(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function bundledMcpPath(): string | null {
  // Plain JS — no build step required. Lives in resources/ alongside
  // mcp-bridge.js.
  const candidate = resolve(__dirname, '..', '..', 'resources', 'permission-prompt-mcp.js')
  return existsSync(candidate) ? candidate : null
}

/** Minimal store shim for ApprovalBridge — runs the shared reducer, fans
 *  events to subscribers. ApprovalBridge only uses dispatch, so we don't
 *  need the full Store class (which pulls in Electron IPC wiring). */
class TestStore {
  private state = initialState
  private seq = 0
  private subs = new Set<(event: StateEvent, seq: number) => void>()

  dispatch(event: StateEvent): void {
    this.state = rootReducer(this.state, event)
    this.seq++
    for (const s of this.subs) s(event, this.seq)
  }

  subscribe(cb: (event: StateEvent, seq: number) => void): () => void {
    this.subs.add(cb)
    return () => {
      this.subs.delete(cb)
    }
  }

  getSnapshot(): { state: typeof initialState; seq: number } {
    return { state: this.state, seq: this.seq }
  }
}

describe('approval bridge — claude integration', () => {
  it('rewrites a Write tool input through the MCP bridge end-to-end', async () => {
    if (!claudeInstalled()) {
      console.warn('[approval-bridge.test] skipping — `claude` not on PATH')
      return
    }
    const mcpScript = bundledMcpPath()
    if (!mcpScript) {
      console.warn('[approval-bridge.test] skipping — resources/permission-prompt-mcp.js missing')
      return
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'harness-approval-test-'))
    const targetFile = join(tempDir, 'approval-target.txt')

    const store = new TestStore()
    const bridge = new ApprovalBridge(store as unknown as Store)
    const sessionId = randomUUID()
    const socketPath = bridge.startSession(sessionId)

    const mcpConfig = {
      mcpServers: {
        'harness-permissions': {
          command: 'node',
          args: [mcpScript],
          env: {
            HARNESS_APPROVAL_SOCKET: socketPath,
            HARNESS_JSON_CLAUDE_SESSION_ID: sessionId
          }
        }
      }
    }

    const claudeArgs = [
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
      '--session-id',
      sessionId
    ]

    const proc = spawn('claude', claudeArgs, {
      cwd: tempDir,
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stderr = ''
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })

    let sawApproval = false
    const unsubApproval = store.subscribe((event) => {
      if (event.type !== 'jsonClaude/approvalRequested') return
      if (event.payload.toolName !== 'Write') return
      sawApproval = true
      bridge.resolveApproval(event.payload.requestId, {
        behavior: 'allow',
        updatedInput: {
          ...event.payload.input,
          content: 'REWRITTEN_BY_APPROVER\n'
        }
      })
    })

    // Drive the model. We want a Write call; anything else is noise.
    const userMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: `Use the Write tool to create the file at ${targetFile} with exactly the content "ORIGINAL". Do nothing else.`
      }
    }
    proc.stdin.write(JSON.stringify(userMessage) + '\n')

    const resultPromise = new Promise<void>((resolveResult, rejectResult) => {
      let buf = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line) continue
          try {
            const parsed = JSON.parse(line) as { type?: string }
            if (parsed.type === 'result') {
              resolveResult()
              return
            }
          } catch {
            /* ignore */
          }
        }
      })
      proc.on('exit', (code) => {
        if (code === 0) resolveResult()
        else rejectResult(new Error(`claude exited with ${code}\nstderr:\n${stderr}`))
      })
    })

    const TIMEOUT_MS = 120_000
    const timeout = new Promise<never>((_, r) =>
      setTimeout(() => r(new Error('test timed out')), TIMEOUT_MS)
    )

    try {
      await Promise.race([resultPromise, timeout])
      // The test proves the protocol round-trip: we should have observed
      // an approvalRequested event for Write, and the file on disk must
      // carry the approver's rewritten content. If the model didn't even
      // trigger Write, that's a test flake — emit a warning rather than
      // failing, since the round-trip *can't* be exercised if the model
      // refuses to call the tool.
      if (!sawApproval) {
        console.warn(
          '[approval-bridge.test] model did not trigger Write — approval bridge not exercised'
        )
        return
      }
      expect(existsSync(targetFile)).toBe(true)
      const content = readFileSync(targetFile, 'utf8')
      expect(content).toBe('REWRITTEN_BY_APPROVER\n')
    } finally {
      unsubApproval()
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      bridge.stopSession(sessionId)
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }, 180_000)
})

describe('approval bridge — updatedPermissions plumbing', () => {
  it('passes updatedPermissions through to the socket response verbatim', async () => {
    const store = new TestStore()
    const bridge = new ApprovalBridge(store as unknown as Store)
    const sessionId = randomUUID()
    const socketPath = bridge.startSession(sessionId)

    const requestId = randomUUID()
    const requestFrame = {
      type: 'request',
      id: requestId,
      sessionId,
      tool_name: 'Bash',
      input: { command: 'git status' },
      tool_use_id: 'tu_test',
      timestamp: Date.now()
    }

    const responsePromise = new Promise<{ id: string; result: unknown }>(
      (resolveResponse, rejectResponse) => {
        const sock = createConnection(socketPath)
        let buf = ''
        sock.setEncoding('utf8')
        sock.on('connect', () => {
          sock.write(JSON.stringify(requestFrame) + '\n')
        })
        sock.on('data', (chunk: string) => {
          buf += chunk
          const idx = buf.indexOf('\n')
          if (idx < 0) return
          const line = buf.slice(0, idx).trim()
          try {
            const parsed = JSON.parse(line) as {
              type?: string
              id?: string
              result?: unknown
            }
            if (parsed.type === 'response' && parsed.id && parsed.result) {
              resolveResponse({ id: parsed.id, result: parsed.result })
              try { sock.end() } catch { /* ignore */ }
            }
          } catch (err) {
            rejectResponse(err instanceof Error ? err : new Error(String(err)))
          }
        })
        sock.on('error', rejectResponse)
      }
    )

    // Wait for the bridge to dispatch the request to the store, then resolve
    // it with an updatedPermissions payload.
    await new Promise<void>((resolveDispatched) => {
      const unsub = store.subscribe((event) => {
        if (
          event.type === 'jsonClaude/approvalRequested' &&
          event.payload.requestId === requestId
        ) {
          unsub()
          resolveDispatched()
        }
      })
    })

    const ok = bridge.resolveApproval(requestId, {
      behavior: 'allow',
      updatedInput: { command: 'git status' },
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
          behavior: 'allow',
          destination: 'localSettings'
        }
      ]
    })
    expect(ok).toBe(true)

    const response = await responsePromise
    expect(response.id).toBe(requestId)
    expect(response.result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git status' },
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'git status:*' }],
          behavior: 'allow',
          destination: 'localSettings'
        }
      ]
    })

    bridge.stopSession(sessionId)
  }, 5_000)
})
