import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const existsSyncMock = vi.fn((_p: string) => true)

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: string) => existsSyncMock(p)
  }
})

describe('resolveUserShell', () => {
  let originalShell: string | undefined

  beforeEach(() => {
    vi.resetModules()
    existsSyncMock.mockReset()
    existsSyncMock.mockReturnValue(true)
    originalShell = process.env.SHELL
  })

  afterEach(() => {
    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell
  })

  it('returns $SHELL when set and the binary exists', async () => {
    process.env.SHELL = '/bin/bash'
    const { resolveUserShell } = await import('./user-shell')
    expect(resolveUserShell()).toBe('/bin/bash')
  })

  it('falls back to the first existing candidate when SHELL is unset', async () => {
    delete process.env.SHELL
    existsSyncMock.mockImplementation((p: string) => p === '/bin/bash')
    const { resolveUserShell } = await import('./user-shell')
    expect(resolveUserShell()).toBe('/bin/bash')
  })

  it('falls through to /bin/sh when no candidate exists', async () => {
    delete process.env.SHELL
    existsSyncMock.mockReturnValue(false)
    const { resolveUserShell } = await import('./user-shell')
    expect(resolveUserShell()).toBe('/bin/sh')
  })

  it('caches the resolved value across calls', async () => {
    process.env.SHELL = '/bin/zsh'
    const { resolveUserShell } = await import('./user-shell')
    const first = resolveUserShell()
    process.env.SHELL = '/bin/bash'
    expect(resolveUserShell()).toBe(first)
  })
})

describe('shell arg helpers', () => {
  it('loginShellCommandArgs returns -ilc <cmd>', async () => {
    const { loginShellCommandArgs } = await import('./user-shell')
    expect(loginShellCommandArgs('echo hi')).toEqual(['-ilc', 'echo hi'])
  })

  it('loginShellArgs returns -il', async () => {
    const { loginShellArgs } = await import('./user-shell')
    expect(loginShellArgs()).toEqual(['-il'])
  })
})
