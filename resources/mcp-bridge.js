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
        }
      },
      required: ['branchName']
    }
  },
  {
    name: 'remove_worktree',
    description:
      'Remove a git worktree that Harness is currently tracking. Fails if the worktree has uncommitted changes unless force is true.',
    inputSchema: {
      type: 'object',
      properties: {
        repoRoot: {
          type: 'string',
          description: 'Absolute path to the repo root the worktree belongs to.'
        },
        path: {
          type: 'string',
          description: 'Absolute path to the worktree to remove.'
        },
        force: {
          type: 'boolean',
          description: 'Force removal even if there are uncommitted changes.'
        }
      },
      required: ['repoRoot', 'path']
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
  },
  {
    name: 'add_repo',
    description:
      'Register an existing git repository on disk as a Harness-managed repo root. Set init=true to `git init` a new repo at the given path if it does not exist yet — useful for spinning up brand new projects from the management workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the repository (or desired new project directory).'
        },
        init: {
          type: 'boolean',
          description:
            'When true, create the directory and run `git init` if no git repo exists at that path.'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'remove_repo',
    description:
      'Unregister a repo root from Harness. The directory on disk is left untouched; only the Harness sidebar entry and its persisted workspace state are cleared.',
    inputSchema: {
      type: 'object',
      properties: {
        repoRoot: {
          type: 'string',
          description: 'Absolute path to the repo root to unregister.'
        }
      },
      required: ['repoRoot']
    }
  }
]

async function handleToolCall(name, args) {
  if (name === 'create_worktree') {
    if (!args || !args.branchName) throw new Error('branchName is required')
    const r = await callControl('POST', '/worktrees', {
      terminalId: TERMINAL_ID,
      repoRoot: args.repoRoot,
      branchName: args.branchName,
      baseBranch: args.baseBranch
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
  if (name === 'add_repo') {
    if (!args || !args.path) throw new Error('path is required')
    const r = await callControl('POST', '/repos', { path: args.path, init: args.init === true })
    if (r.added) {
      return 'Added repo root ' + r.repoRoot + ' to Harness.'
    }
    return 'Repo root ' + r.repoRoot + ' is already tracked by Harness.'
  }
  if (name === 'remove_repo') {
    if (!args || !args.repoRoot) throw new Error('repoRoot is required')
    const r = await callControl(
      'DELETE',
      '/repos?repoRoot=' + encodeURIComponent(args.repoRoot)
    )
    if (r.removed) return 'Removed repo root ' + args.repoRoot + ' from Harness.'
    return 'Repo root ' + args.repoRoot + ' was not tracked by Harness.'
  }
  if (name === 'remove_worktree') {
    if (!args || !args.repoRoot || !args.path) {
      throw new Error('repoRoot and path are required')
    }
    const force = args.force === true ? '&force=1' : ''
    const r = await callControl(
      'DELETE',
      '/worktrees?repoRoot=' +
        encodeURIComponent(args.repoRoot) +
        '&path=' +
        encodeURIComponent(args.path) +
        force
    )
    return 'Removed worktree ' + (r.path || args.path) + '.'
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
