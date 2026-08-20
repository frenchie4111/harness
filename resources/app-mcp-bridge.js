#!/usr/bin/env node
// Ness app MCP bridge — the app-scoped sibling of mcp-bridge.js.
//
// Same shape (stdio MCP server forwarding to the local control HTTP
// server), different vocabulary: every tool here acts on Ness itself
// rather than on one worktree. Spawned only for the global chat
// session, which has no worktree to be scoped to.
//
// Writes are not gated here. The calling session runs with
// --permission-prompt-tool, so every one of these calls surfaces an
// approval card in the global chat window before it reaches us.

const http = require('http')
const readline = require('readline')
const fs = require('fs')

const LOG_PATH = process.env.HARNESS_APP_BRIDGE_LOG || '/tmp/harness-app-bridge.log'

try {
  const st = fs.statSync(LOG_PATH)
  if (st.size > 10 * 1024 * 1024) fs.truncateSync(LOG_PATH, 0)
} catch { /* ignore */ }

function logErr(...args) {
  const line = '[ness-app-mcp] ' + args.join(' ') + '\n'
  try { process.stderr.write(line) } catch { /* ignore */ }
  try { fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + line) } catch { /* ignore */ }
}

function logFatal(kind, err) {
  try {
    fs.appendFileSync(
      LOG_PATH,
      new Date().toISOString() + ' [ness-app-mcp] ' + kind + ' ' + ((err && err.stack) || String(err)) + '\n'
    )
  } catch { /* ignore */ }
}

logErr(
  'started pid=' + process.pid +
  ' sessionId=' + (process.env.HARNESS_SESSION_ID || '') +
  ' port=' + (process.env.HARNESS_PORT || '') +
  ' nodeVersion=' + process.version
)
process.on('exit', (code) => logErr('exit code=' + code))
process.on('uncaughtException', (err) => { logFatal('uncaught', err); process.exit(1) })
process.on('unhandledRejection', (err) => { logFatal('unhandledRejection', err) })

const PORT = process.env.HARNESS_PORT
const TOKEN = process.env.HARNESS_TOKEN
const SESSION_ID = process.env.HARNESS_SESSION_ID || ''

if (!PORT || !TOKEN) {
  logErr('HARNESS_PORT and HARNESS_TOKEN required — exiting')
  process.exit(1)
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
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
          'X-Harness-Terminal-Id': SESSION_ID,
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
            } catch {
              reject(new Error('bad json from Ness: ' + chunks))
            }
          } else {
            let message = 'Ness HTTP ' + res.statusCode + ': ' + chunks
            try {
              const parsed = JSON.parse(chunks)
              if (parsed && parsed.error) message = parsed.error
            } catch { /* keep the raw body */ }
            reject(new Error(message))
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
    name: 'get_app_info',
    description:
      "Orientation for the Ness app itself: version, platform, where config and logs live, how many repos and worktrees are open, and whether a GitHub token is configured. Cheap — call it first when the user asks a 'why is my Ness doing X' question.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_settings',
    description:
      "List every Ness setting you can read or change, with its current value, type, allowed values (for enums), and a one-line description of what it does. Call this before set_setting — it is the authoritative list of keys, and the descriptions tell you which setting actually matches what the user asked for. Some entries are read-only (writable: false).\n\nThis is a curated subset of Ness's settings, not all of them. If the user asks for something that isn't here, say so plainly rather than guessing at a key — a few settings are held back on purpose (the agent system prompts, and the web-transport listener). Settings of type `env` report their variable NAMES with a `<set>` placeholder instead of values, because they hold API keys.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_setting',
    description:
      "Change one Ness setting. The change is applied through the same code path as the Settings panel, so it persists and every open window updates immediately — no restart. Pass the key exactly as list_settings reports it. The user sees an approval card before this runs, so say what you're changing and why first.\n\nOBJECT-VALUED SETTINGS REPLACE, THEY DON'T MERGE. For `hotkeys`, `sidebarDetails`, `worktreeScripts`, `hiddenBottomIcons` and `bottomIconOrder`, the value you send becomes the whole value — read the current one with list_settings and send back the merged object, or you'll silently drop the parts you left out. (`hotkeys` also accepts null to reset every binding to its default.)\n\nENV-VAR SETTINGS ARE THE EXCEPTION: `claudeEnvVars`, `codexEnvVars` and `cursorEnvVars` PATCH. Send only the names you want to change; set a name to null to remove it; names you omit are preserved. This is deliberate — list_settings reports which names are set but never their values, since they routinely hold API keys, so you have no way to read-modify-write them and must not try.",
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Setting key, exactly as returned by list_settings.'
        },
        value: {
          description:
            'New value. Type must match the setting: boolean, number, string, one of the enum values, or a JSON object for `hotkeys`.'
        }
      },
      required: ['key', 'value']
    }
  },
  {
    name: 'list_ness_repos',
    description:
      'List the repositories currently open in Ness, each with its absolute root, display name, and how many worktrees it has.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'add_ness_repo',
    description:
      "Add a local git repository to Ness's sidebar. Takes an absolute path to a repo root (or any directory inside one — Ness resolves upward to the root). Fails if the path isn't a git repo.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the repository (or a directory inside it).'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'list_all_worktrees',
    description:
      "List every worktree Ness manages, across all open repos, with the same status grouping the sidebar uses ('merged', 'needs-attention', 'active', 'reviewing', 'no-pr', 'snoozed'). Read `statusLabel`, not the key — 'active' means \"has an open PR\" while the group labelled Active is 'no-pr'. This is PR/review state, not agent liveness.",
    inputSchema: {
      type: 'object',
      properties: {
        repoRoot: {
          type: 'string',
          description: 'Optional absolute repo root to filter by.'
        }
      }
    }
  },
  {
    name: 'reload_custom_themes',
    description:
      "Rescan the user's themes directory and return every custom theme that loaded. Call this after writing a theme file; Ness only scans at boot and when the user clicks Reload in Settings, so a theme you just wrote is invisible until you do. The returned list is what actually parsed — if your theme isn't in it, the file was rejected and you should say so rather than trying to select it.\n\nTO AUTHOR A THEME: write the JSON yourself with the Write tool (the user reviews the whole file in the approval card), then call this, then set `themeLight` or `themeDark` via set_setting. Get the directory from get_app_info's `themesDir`.\n\nFILE FORMAT — one .json file per theme:\n{\n  \"name\": \"Display Name\",        // REQUIRED, non-empty. Shown in the picker.\n  \"mode\": \"dark\",                // REQUIRED, \"light\" or \"dark\". Decides which\n                                 //   picker it appears in, and therefore whether\n                                 //   themeLight or themeDark can select it.\n  \"colors\": {                    // Optional. Any key you omit inherits from the\n                                 //   built-in default for the same mode, so a\n                                 //   partial theme is valid and often enough.\n    \"app\": \"#0a0a0a\"\n  }\n}\n\nThe theme's id comes from the FILENAME, not from a field: lowercased, every run of non-[a-z0-9-] replaced with a dash, dashes collapsed and trimmed. So `My Cool Theme.json` becomes id `my-cool-theme`. That id is what set_setting takes. It must not collide with a built-in theme id, or the file is skipped.\n\nRecognised `colors` keys (anything else is ignored). Values are any CSS colour string:\n  surfaces      app, panel, panel-raised, surface, surface-hover\n  lines         border, border-strong\n  text          fg, fg-bright, muted, dim, faint\n  semantic      success, warning, danger, info, accent\n  brand ramp    brand, brand-mid, brand-deep\nSyntax highlighting and the gradient brand surfaces are derived from these, so you don't set them separately. A theme that sets `brand` should usually set `brand-mid` and `brand-deep` too, or the ramp will look flat.\n\nA malformed file is skipped and logged rather than throwing — read_ness_log with match 'themes' tells you why.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_hooks_status',
    description:
      "Report whether the user has consented to Ness installing Claude Code hooks, and which worktrees currently have them. Hooks are how Ness knows a terminal agent's real status (processing / waiting / needs-approval) — without them the sidebar dots are guesses.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_hooks_consent',
    description:
      "Record the user's decision about installing Claude Code hooks into their worktrees' .claude/settings.local.json. Only call this when the user has explicitly said yes or no — it writes to files they own.",
    inputSchema: {
      type: 'object',
      properties: {
        consent: {
          type: 'string',
          enum: ['accepted', 'declined'],
          description: "'accepted' installs hooks into managed worktrees; 'declined' leaves them alone."
        }
      },
      required: ['consent']
    }
  },
  {
    name: 'read_ness_log',
    description:
      "Return the tail of Ness's own debug log. Use it to diagnose app-level problems the user reports (a worktree that won't create, PR status that won't refresh, a chat tab that died). Lines are categorical: `[category] message`. Prefer a small `lines` value and grep the result yourself rather than pulling thousands of lines.",
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'number',
          description: 'Number of trailing lines to return. Default 200, max 2000.'
        }
      }
    }
  }
]

async function handleToolCall(name, args) {
  if (name === 'get_app_info') {
    const r = await callControl('GET', '/app/info')
    return JSON.stringify(r, null, 2)
  }
  if (name === 'list_settings') {
    const r = await callControl('GET', '/app/settings')
    return JSON.stringify(r.settings || [], null, 2)
  }
  if (name === 'set_setting') {
    if (!args || typeof args.key !== 'string' || !args.key.trim()) {
      throw new Error('key is required')
    }
    if (!('value' in args)) throw new Error('value is required')
    const r = await callControl('POST', '/app/settings', {
      key: args.key.trim(),
      value: args.value
    })
    return 'Set ' + r.key + ' = ' + JSON.stringify(r.value)
  }
  if (name === 'list_ness_repos') {
    const r = await callControl('GET', '/app/repos')
    return JSON.stringify(r.repos || [], null, 2)
  }
  if (name === 'add_ness_repo') {
    if (!args || typeof args.path !== 'string' || !args.path.trim()) {
      throw new Error('path is required')
    }
    const r = await callControl('POST', '/app/repos', { path: args.path.trim() })
    return 'Added repo ' + r.repoRoot
  }
  if (name === 'list_all_worktrees') {
    const q = args && args.repoRoot ? '?repoRoot=' + encodeURIComponent(args.repoRoot) : ''
    const r = await callControl('GET', '/worktrees' + q)
    return JSON.stringify(r, null, 2)
  }
  if (name === 'reload_custom_themes') {
    const r = await callControl('POST', '/app/themes/reload', {})
    const themes = (r && r.themes) || []
    return themes.length === 0
      ? 'No custom themes loaded. If you just wrote one, the file was rejected — check read_ness_log for a "themes" line explaining why.'
      : JSON.stringify(themes, null, 2)
  }
  if (name === 'get_hooks_status') {
    const r = await callControl('GET', '/app/hooks')
    return JSON.stringify(r, null, 2)
  }
  if (name === 'set_hooks_consent') {
    const consent = args && args.consent === 'declined' ? 'declined' : 'accepted'
    const r = await callControl('POST', '/app/hooks', { consent })
    return 'Hooks consent is now ' + r.consent
  }
  if (name === 'read_ness_log') {
    const lines = args && typeof args.lines === 'number' ? args.lines : 200
    const r = await callControl('GET', '/app/log?lines=' + encodeURIComponent(String(lines)))
    return r.log || '(log is empty)'
  }
  throw new Error('unknown tool: ' + name)
}

async function handle(msg) {
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      logErr('initialize received')
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ness-app', version: '1.0.0' }
        }
      }
    }
    if (method === 'notifications/initialized' || method === 'initialized') {
      return null
    }
    if (method === 'tools/list') {
      logErr('tools/list received')
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
    }
    if (method === 'tools/call') {
      logErr('tools/call received name=' + (params && params.name))
      const result = await handleToolCall(
        params && params.name,
        (params && params.arguments) || {}
      )
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(result) }] }
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
        result: { content: [{ type: 'text', text: message }], isError: true }
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32603, message } }
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
