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
    name: 'get_tab_clickables',
    description:
      "Return a JSON snapshot of in-viewport interactive elements (buttons, links, inputs, [role=button|link|tab|menuitem|checkbox|radio|switch|option|combobox|searchbox|textbox], [tabindex], [contenteditable], [onclick]) — including elements inside open shadow roots. Each item is {role, name, cx, cy, w, h} where cx/cy is the viewport-relative center to pass to click_tab. Use this for click targeting instead of screenshot+vision when the targets are real DOM elements with sensible names. Capped at 500 items; off-viewport elements are excluded — scroll first if needed.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'click_tab',
    description:
      "Synthesize a mouse click at viewport-relative (x, y) coordinates inside a browser tab. Origin is the top-left of the tab's web view. Use a screenshot first to figure out where to click. A visible cursor + click ripple is overlaid on the page so the user can watch the interaction.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        x: { type: 'number', description: 'Viewport x coordinate (CSS pixels).' },
        y: { type: 'number', description: 'Viewport y coordinate (CSS pixels).' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button (default left).'
        },
        click_count: {
          type: 'number',
          description: 'Number of clicks; use 2 for double-click. Default 1, max 3.'
        }
      },
      required: ['tab_id', 'x', 'y']
    }
  },
  {
    name: 'type_tab',
    description:
      "Type text into the focused element of a browser tab. Click the field first with click_tab to focus it. Pass `text` for literal characters (\\n becomes Enter, \\t becomes Tab). Pass `key` to press a single special key (Enter, Tab, Backspace, Delete, Escape, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space). You can pass both — `key` fires first, then `text`.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        text: { type: 'string', description: 'Literal text to insert.' },
        key: {
          type: 'string',
          description:
            "Optional special key to press (e.g. 'Enter', 'Backspace', 'ArrowDown')."
        }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'scroll_tab',
    description:
      "Scroll a browser tab by (delta_x, delta_y) CSS pixels. Positive delta_y scrolls down. Equivalent to window.scrollBy in the page.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        delta_x: { type: 'number', description: 'Horizontal scroll in CSS pixels (default 0).' },
        delta_y: { type: 'number', description: 'Vertical scroll in CSS pixels (default 0).' }
      },
      required: ['tab_id']
    }
  },
  {
    name: 'show_cursor',
    description:
      "Render or move the visible fake cursor overlay at (x, y) inside a browser tab without clicking. Useful for showing the user where you're about to click. click_tab calls this automatically.",
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string', description: 'Browser tab id from list_browser_tabs.' },
        x: { type: 'number', description: 'Viewport x coordinate (CSS pixels).' },
        y: { type: 'number', description: 'Viewport y coordinate (CSS pixels).' }
      },
      required: ['tab_id', 'x', 'y']
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
      "Return the most recent output from a shell tab in this worktree (cleaned of ANSI escape codes). Works whether the shell is still running or has already exited — handy for reading the final error after a failed build. Use `match` + `context` to narrow results and save tokens when looking for errors in a long dev-server log. Returns { output, matchCount? }.",
    inputSchema: {
      type: 'object',
      properties: {
        shell_id: { type: 'string', description: 'Shell id from list_shells or create_shell.' },
        lines: {
          type: 'number',
          description: 'Number of trailing lines to return. Default 200, max 5000. Applied after filtering when `match` is set.'
        },
        match: {
          type: 'string',
          description: "Case-insensitive regex. When set, only lines matching this pattern are returned (e.g. 'error|warn|fail'). Gap separators ('---') indicate skipped ranges."
        },
        context: {
          type: 'number',
          description: 'Lines of context to keep before/after each match. Default 0, max 20. Ignored when `match` is unset.'
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

const VIEW_BROWSER_TOOLS = new Set([
  'list_browser_tabs',
  'create_browser_tab',
  'screenshot_tab',
  'get_tab_dom',
  'get_tab_url',
  'get_tab_console_logs',
  'get_tab_clickables',
  'navigate_tab',
  'back_tab',
  'forward_tab',
  'reload_tab'
])
const FULL_CONTROL_BROWSER_TOOLS = new Set([
  'click_tab',
  'type_tab',
  'scroll_tab',
  'show_cursor'
])

let cachedBrowserPerms = null
async function getBrowserPerms() {
  if (cachedBrowserPerms) return cachedBrowserPerms
  try {
    const r = await callControl('GET', '/scope')
    cachedBrowserPerms = (r && r.browser) || { enabled: true, mode: 'full' }
  } catch {
    cachedBrowserPerms = { enabled: true, mode: 'full' }
  }
  return cachedBrowserPerms
}

function filterToolsByPerms(tools, perms) {
  return tools.filter((t) => {
    const isView = VIEW_BROWSER_TOOLS.has(t.name)
    const isFull = FULL_CONTROL_BROWSER_TOOLS.has(t.name)
    if (!isView && !isFull) return true
    if (!perms.enabled) return false
    if (isFull && perms.mode !== 'full') return false
    return true
  })
}

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
  if (name === 'get_tab_clickables') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const r = await callControl(
      'GET',
      '/browser/clickables?tabId=' + encodeURIComponent(args.tab_id)
    )
    if (!r || r.snapshot == null) throw new Error(r && r.error ? r.error : 'clickables read failed')
    return JSON.stringify(r.snapshot, null, 2)
  }
  if (name === 'click_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    if (typeof args.x !== 'number' || typeof args.y !== 'number') {
      throw new Error('x and y (numbers) are required')
    }
    await callControl('POST', '/browser/click', {
      tabId: args.tab_id,
      x: args.x,
      y: args.y,
      button: args.button,
      clickCount: args.click_count
    })
    return 'clicked ' + args.tab_id + ' at (' + args.x + ', ' + args.y + ')'
  }
  if (name === 'type_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    if (!args.text && !args.key) throw new Error('text or key is required')
    await callControl('POST', '/browser/type', {
      tabId: args.tab_id,
      text: args.text || '',
      key: args.key
    })
    const parts = []
    if (args.key) parts.push('key=' + args.key)
    if (args.text) parts.push(JSON.stringify(args.text))
    return 'typed into ' + args.tab_id + ' ' + parts.join(' + ')
  }
  if (name === 'scroll_tab') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    const dx = typeof args.delta_x === 'number' ? args.delta_x : 0
    const dy = typeof args.delta_y === 'number' ? args.delta_y : 0
    await callControl('POST', '/browser/scroll', {
      tabId: args.tab_id,
      deltaX: dx,
      deltaY: dy
    })
    return 'scrolled ' + args.tab_id + ' by (' + dx + ', ' + dy + ')'
  }
  if (name === 'show_cursor') {
    if (!args || !args.tab_id) throw new Error('tab_id is required')
    if (typeof args.x !== 'number' || typeof args.y !== 'number') {
      throw new Error('x and y (numbers) are required')
    }
    await callControl('POST', '/browser/cursor', {
      tabId: args.tab_id,
      x: args.x,
      y: args.y
    })
    return 'cursor at (' + args.x + ', ' + args.y + ') in ' + args.tab_id
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
    if (args.match) q.set('match', String(args.match))
    if (args.context != null) q.set('context', String(args.context))
    const r = await callControl('GET', '/shells/output?' + q.toString())
    const output = (r && r.output) || ''
    if (r && typeof r.matchCount === 'number') {
      return output
        ? `[${r.matchCount} match${r.matchCount === 1 ? '' : 'es'}]\n${output}`
        : `[${r.matchCount} matches]`
    }
    return output
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
      const perms = await getBrowserPerms()
      return { jsonrpc: '2.0', id, result: { tools: filterToolsByPerms(TOOLS, perms) } }
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
