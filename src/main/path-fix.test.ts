import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./debug', () => ({
  log: () => {}
}))

const tmpRoot = mkdtempSync(join(tmpdir(), 'harness-path-fix-'))

function fakeShell(name: string, body: string): string {
  const path = join(tmpRoot, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('parseProbeOutput', () => {
  it('extracts the value between sentinels', async () => {
    const { parseProbeOutput } = await import('./path-fix')
    const stdout = '__HARNESS_PATH_BEGIN__\n/usr/local/bin:/usr/bin\n__HARNESS_PATH_END__\n'
    expect(parseProbeOutput(stdout)).toBe('/usr/local/bin:/usr/bin')
  })

  it('tolerates rc-file noise before and after the sentinels', async () => {
    const { parseProbeOutput } = await import('./path-fix')
    const stdout =
      'starship init: ok\nnvm: Loading...\n' +
      '__HARNESS_PATH_BEGIN__\n/opt/homebrew/bin:/usr/bin\n__HARNESS_PATH_END__\n' +
      'goodbye\n'
    expect(parseProbeOutput(stdout)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('returns null when sentinels are missing', async () => {
    const { parseProbeOutput } = await import('./path-fix')
    expect(parseProbeOutput('no sentinels here\n')).toBeNull()
    expect(parseProbeOutput('__HARNESS_PATH_BEGIN__\n/x:/y\n')).toBeNull()
    expect(parseProbeOutput('')).toBeNull()
  })
})

describe('mergePaths', () => {
  it('preserves launcher-prepended entries (e.g. node_modules/.bin) at the front', async () => {
    const { mergePaths } = await import('./path-fix')
    const existing = '/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin:/bin'
    const captured = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    expect(mergePaths(existing, captured)).toBe(
      '/repo/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    )
  })

  it('expands a stripped PATH to the captured value', async () => {
    const { mergePaths } = await import('./path-fix')
    const existing = '/usr/bin:/bin:/usr/sbin:/sbin'
    const captured = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    expect(mergePaths(existing, captured)).toBe(captured)
  })

  it('returns existing when captured is a subset of existing', async () => {
    const { mergePaths } = await import('./path-fix')
    const existing = '/foo:/bar:/usr/bin:/bin'
    const captured = '/usr/bin:/bin'
    expect(mergePaths(existing, captured)).toBe('/foo:/bar:/usr/bin:/bin')
  })

  it('is identity when existing equals captured', async () => {
    const { mergePaths } = await import('./path-fix')
    const path = '/opt/homebrew/bin:/usr/bin:/bin'
    expect(mergePaths(path, path)).toBe(path)
  })

  it('dedupes within existing-only entries', async () => {
    const { mergePaths } = await import('./path-fix')
    const existing = '/foo:/bar:/foo:/usr/bin'
    const captured = '/usr/bin:/bin'
    expect(mergePaths(existing, captured)).toBe('/foo:/bar:/usr/bin:/bin')
  })

  it('drops empty entries from both inputs', async () => {
    const { mergePaths } = await import('./path-fix')
    expect(mergePaths(':/foo:', '/usr/bin::/bin')).toBe('/foo:/usr/bin:/bin')
  })

  it('returns captured when existing is empty or undefined', async () => {
    const { mergePaths } = await import('./path-fix')
    expect(mergePaths('', '/usr/bin:/bin')).toBe('/usr/bin:/bin')
    expect(mergePaths(undefined, '/usr/bin:/bin')).toBe('/usr/bin:/bin')
  })
})

describe('capturePath', () => {
  it('returns the inner content from a shell that emits the sentinel format', async () => {
    const { capturePath } = await import('./path-fix')
    const shell = fakeShell(
      'good.sh',
      `printf '__HARNESS_PATH_BEGIN__\\n/fake/path:/usr/bin\\n__HARNESS_PATH_END__\\n'`
    )
    expect(await capturePath(shell, 2000)).toBe('/fake/path:/usr/bin')
  })

  it('returns null when the shell prints output without sentinels', async () => {
    const { capturePath } = await import('./path-fix')
    const shell = fakeShell('nosentinel.sh', `echo "nope"`)
    expect(await capturePath(shell, 2000)).toBeNull()
  })

  it('returns null when the probe times out', async () => {
    const { capturePath } = await import('./path-fix')
    const shell = fakeShell('slow.sh', `sleep 5`)
    const start = Date.now()
    const result = await capturePath(shell, 200)
    const elapsed = Date.now() - start
    expect(result).toBeNull()
    expect(elapsed).toBeLessThan(2000)
  })

  it('returns null when the shell binary does not exist', async () => {
    const { capturePath } = await import('./path-fix')
    expect(await capturePath('/definitely/not/a/real/shell/binary', 2000)).toBeNull()
  })
})

describe('fixPathFromLoginShell smoke', () => {
  let originalPath: string | undefined
  beforeAll(() => {
    originalPath = process.env.PATH
  })
  afterAll(() => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  // Sanity check that capturePath against a real /bin/sh produces a usable
  // PATH string. The behavior of fixPathFromLoginShell itself is gated on
  // process.platform === 'darwin' + Electron runtime, so we exercise the
  // helper instead — same code path, no env stubbing required.
  it.skipIf(process.platform === 'win32')(
    'captures a non-empty PATH from /bin/sh',
    async () => {
      const { capturePath } = await import('./path-fix')
      const captured = await capturePath('/bin/sh', 3000)
      expect(typeof captured === 'string' && captured.length > 0).toBe(true)
    }
  )
})
