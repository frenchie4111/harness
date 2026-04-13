import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdirSync, statSync } from 'fs'
import { resolve as resolvePath } from 'path'
import { addWorktree, listWorktrees, removeWorktree, defaultWorktreeDir, WorktreeInfo } from './worktree'
import { log } from './debug'

const execFileAsync = promisify(execFile)

export interface ControlServerDeps {
  getRepoRoots: () => string[]
  getWorktreeBase: () => 'remote' | 'local'
  /** Register an existing directory as a harness repo root. Returns true if it
   *  wasn't already tracked. Throws if the path isn't a git repo. */
  addRepoRoot: (repoRoot: string) => Promise<boolean>
  /** Drop a repo root from harness. Does not touch the directory on disk. */
  removeRepoRoot: (repoRoot: string) => boolean
  broadcast: (channel: string, ...args: unknown[]) => void
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

  if (req.method === 'POST' && path === '/repos') {
    const body = await readJson(req)
    const raw = typeof body.path === 'string' ? body.path : ''
    if (!raw.trim()) return sendJson(res, 400, { error: 'path required' })
    const abs = resolvePath(raw.trim().replace(/^~\//, `${process.env.HOME || ''}/`))
    const initIfMissing = body.init === true
    try {
      if (!existsSync(abs)) {
        if (initIfMissing) {
          mkdirSync(abs, { recursive: true })
        } else {
          return sendJson(res, 400, { error: `path does not exist: ${abs}` })
        }
      }
      if (!statSync(abs).isDirectory()) {
        return sendJson(res, 400, { error: `not a directory: ${abs}` })
      }
      const isRepo = await isGitRepo(abs)
      if (!isRepo) {
        if (initIfMissing) {
          await execFileAsync('git', ['init'], { cwd: abs })
          log('control', `git init ${abs}`)
        } else {
          return sendJson(res, 400, { error: `not a git repository: ${abs} (pass init: true to create one)` })
        }
      }
      const added = await deps.addRepoRoot(abs)
      return sendJson(res, 200, { repoRoot: abs, added })
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (req.method === 'DELETE' && path === '/repos') {
    const repoRoot = url.searchParams.get('repoRoot')
    if (!repoRoot) return sendJson(res, 400, { error: 'repoRoot required' })
    const removed = deps.removeRepoRoot(repoRoot)
    return sendJson(res, 200, { repoRoot, removed })
  }

  if (req.method === 'DELETE' && path === '/worktrees') {
    const repoRoot = url.searchParams.get('repoRoot')
    const worktreePath = url.searchParams.get('path')
    const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true'
    if (!repoRoot || !worktreePath) {
      return sendJson(res, 400, { error: 'repoRoot and path required' })
    }
    try {
      await removeWorktree(repoRoot, worktreePath, force)
      deps.broadcast('worktrees:externalRemove', { repoRoot, path: worktreePath })
      return sendJson(res, 200, { repoRoot, path: worktreePath, removed: true })
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
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
    deps.broadcast('worktrees:externalCreate', { repoRoot, worktree: created })
    return sendJson(res, 200, created)
  }

  res.writeHead(404)
  res.end('not found')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
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
