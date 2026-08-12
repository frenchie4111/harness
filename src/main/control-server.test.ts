import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  startControlServer,
  getControlServerInfo,
  type ControlServerDeps,
  type CallerScope
} from './control-server'
import type { ChatDeliveryResult } from './chat-delivery'
import { parseAutomatedMessage } from '../shared/state/json-claude'

// Integration test for the local HTTP control server. Exercises the
// `/aliases` endpoint end-to-end (POST + DELETE, both scoped and
// explicit-path forms). The rest of the endpoints are not covered here
// — this file exists specifically to cover the alias-worktrees MCP
// path, which was called out in code review as untested.
//
// Vitest isolates each file in its own worker, so the one-time server
// startup + the module-level `serverInfo` state don't leak between
// files.

const setAlias = vi.fn<(worktreePath: string, alias: string) => void>()
const clearAlias = vi.fn<(worktreePath: string) => void>()
const sendMessage = vi.fn<(worktreePath: string, message: string) => ChatDeliveryResult>(
  () => ({ ok: true, sessionId: 'tab-1', woke: false })
)

const CALLER_TERMINAL = 'terminal-abc'
const CALLER_WORKTREE = '/repo/wt/callers-tree'
const EXPLICIT_WORKTREE = '/repo/wt/other'

const scope: CallerScope = {
  terminalId: CALLER_TERMINAL,
  worktreePath: CALLER_WORKTREE,
  repoRoot: '/repo',
  isMain: false
}

const deps: ControlServerDeps = {
  getRepoRoots: () => ['/repo'],
  getWorktreeBase: () => 'remote',
  getPrReviewPrompt: () => '',
  broadcast: () => {},
  runWorktreeSetup: async () => {},
  runPendingPRWorktree: async () => ({ ok: false, error: 'not used in these tests' }),
  resolveCallerScope: (terminalId) => (terminalId === CALLER_TERMINAL ? scope : null),
  getBrowserPerms: () => ({ enabled: false, mode: 'full' }),
  browser: {
    listTabsForWorktree: () => [],
    getTabWorktree: () => null,
    getTabUrl: () => null,
    getTabConsoleLogs: () => [],
    screenshotTab: async () => null,
    getTabDom: async () => null,
    getTabClickables: async () => null,
    navigateTab: () => {},
    backTab: () => {},
    forwardTab: () => {},
    reloadTab: () => {},
    createTab: () => ({ id: 't', url: 'about:blank' }),
    clickTab: () => {},
    typeTab: () => {},
    scrollTab: async () => {},
    showCursor: async () => {}
  },
  shell: {
    listShellsForWorktree: () => [],
    getShellWorktree: () => null,
    readShellOutput: () => ({ output: '' }),
    createShell: () => ({ id: 's', label: 'shell' }),
    killShell: () => {}
  },
  setAlias: (path, alias) => setAlias(path, alias),
  clearAlias: (path) => clearAlias(path),
  messaging: {
    resolveTarget: (query) => {
      if (query === EXPLICIT_WORKTREE || query === 'Other Tree') {
        return { path: EXPLICIT_WORKTREE }
      }
      if (query === CALLER_WORKTREE || query === 'Callers Tree') {
        return { path: CALLER_WORKTREE }
      }
      return { error: `no worktree matching "${query}"` }
    },
    describe: (path) => (path === CALLER_WORKTREE ? 'Callers Tree' : 'Other Tree'),
    send: (path, message) => sendMessage(path, message)
  }
}

let baseUrl: string
let token: string

async function call(
  method: 'POST' | 'DELETE',
  path: string,
  body: unknown,
  opts: { terminalId?: string | null } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
  if (opts.terminalId !== null) {
    headers['X-Harness-Terminal-Id'] = opts.terminalId ?? CALLER_TERMINAL
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: JSON.stringify(body)
  })
  const text = await res.text()
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  return { status: res.status, json }
}

describe('control-server /aliases endpoint', () => {
  beforeAll(async () => {
    await startControlServer(deps)
    const info = getControlServerInfo()
    if (!info) throw new Error('control server failed to start')
    baseUrl = `http://127.0.0.1:${info.port}`
    token = info.token
  })

  it('POST /aliases with explicit worktreePath dispatches setAlias', async () => {
    setAlias.mockClear()
    const r = await call('POST', '/aliases', {
      worktreePath: EXPLICIT_WORKTREE,
      alias: 'my-label'
    })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({
      worktreePath: EXPLICIT_WORKTREE,
      alias: 'my-label',
      cleared: false,
      clamped: false
    })
    expect(setAlias).toHaveBeenCalledWith(EXPLICIT_WORKTREE, 'my-label')
  })

  it('POST /aliases without worktreePath defaults to the caller scope', async () => {
    setAlias.mockClear()
    const r = await call('POST', '/aliases', { alias: 'self' })
    expect(r.status).toBe(200)
    expect(r.json.worktreePath).toBe(CALLER_WORKTREE)
    expect(setAlias).toHaveBeenCalledWith(CALLER_WORKTREE, 'self')
  })

  it('POST /aliases with untrimmed input reports clamped: true', async () => {
    setAlias.mockClear()
    const r = await call('POST', '/aliases', {
      worktreePath: EXPLICIT_WORKTREE,
      alias: '   spacious   '
    })
    expect(r.json.alias).toBe('spacious')
    expect(r.json.clamped).toBe(true)
  })

  it('POST /aliases with >80-char input clamps and reports clamped: true', async () => {
    setAlias.mockClear()
    const long = 'a'.repeat(120)
    const r = await call('POST', '/aliases', {
      worktreePath: EXPLICIT_WORKTREE,
      alias: long
    })
    expect((r.json.alias as string).length).toBe(80)
    expect(r.json.clamped).toBe(true)
  })

  it('POST /aliases with empty-after-trim reports cleared: true', async () => {
    const r = await call('POST', '/aliases', {
      worktreePath: EXPLICIT_WORKTREE,
      alias: '   '
    })
    expect(r.json.cleared).toBe(true)
    expect(r.json.alias).toBe('')
  })

  it('POST /aliases without worktreePath and without caller scope returns 400', async () => {
    const r = await call(
      'POST',
      '/aliases',
      { alias: 'x' },
      { terminalId: 'unknown-terminal' }
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/worktreePath required/)
  })

  it('DELETE /aliases with explicit worktreePath dispatches clearAlias', async () => {
    clearAlias.mockClear()
    const r = await call('DELETE', '/aliases', { worktreePath: EXPLICIT_WORKTREE })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ worktreePath: EXPLICIT_WORKTREE, cleared: true })
    expect(clearAlias).toHaveBeenCalledWith(EXPLICIT_WORKTREE)
  })

  it('DELETE /aliases without worktreePath defaults to the caller scope', async () => {
    clearAlias.mockClear()
    const r = await call('DELETE', '/aliases', {})
    expect(r.status).toBe(200)
    expect(r.json.worktreePath).toBe(CALLER_WORKTREE)
    expect(clearAlias).toHaveBeenCalledWith(CALLER_WORKTREE)
  })
})

describe('control-server /messages endpoint', () => {
  beforeAll(async () => {
    // The server is already listening from the suite above — vitest runs
    // both describes in the same worker, and startControlServer is
    // idempotent from the caller's perspective here.
    const info = getControlServerInfo()
    if (!info) throw new Error('control server failed to start')
    baseUrl = `http://127.0.0.1:${info.port}`
    token = info.token
  })

  it('delivers a wrapped message to the resolved worktree', async () => {
    sendMessage.mockClear()
    const r = await call('POST', '/messages', {
      worktree: 'Other Tree',
      message: 'build is green, you can rebase'
    })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({
      delivered: true,
      worktreePath: EXPLICIT_WORKTREE,
      from: 'Callers Tree',
      woke: false
    })
    const [path, wire] = sendMessage.mock.calls[0]
    expect(path).toBe(EXPLICIT_WORKTREE)
    expect(parseAutomatedMessage(wire)).toEqual({
      source: 'worktree-message',
      body: 'build is green, you can rebase',
      from: 'Callers Tree'
    })
  })

  it('takes the sender from caller scope, not the body', async () => {
    sendMessage.mockClear()
    await call('POST', '/messages', {
      worktree: EXPLICIT_WORKTREE,
      message: 'hi',
      from: 'Some Other Worktree'
    })
    expect(parseAutomatedMessage(sendMessage.mock.calls[0][1])?.from).toBe('Callers Tree')
  })

  it('reports woke: true when delivery had to wake a slept tab', async () => {
    sendMessage.mockReturnValueOnce({ ok: true, sessionId: 'tab-2', woke: true })
    const r = await call('POST', '/messages', {
      worktree: EXPLICIT_WORKTREE,
      message: 'hi'
    })
    expect(r.json.woke).toBe(true)
  })

  it('rejects an unknown worktree', async () => {
    const r = await call('POST', '/messages', { worktree: 'nope', message: 'hi' })
    expect(r.status).toBe(404)
    expect(r.json.error).toMatch(/no worktree matching/)
  })

  it('rejects sending to your own worktree', async () => {
    sendMessage.mockClear()
    const r = await call('POST', '/messages', {
      worktree: 'Callers Tree',
      message: 'hi'
    })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/your own worktree/)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('requires a non-empty worktree and message', async () => {
    expect((await call('POST', '/messages', { message: 'hi' })).status).toBe(400)
    expect(
      (await call('POST', '/messages', { worktree: EXPLICIT_WORKTREE, message: '  ' }))
        .status
    ).toBe(400)
  })

  it('surfaces an undelivered message rather than silently queueing it', async () => {
    sendMessage.mockReturnValueOnce({ ok: false, reason: 'no-chat-tab' })
    const r = await call('POST', '/messages', {
      worktree: EXPLICIT_WORKTREE,
      message: 'hi'
    })
    expect(r.status).toBe(409)
    expect(r.json.error).toMatch(/no agent chat tab/)
    expect(r.json.error).toMatch(/was not sent/)
  })

  it('rejects a caller with no worktree scope', async () => {
    const r = await call(
      'POST',
      '/messages',
      { worktree: EXPLICIT_WORKTREE, message: 'hi' },
      { terminalId: 'unknown-terminal' }
    )
    expect(r.status).toBe(404)
  })
})
