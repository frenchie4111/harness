// Stdio MCP server that Claude Code invokes via `--permission-prompt-tool`.
// Runs as a child process of main via ELECTRON_RUN_AS_NODE=1 against the
// Electron binary (same pattern as resources/mcp-bridge.js), spawned by
// JsonClaudeManager. On each tools/call it opens a connection to the Unix
// socket whose path is passed via HARNESS_APPROVAL_SOCKET, forwards the
// request, waits for main to write back a PermissionResult, and returns
// that as the tool's text content block.
//
// Protocol boundary with Claude Code: the returned text MUST be a
// stringified JSON `PermissionResult` of the shape documented in
// plans/json-mode-native-chat.md (behavior: 'allow' | 'deny', with
// optional updatedInput / updatedPermissions / interrupt / message).
//
// The socket wire format is NDJSON. Frames we emit toward main:
//   {type: 'request', id, tool_name, input, tool_use_id, timestamp}
// Frames main writes back:
//   {type: 'response', id, result: PermissionResult}
// Plus, when the connection closes before a response arrives, this process
// synthesises {behavior:'deny', message:'harness disconnected'} so the
// model always gets a coherent reply instead of hanging the turn.

import { createInterface } from 'node:readline'
import { createConnection, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'

interface ApprovalResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: unknown[]
  message?: string
  interrupt?: boolean
}

const SOCKET_PATH = process.env['HARNESS_APPROVAL_SOCKET']
const SESSION_ID = process.env['HARNESS_JSON_CLAUDE_SESSION_ID'] || ''

if (!SOCKET_PATH) {
  process.stderr.write('[harness-approval-mcp] HARNESS_APPROVAL_SOCKET not set\n')
  process.exit(1)
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function logErr(...parts: unknown[]): void {
  process.stderr.write('[harness-approval-mcp] ' + parts.join(' ') + '\n')
}

const APPROVE_TOOL = {
  name: 'approve',
  description: 'Request human approval before running a tool',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tool_name: { type: 'string' as const },
      input: { type: 'object' as const },
      tool_use_id: { type: 'string' as const }
    },
    required: ['tool_name', 'input']
  }
}

interface PendingApproval {
  socket: Socket
  resolve: (result: ApprovalResult) => void
}

const pending = new Map<string, PendingApproval>()

async function requestApproval(args: {
  tool_name: string
  input: Record<string, unknown>
  tool_use_id?: string
}): Promise<ApprovalResult> {
  return new Promise<ApprovalResult>((resolve) => {
    const id = randomUUID()
    let resolved = false
    const socket = createConnection(SOCKET_PATH!)
    let buf = ''

    const settle = (result: ApprovalResult): void => {
      if (resolved) return
      resolved = true
      pending.delete(id)
      try {
        socket.end()
      } catch {
        /* ignore */
      }
      resolve(result)
    }

    pending.set(id, { socket, resolve: settle })

    socket.on('connect', () => {
      try {
        socket.write(
          JSON.stringify({
            type: 'request',
            id,
            sessionId: SESSION_ID,
            tool_name: args.tool_name,
            input: args.input,
            tool_use_id: args.tool_use_id,
            timestamp: Date.now()
          }) + '\n'
        )
      } catch (err) {
        logErr('write failed', err instanceof Error ? err.message : String(err))
        settle({ behavior: 'deny', message: 'harness write failed' })
      }
    })

    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as { type?: string; id?: string; result?: ApprovalResult }
          if (msg.type === 'response' && msg.id === id && msg.result) {
            settle(msg.result)
            return
          }
        } catch (err) {
          logErr('bad frame from main', err instanceof Error ? err.message : String(err))
        }
      }
    })

    socket.on('error', (err) => {
      logErr('socket error', err.message)
      settle({ behavior: 'deny', message: `harness socket error: ${err.message}` })
    })

    socket.on('close', () => {
      settle({ behavior: 'deny', message: 'harness disconnected' })
    })
  })
}

function reply(id: number | string | null | undefined, result: unknown): void {
  if (id === null || id === undefined) return
  send({ jsonrpc: '2.0', id, result })
}

function replyError(
  id: number | string | null | undefined,
  code: number,
  message: string
): void {
  if (id === null || id === undefined) return
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const id = msg['id'] as number | string | null | undefined
  const method = msg['method']

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'harness-permissions', version: '1.0.0' }
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') {
    reply(id, { tools: [APPROVE_TOOL] })
    return
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] })
    return
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] })
    return
  }
  if (method === 'tools/call') {
    const params = msg['params'] as { name?: string; arguments?: Record<string, unknown> } | undefined
    const name = params?.name
    const args = params?.arguments || {}
    if (name !== 'approve') {
      replyError(id, -32601, `unknown tool: ${name}`)
      return
    }
    const toolName = typeof args['tool_name'] === 'string' ? (args['tool_name'] as string) : ''
    const input =
      args['input'] && typeof args['input'] === 'object' && !Array.isArray(args['input'])
        ? (args['input'] as Record<string, unknown>)
        : {}
    const toolUseId =
      typeof args['tool_use_id'] === 'string' ? (args['tool_use_id'] as string) : undefined

    void requestApproval({ tool_name: toolName, input, tool_use_id: toolUseId })
      .then((result) => {
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }]
        })
      })
      .catch((err) => {
        logErr('approval failed', err instanceof Error ? err.message : String(err))
        reply(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                behavior: 'deny',
                message: err instanceof Error ? err.message : String(err)
              })
            }
          ]
        })
      })
    return
  }
  if (id !== undefined && id !== null) {
    replyError(id, -32601, `method not found: ${String(method)}`)
  }
})

process.on('SIGTERM', () => {
  for (const p of pending.values()) {
    try {
      p.socket.destroy()
    } catch {
      /* ignore */
    }
  }
  process.exit(0)
})
