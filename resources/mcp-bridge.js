#!/usr/bin/env node
// Harness MCP bridge — minimal MCP stdio server that forwards tool calls
// to the Harness control HTTP server running inside the Electron main process.
// Spawned by Claude Code via `ELECTRON_RUN_AS_NODE=1 <electron-binary> <this>`.

const http = require('http')
const readline = require('readline')

const PORT = process.env.HARNESS_PORT
const TOKEN = process.env.HARNESS_TOKEN
const TERMINAL_ID = process.env.HARNESS_TERMINAL_ID || ''

// Scope set at spawn by src/main/mcp-config.ts. The server re-resolves
// scope from TERMINAL_ID on every call (authoritative), so these are a
// best-effort hint used to customize the advertised tool list/descriptions
// for feature-worktree callers. Can go stale if the session teleports.
const SCOPE = {
  worktreeId: process.env.HARNESS_WORKTREE_ID || '',
  repoRoot: process.env.HARNESS_REPO_ROOT || '',
  isMain: process.env.HARNESS_IS_MAIN === '1'
}

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
          'X-Harness-Terminal-Id': TERMINAL_ID,
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
      "Create a new git worktree in a Harness-managed repo. Harness will open a new Claude chat tab inside the new worktree automatically. Defaults to the caller's current repo when repoRoot is omitted.",
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
            "Absolute path to the repo root. Optional — defaults to the caller's current repo."
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
  },
  {
    name: 'list_browser_tabs',
    description:
      'List the browser tabs currently open in the SAME worktree as the calling agent. Returns [{id, url, title}]. Use the returned ids with screenshot_tab, get_tab_dom, get_tab_url, and get_tab_console_logs.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_browser_tab',
    description:
      "Open a new browser tab in this worktree. Returns the new tab's id. Optionally navigates to a URL; otherwise opens at about:blank. Prefer this over telling the user to click the Browser button.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            "Optional URL to load. Accepts a bare host (e.g. 'github.com') — https:// is prepended if no scheme is present."
        }
      }
    }
  },
  {
    name: 'screenshot_tab',
    description:
      "Take a PNG screenshot of a browser tab in this worktree. Returns base64-encoded PNG bytes. The tab id comes from list_browser_tabs.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'get_tab_dom',
    description:
      "Return the serialized outer HTML of the tab's document. Useful for inspecting rendered DOM that an HTTP fetch wouldn't see.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'get_tab_url',
    description: 'Return the current URL of the tab (may differ from the last-navigated URL if the page redirected).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'get_tab_console_logs',
    description:
      "Return the most recent (up to ~200) console messages captured from the tab since it was opened. Entries are {ts, level, message}.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'navigate_tab',
    description:
      "Navigate a browser tab in this worktree to a URL. Accepts a bare host (e.g. 'github.com') — https:// is prepended automatically if no scheme is present.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        url: { type: 'string', description: 'URL to load.' }
      },
      required: ['tab_id', 'url']
    }
  },
  {
    name: 'back_tab',
    description: 'Navigate the tab one step backward in its history (no-op if no back entry).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'forward_tab',
    description: 'Navigate the tab one step forward in its history (no-op if no forward entry).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'reload_tab',
    description: 'Reload the current page in the tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'list_shells',
    description:
      "List shell tabs in the caller's worktree. Each entry includes id, label, command (if started with one), cwd, and alive (whether its PTY is still running). Use the returned id with read_shell_output/kill_shell. Prefer reading an existing shell over spawning a new one when you just want to inspect recent output.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_shell',
    description:
      "Spawn a new shell tab in this worktree. If `command` is set, runs it via `zsh -ilc <command>`; otherwise opens an interactive login shell. Returns the new shell's id — keep it so you can read_shell_output / kill_shell later. Use this instead of telling the user to run `npm run dev` by hand.",
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Shell command to run (e.g. "npm run dev"). Leave empty to open an interactive shell.'
        },
        cwd: {
          type: 'string',
          description:
            'Directory to spawn in. Relative paths resolve against the worktree root; absolute paths are used as-is. Defaults to the worktree root.'
        },
        label: {
          type: 'string',
          description:
            'Optional short label shown on the tab. Defaults to a truncated form of the command.'
        }
      }
    }
  },
  {
    name: 'read_shell_output',
    description:
      "Return the most recent output from a shell tab in this worktree (cleaned of ANSI escape codes). Works whether the shell is still running or has already exited — handy for reading the final error after a failed build. Default lines=200; cap is 5000.",
    inputSchema: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Shell id from list_shells or create_shell.' },
        lines: {
          type: 'number',
          description: 'Number of trailing lines to return. Default 200, max 5000.'
        }
      },
      required: ['shell_id']
    }
  },
  {
    name: 'kill_shell',
    description:
      "Terminate the process running in a shell tab in this worktree. The tab stays open so you (and the user) can still read the final output via read_shell_output.",
    inputSchema: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Shell id from list_shells.' }
      },
      required: ['shell_id']
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
  if (name === 'list_browser_tabs') {
    const r = await callControl('GET', '/browser/tabs')
    return JSON.stringify(r.tabs || [], null, 2)
  }
  if (name === 'create_browser_tab') {
    const r = await callControl('POST', '/browser/tabs', {
      url: (args && args.url) || ''
    })
    return 'Created browser tab ' + r.id + ' → ' + r.url
  }
  if (name === 'screenshot_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const r = await callControl(
      'GET',
      '/browser/screenshot?tabId=' + encodeURIComponent(args.tab_id)
    )
    if (!r || !r.pngBase64) throw new Error(r && r.error ? r.error : 'screenshot failed')
    return {
      content: [{ type: 'image', data: r.pngBase64, mimeType: 'image/png' }]
    }
  }
  if (name === 'get_tab_dom') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const r = await callControl(
      'GET',
      '/browser/dom?tabId=' + encodeURIComponent(args.tab_id)
    )
    if (r == null || r.html == null) throw new Error(r && r.error ? r.error : 'dom read failed')
    return r.html
  }
  if (name === 'get_tab_url') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const r = await callControl(
      'GET',
      '/browser/url?tabId=' + encodeURIComponent(args.tab_id)
    )
    return r && r.url ? r.url : ''
  }
  if (name === 'get_tab_console_logs') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const r = await callControl(
      'GET',
      '/browser/console?tabId=' + encodeURIComponent(args.tab_id)
    )
    return JSON.stringify((r && r.logs) || [], null, 2)
  }
  if (name === 'navigate_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    if (!args.url) throw new Error('url is required')
    await callControl('POST', '/browser/navigate', {
      tabId: args.tab_id,
      url: args.url
    })
    return 'navigated ' + args.tab_id + ' → ' + args.url
  }
  if (name === 'back_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    await callControl('POST', '/browser/back', { tabId: args.tab_id })
    return 'back ' + args.tab_id
  }
  if (name === 'forward_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    await callControl('POST', '/browser/forward', { tabId: args.tab_id })
    return 'forward ' + args.tab_id
  }
  if (name === 'reload_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    await callControl('POST', '/browser/reload', { tabId: args.tab_id })
    return 'reloaded ' + args.tab_id
  }
  if (name === 'list_shells') {
    const r = await callControl('GET', '/shells')
    return JSON.stringify((r && r.shells) || [], null, 2)
  }
  if (name === 'create_shell') {
    const r = await callControl('POST', '/shells', {
      command: (args && args.command) || '',
      cwd: (args && args.cwd) || '',
      label: (args && args.label) || ''
    })
    const commandPart = args && args.command ? ' (' + args.command + ')' : ''
    return 'Created shell ' + r.id + ' "' + r.label + '"' + commandPart
  }
  if (name === 'read_shell_output') {
    if (!args || !args.shell_id) throw new Error('shell_id is required')
    const q = new URLSearchParams({ shellId: args.shell_id })
    if (args.lines != null) q.set('lines', String(args.lines))
    const r = await callControl('GET', '/shells/output?' + q.toString())
    return r && r.output ? r.output : ''
  }
  if (name === 'kill_shell') {
    if (!args || !args.shell_id) throw new Error('shell_id is required')
    await callControl('POST', '/shells/kill', { shellId: args.shell_id })
    return 'killed ' + args.shell_id
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
      const result = await handleToolCall(
        params && params.name,
        (params && params.arguments) || {}
      )
      const content =
        result && typeof result === 'object' && Array.isArray(result.content)
          ? result.content
          : [{ type: 'text', text: String(result) }]
      return {
        jsonrpc: '2.0',
        id,
        result: { content }
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
