import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  startControlServer,
  getControlServerInfo,
  type ControlServerDeps,
  type CallerScope
} from './control-server'

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

const CALLER_TERMINAL = 'terminal-abc'
const CALLER_WORKTREE = '/repo/wt/callers-tree'
const EXPLICIT_WORKTREE = '/repo/wt/other'
/** Scoped to a worktree like a chat tab, but with no transcript on disk —
 * how a plain terminal tab looks to the fork path. */
const NO_TRANSCRIPT_TERMINAL = 'terminal-no-transcript'

const scope: CallerScope = {
  terminalId: CALLER_TERMINAL,
  worktreePath: CALLER_WORKTREE,
  repoRoot: '/repo',
  isMain: false
}

/** Mutable so a test can flip the setting off without restarting the server —
 * mirrors how the real dep re-reads config per request. */
let conversationForkEnabled = true

const deps: ControlServerDeps = {
  getRepoRoots: () => ['/repo'],
  getWorktreeBase: () => 'remote',
  getPrReviewPrompt: () => '',
  broadcast: () => {},
  runWorktreeSetup: async () => {},
  runPendingPRWorktree: async () => ({ ok: false, error: 'not used in these tests' }),
  resolveCallerScope: (terminalId) =>
    terminalId === CALLER_TERMINAL || terminalId === NO_TRANSCRIPT_TERMINAL ? scope : null,
  hasForkableTranscript: (sessionId) => sessionId === CALLER_TERMINAL,
  getConversationForkEnabled: () => conversationForkEnabled,
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
  clearAlias: (path) => clearAlias(path)
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

beforeAll(async () => {
  await startControlServer(deps)
  const info = getControlServerInfo()
  if (!info) throw new Error('control server failed to start')
  baseUrl = `http://127.0.0.1:${info.port}`
  token = info.token
})

describe('control-server /aliases endpoint', () => {
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

// These all reject before addWorktree runs, so no git work happens. The
// accept path isn't covered here — it would create a real worktree.
describe('control-server POST /worktrees forkConversation', () => {
  it('rejects a caller whose terminal has no forkable transcript', async () => {
    const r = await call(
      'POST',
      '/worktrees',
      { branchName: 'spinoff', forkConversation: true },
      { terminalId: NO_TRANSCRIPT_TERMINAL }
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/only available from a Harness Chat tab/)
  })

  it('rejects a caller with no resolvable scope', async () => {
    const r = await call(
      'POST',
      '/worktrees',
      { branchName: 'spinoff', forkConversation: true },
      { terminalId: 'unknown-terminal' }
    )
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/only available from a Harness Chat tab/)
  })

  it('rejects forkConversation combined with prNumber', async () => {
    const r = await call('POST', '/worktrees', { prNumber: 7, forkConversation: true })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/cannot be combined with prNumber/)
  })

  it('rejects forkConversation into an agent that cannot resume a transcript', async () => {
    for (const agentKind of ['codex', 'cursor']) {
      const r = await call('POST', '/worktrees', {
        branchName: 'spinoff',
        agentKind,
        forkConversation: true
      })
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(/only Claude Code can resume a forked transcript/)
    }
  })

  it('rejects forkConversation when the setting is disabled', async () => {
    conversationForkEnabled = false
    try {
      const r = await call('POST', '/worktrees', { branchName: 'spinoff', forkConversation: true })
      expect(r.status).toBe(400)
      expect(r.json.error).toMatch(/disabled in Harness settings/)
    } finally {
      conversationForkEnabled = true
    }
  })
})
