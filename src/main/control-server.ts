import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { addWorktree, listWorktrees, defaultWorktreeDir, WorktreeInfo } from './worktree'
import { log } from './debug'

export interface BrowserTabSummary {
  id: string
  url: string
  title: string
}

export interface BrowserQueries {
  /** Given the MCP caller's terminal id, find the worktree it lives in. */
  getWorktreeForTerminalId: (terminalId: string) => string | null
  listTabsForWorktree: (worktreePath: string) => BrowserTabSummary[]
  getTabWorktree: (tabId: string) => string | null
  getTabUrl: (tabId: string) => string | null
  getTabConsoleLogs: (
    tabId: string
  ) => Array<{ ts: number; level: string; message: string }>
  screenshotTab: (tabId: string) => Promise<string | null>
  getTabDom: (tabId: string) => Promise<string | null>
}

export interface ControlServerDeps {
  getRepoRoots: () => string[]
  getWorktreeBase: () => 'remote' | 'local'
  broadcast: (channel: string, ...args: unknown[]) => void
  browser: BrowserQueries
}

let serverInfo: { port: number; token: string } | null = null

export function getControlServerInfo(): { port: number; token: string } | null {
  return serverInfo
}

export function startControlServer(deps: ControlServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const token = randomBytes(32).toString('hex')

    const server = createServer((req, res) => {
      handleRequest(req, res, token, deps).catch((err) => {
        log('control', 'handler threw', err instanceof Error ? err.message : String(err))
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        serverInfo = { port: addr.port, token }
        log('control', `listening on 127.0.0.1:${addr.port}`)
        resolve()
      } else {
        reject(new Error('failed to bind control server'))
      }
    })
    server.on('error', (err) => {
      log('control', 'server error', err.message)
    })
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  deps: ControlServerDeps
): Promise<void> {
  const auth = req.headers.authorization
  if (auth !== 'Bearer ' + token) {
    res.writeHead(401)
    res.end('unauthorized')
    return
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname

  if (req.method === 'GET' && path === '/health') {
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'GET' && path === '/repos') {
    return sendJson(res, 200, { repoRoots: deps.getRepoRoots() })
  }

  if (req.method === 'GET' && path === '/worktrees') {
    const repoRoot = url.searchParams.get('repoRoot')
    const roots = repoRoot ? [repoRoot] : deps.getRepoRoots()
    const all: WorktreeInfo[] = []
    for (const r of roots) {
      try {
        all.push(...(await listWorktrees(r)))
      } catch (e) {
        log('control', `list worktrees failed for ${r}`, e instanceof Error ? e.message : e)
      }
    }
    return sendJson(res, 200, all)
  }

  if (req.method === 'POST' && path === '/worktrees') {
    const body = await readJson(req)
    let repoRoot = typeof body.repoRoot === 'string' ? body.repoRoot : undefined
    if (!repoRoot) {
      const roots = deps.getRepoRoots()
      if (roots.length === 1) {
        repoRoot = roots[0]
      } else if (roots.length === 0) {
        return sendJson(res, 400, { error: 'no repos open in Harness' })
      } else {
        return sendJson(res, 400, {
          error: 'repoRoot required when multiple repos are open',
          repoRoots: roots
        })
      }
    }
    const branchName = String(body.branchName || '').trim()
    if (!branchName) {
      return sendJson(res, 400, { error: 'branchName required' })
    }
    const wtDir = defaultWorktreeDir(repoRoot)
    const mode = deps.getWorktreeBase()
    const created = await addWorktree(repoRoot, wtDir, branchName, {
      baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
      fetchRemote: !body.baseBranch && mode === 'remote'
    })
    const initialPrompt = typeof body.initialPrompt === 'string' ? body.initialPrompt : undefined
    deps.broadcast('worktrees:externalCreate', { repoRoot, worktree: created, initialPrompt })
    return sendJson(res, 200, created)
  }

  // Browser MCP endpoints. All calls require an `X-Harness-Terminal-Id` header
  // (set by the bridge from HARNESS_TERMINAL_ID) so we can scope tab access
  // to the worktree that hosts the calling MCP session. Tabs outside that
  // worktree are invisible.
  if (path.startsWith('/browser/')) {
    const callerTerminalId = String(req.headers['x-harness-terminal-id'] || '')
    if (!callerTerminalId) {
      return sendJson(res, 400, { error: 'X-Harness-Terminal-Id header required' })
    }
    const callerWorktree = deps.browser.getWorktreeForTerminalId(callerTerminalId)
    if (!callerWorktree) {
      return sendJson(res, 404, {
        error: 'caller terminal is not associated with a worktree'
      })
    }

    const assertSameWorktree = (tabId: string): string | null => {
      const wt = deps.browser.getTabWorktree(tabId)
      if (!wt) return 'tab not found'
      if (wt !== callerWorktree) return 'tab belongs to a different worktree'
      return null
    }

    if (req.method === 'GET' && path === '/browser/tabs') {
      return sendJson(res, 200, {
        tabs: deps.browser.listTabsForWorktree(callerWorktree)
      })
    }

    const tabId = url.searchParams.get('tabId') || ''
    if (!tabId) {
      return sendJson(res, 400, { error: 'tabId query param required' })
    }
    const bad = assertSameWorktree(tabId)
    if (bad) return sendJson(res, 404, { error: bad })

    if (req.method === 'GET' && path === '/browser/url') {
      return sendJson(res, 200, { url: deps.browser.getTabUrl(tabId) })
    }
    if (req.method === 'GET' && path === '/browser/console') {
      return sendJson(res, 200, { logs: deps.browser.getTabConsoleLogs(tabId) })
    }
    if (req.method === 'GET' && path === '/browser/screenshot') {
      const data = await deps.browser.screenshotTab(tabId)
      return sendJson(res, data ? 200 : 500, {
        pngBase64: data,
        error: data ? undefined : 'capture failed'
      })
    }
    if (req.method === 'GET' && path === '/browser/dom') {
      const dom = await deps.browser.getTabDom(tabId)
      return sendJson(res, dom != null ? 200 : 500, {
        html: dom,
        error: dom != null ? undefined : 'dom read failed'
      })
    }

    res.writeHead(404)
    res.end('browser endpoint not found')
    return
  }

  res.writeHead(404)
  res.end('not found')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}
