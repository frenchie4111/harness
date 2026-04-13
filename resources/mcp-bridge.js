#!/usr/bin/env node
// Harness MCP bridge — minimal MCP stdio server that forwards tool calls
// to the Harness control HTTP server running inside the Electron main process.
// Spawned by Claude Code via `ELECTRON_RUN_AS_NODE=1 <electron-binary> <this>`.

const http = require('http')
const readline = require('readline')

const PORT = process.env.HARNESS_PORT
const TOKEN = process.env.HARNESS_TOKEN
const TERMINAL_ID = process.env.HARNESS_TERMINAL_ID || ''

if (!PORT || !TOKEN) {
  process.stderr.write('harness-mcp: HARNESS_PORT and HARNESS_TOKEN required\n')
  process.exit(1)
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function logErr(...args) {
  process.stderr.write('[harness-mcp] ' + args.join(' ') + '\n')
}

function callControl(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(PORT),
        path,
        method,
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let chunks = ''
        res.on('data', (c) => (chunks += c))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(chunks ? JSON.parse(chunks) : {})
            } catch (e) {
              reject(new Error('bad json from harness: ' + chunks))
            }
          } else {
            reject(new Error('harness HTTP ' + res.statusCode + ': ' + chunks))
          }
        })
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const TOOLS = [
  {
    name: 'create_worktree',
    description:
      'Create a new git worktree in a Harness-managed repo. Harness will open a new Claude chat tab inside the new worktree automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        branchName: {
          type: 'string',
          description: 'Name of the new branch to create for the worktree.'
        },
        repoRoot: {
          type: 'string',
          description:
            'Absolute path to the repo root. Optional when only one repo is open in Harness.'
        },
        baseBranch: {
          type: 'string',
          description:
            "Branch to fork the new worktree from. Defaults to the repo's configured base."
        },
        initialPrompt: {
          type: 'string',
          description:
            'A prompt to automatically send to the Claude chat tab when it opens in the new worktree.'
        }
      },
      required: ['branchName']
    }
  },
  {
    name: 'list_worktrees',
    description: 'List git worktrees currently managed by Harness.',
    inputSchema: {
      type: 'object',
      properties: {
        repoRoot: {
          type: 'string',
          description: 'Optional repo root to filter by.'
        }
      }
    }
  },
  {
    name: 'list_repos',
    description: 'List the repo roots currently open in Harness.',
    inputSchema: { type: 'object', properties: {} }
  }
]

async function handleToolCall(name, args) {
  if (name === 'create_worktree') {
    if (!args || !args.branchName) throw new Error('branchName is required')
    const r = await callControl('POST', '/worktrees', {
      terminalId: TERMINAL_ID,
      repoRoot: args.repoRoot,
      branchName: args.branchName,
      baseBranch: args.baseBranch,
      initialPrompt: args.initialPrompt
    })
    return (
      'Created worktree ' +
      r.path +
      ' on branch ' +
      r.branch +
      '. Harness will open a new Claude chat tab in it.'
    )
  }
  if (name === 'list_worktrees') {
    const q =
      args && args.repoRoot ? '?repoRoot=' + encodeURIComponent(args.repoRoot) : ''
    const r = await callControl('GET', '/worktrees' + q)
    return JSON.stringify(r, null, 2)
  }
  if (name === 'list_repos') {
    const r = await callControl('GET', '/repos')
    return JSON.stringify(r, null, 2)
  }
  throw new Error('unknown tool: ' + name)
}

async function handle(msg) {
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'harness-control', version: '1.0.0' }
        }
      }
    }
    if (method === 'notifications/initialized' || method === 'initialized') {
      return null
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    }
    if (method === 'tools/call') {
      const text = await handleToolCall(
        params && params.name,
        (params && params.arguments) || {}
      )
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }] }
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found: ' + method }
    }
  } catch (err) {
    const message = (err && err.message) || String(err)
    logErr('error', method, message)
    if (method === 'tools/call') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: message }],
          isError: true
        }
      }
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message }
    }
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const response = await handle(msg)
  if (response) send(response)
})
rl.on('close', () => process.exit(0))
