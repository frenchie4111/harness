#!/usr/bin/env node
// Stdio MCP server that Claude Code invokes via --permission-prompt-tool.
// Spawned by JsonClaudeManager as a child of the Electron main process
// through `ELECTRON_RUN_AS_NODE=1 <electron-binary> <this-file>` (same
// pattern resources/mcp-bridge.js uses, so we avoid a separate Node
// dependency in packaged builds).
//
// This stays plain CommonJS JS rather than TypeScript because electron-
// vite's main-process build bundles every entry together (even with
// separate inputs, rollup's "side-effect" pass pulls in references to the
// main entry). A standalone .js file sidesteps that entirely.
//
// Protocol boundaries:
//   * stdio side: standard MCP JSON-RPC over NDJSON. We advertise a
//     single tool named `approve` and handle tools/call by delegating to
//     the Harness socket.
//   * socket side: NDJSON frames. We write
//       {type: 'request', id, sessionId, tool_name, input, tool_use_id,
//        timestamp}
//     and expect main to reply with
//       {type: 'response', id, result: PermissionResult}
//     where PermissionResult is the `--permission-prompt-tool` contract
//     in plans/json-mode-native-chat.md.

const readline = require('node:readline')
const net = require('node:net')
const crypto = require('node:crypto')

const SOCKET_PATH = process.env.HARNESS_APPROVAL_SOCKET
const SESSION_ID = process.env.HARNESS_JSON_CLAUDE_SESSION_ID || ''

if (!SOCKET_PATH) {
  process.stderr.write('[harness-approval-mcp] HARNESS_APPROVAL_SOCKET not set\n')
  process.exit(1)
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function logErr(...parts) {
  process.stderr.write('[harness-approval-mcp] ' + parts.join(' ') + '\n')
}

const APPROVE_TOOL = {
  name: 'approve',
  description: 'Request human approval before running a tool',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' }
    },
    required: ['tool_name', 'input']
  }
}

function requestApproval(args) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID()
    let resolved = false
    const socket = net.createConnection(SOCKET_PATH)
    let buf = ''

    const settle = (result) => {
      if (resolved) return
      resolved = true
      try { socket.end() } catch { /* ignore */ }
      resolve(result)
    }

    socket.on('connect', () => {
      try {
        socket.write(JSON.stringify({
          type: 'request',
          id,
          sessionId: SESSION_ID,
          tool_name: args.tool_name,
          input: args.input,
          tool_use_id: args.tool_use_id,
          // Forward Claude's own rule suggestions so the renderer can
          // surface them as "always allow" presets — same shape the
          // TUI uses for its quick-allow chips.
          permission_suggestions: args.permission_suggestions,
          description: args.description,
          timestamp: Date.now()
        }) + '\n')
      } catch (err) {
        logErr('write failed', err && err.message || String(err))
        settle({ behavior: 'deny', message: 'harness write failed' })
      }
    })

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'response' && msg.id === id && msg.result) {
            settle(msg.result)
            return
          }
        } catch (err) {
          logErr('bad frame from main', err && err.message || String(err))
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

function reply(id, result) {
  if (id === null || id === undefined) return
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  if (id === null || id === undefined) return
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const id = msg.id
  const method = msg.method

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
    const params = msg.params || {}
    const name = params.name
    const args = params.arguments || {}
    if (name !== 'approve') {
      replyError(id, -32601, `unknown tool: ${name}`)
      return
    }
    const toolName = typeof args.tool_name === 'string' ? args.tool_name : ''
    const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input)
      ? args.input
      : {}
    const toolUseId = typeof args.tool_use_id === 'string' ? args.tool_use_id : undefined
    // Pass Claude's own permission rule suggestions through (used by
    // the UI to populate the "always allow" picker with the same
    // patterns the TUI surfaces) plus the human-readable description.
    const permissionSuggestions = Array.isArray(args.permission_suggestions)
      ? args.permission_suggestions
      : undefined
    const description = typeof args.description === 'string' ? args.description : undefined

    requestApproval({
      tool_name: toolName,
      input,
      tool_use_id: toolUseId,
      permission_suggestions: permissionSuggestions,
      description
    })
      .then((result) => {
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }]
        })
      })
      .catch((err) => {
        logErr('approval failed', err && err.message || String(err))
        reply(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                behavior: 'deny',
                message: err && err.message || String(err)
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

process.on('SIGTERM', () => { process.exit(0) })
