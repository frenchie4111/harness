import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BRIDGE = join(__dirname, 'mcp-bridge.js')

function startStub(handler) {
  return new Promise((resolve) => {
    const captured = []
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}
        captured.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          terminalId: req.headers['x-harness-terminal-id'],
          body
        })
        try {
          handler(req, body, res, captured)
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(e) }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ port, captured, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

function spawnBridge(port, token) {
  const proc = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      HARNESS_PORT: String(port),
      HARNESS_TOKEN: token,
      HARNESS_TERMINAL_ID: 'test-terminal'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdoutBuf = ''
  const responses = []
  const pending = []
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString()
    let idx
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx)
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (pending.length) {
          pending.shift()(msg)
        } else {
          responses.push(msg)
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  })
  proc.stderr.on('data', () => {
    /* swallow */
  })
  function send(msg) {
    proc.stdin.write(JSON.stringify(msg) + '\n')
  }
  function next() {
    return new Promise((resolve) => {
      if (responses.length) resolve(responses.shift())
      else pending.push(resolve)
    })
  }
  function kill() {
    proc.kill()
    return new Promise((resolve) => proc.once('exit', () => resolve()))
  }
  return { send, next, kill, proc }
}

describe('mcp-bridge create_worktree', () => {
  let stub
  let bridge

  afterEach(async () => {
    if (bridge) await bridge.kill()
    if (stub) await stub.close()
  })

  it('forwards prNumber to POST /worktrees and reports PR # in result text', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt', branch: 'feature/pr-head' }))
    })
    bridge = spawnBridge(stub.port, 'secret-token')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { prNumber: 47, initialPrompt: 'review please' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    expect(response.result.content[0].text).toContain('PR #47')
    expect(response.result.content[0].text).toContain('/tmp/wt')
    expect(response.result.content[0].text).toContain('feature/pr-head')

    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeDefined()
    expect(postCall.auth).toBe('Bearer secret-token')
    expect(postCall.terminalId).toBe('test-terminal')
    expect(postCall.body.prNumber).toBe(47)
    expect(postCall.body.initialPrompt).toBe('review please')
  })

  it('still supports the new-branch flow when prNumber is absent', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt-new', branch: 'mybranch' }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'mybranch' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    const text = response.result.content[0].text
    expect(text).toContain('/tmp/wt-new')
    expect(text).toContain('mybranch')
    expect(text).not.toContain('PR #')

    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall.body.branchName).toBe('mybranch')
    expect(postCall.body.prNumber).toBeUndefined()
  })

  it('returns an error when neither branchName nor prNumber is provided', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_worktree', arguments: {} }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/branchName or prNumber/)
  })

  it('rejects non-integer prNumber locally without hitting the server', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_worktree', arguments: { prNumber: -3 } }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/positive integer/)
    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeUndefined()
  })

  it('surfaces server-side PR failures back to the caller', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(422, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: "Couldn't fetch PR #99999 from GitHub" }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { prNumber: 99999 }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/HTTP 422/)
    expect(response.result.content[0].text).toMatch(/99999/)
  })
})
