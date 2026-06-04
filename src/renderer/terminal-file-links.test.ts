import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseFilePaths,
  toWorktreeRelative,
  loadWorktreeFiles,
  getCachedWorktreeFiles,
  __resetWorktreeFileCache
} from './terminal-file-links'

describe('parseFilePaths', () => {
  it('matches a bare relative path', () => {
    const [m] = parseFilePaths('see src/main/index.ts for details')
    expect(m.path).toBe('src/main/index.ts')
    expect(m.line).toBeUndefined()
    expect('see '.length).toBe(m.start)
  })

  it('captures :line:col suffix (tsc/eslint/grep style)', () => {
    const [m] = parseFilePaths('ERROR src/foo.ts:42:7 - bad')
    expect(m.path).toBe('src/foo.ts')
    expect(m.line).toBe(42)
    expect(m.column).toBe(7)
    // the whole match includes the :42:7 suffix
    expect(m.length).toBe('src/foo.ts:42:7'.length)
  })

  it('captures (line,col) parenthetical (tsc) suffix', () => {
    const [m] = parseFilePaths('src/foo.ts(12,3): error TS1005')
    expect(m.path).toBe('src/foo.ts')
    expect(m.line).toBe(12)
    expect(m.column).toBe(3)
  })

  it('matches ./ and ../ prefixes and absolute paths', () => {
    expect(parseFilePaths('./a/b.ts')[0].path).toBe('./a/b.ts')
    expect(parseFilePaths('../sib/c.js')[0].path).toBe('../sib/c.js')
    expect(parseFilePaths('at /Users/x/proj/d.tsx:9')[0].path).toBe('/Users/x/proj/d.tsx')
  })

  it('finds multiple paths on one line', () => {
    const matches = parseFilePaths('a/b.ts and c/d.js')
    expect(matches.map((m) => m.path)).toEqual(['a/b.ts', 'c/d.js'])
  })

  it('does not match extensionless words or bare flags', () => {
    expect(parseFilePaths('just some prose here')).toHaveLength(0)
    expect(parseFilePaths('run with --verbose mode')).toHaveLength(0)
  })

  it('does not treat a URL host/path as a separate file match for the scheme', () => {
    // The domain has no extension+path that looks like a file in the project;
    // worktree validation is the real guard, but the parser also shouldn't
    // match the "https" scheme token itself.
    const matches = parseFilePaths('open https://example.com/page')
    expect(matches.every((m) => !m.path.startsWith('https'))).toBe(true)
  })
})

describe('toWorktreeRelative', () => {
  const cwd = '/home/u/repo'

  it('passes through a clean relative path', () => {
    expect(toWorktreeRelative('src/a.ts', cwd)).toBe('src/a.ts')
  })

  it('strips a leading ./', () => {
    expect(toWorktreeRelative('./src/a.ts', cwd)).toBe('src/a.ts')
  })

  it('relativizes an absolute path inside the worktree', () => {
    expect(toWorktreeRelative('/home/u/repo/src/a.ts', cwd)).toBe('src/a.ts')
  })

  it('rejects an absolute path outside the worktree', () => {
    expect(toWorktreeRelative('/usr/lib/node_modules/x.js', cwd)).toBeNull()
    // a sibling dir that shares a prefix but isn't under cwd
    expect(toWorktreeRelative('/home/u/repo-other/a.ts', cwd)).toBeNull()
  })

  it('rejects ../-climbing paths (can only resolve against the worktree root)', () => {
    expect(toWorktreeRelative('../other/a.ts', cwd)).toBeNull()
  })
})

describe('worktree file cache', () => {
  beforeEach(() => __resetWorktreeFileCache())

  it('loads and caches the file set, then serves it synchronously', async () => {
    const cwd = '/repo'
    expect(getCachedWorktreeFiles(cwd)).toBeNull()
    await loadWorktreeFiles(cwd, async () => ['src/a.ts', 'README.md'], { now: 1000 })
    const set = getCachedWorktreeFiles(cwd)
    expect(set?.has('src/a.ts')).toBe(true)
    expect(set?.has('README.md')).toBe(true)
  })

  it('skips a reload within the refresh window but reloads when forced', async () => {
    const cwd = '/repo'
    let calls = 0
    const list = async (): Promise<string[]> => {
      calls++
      return ['a.ts']
    }
    await loadWorktreeFiles(cwd, list, { now: 1000 })
    await loadWorktreeFiles(cwd, list, { now: 1500 }) // within 5s window → skipped
    expect(calls).toBe(1)
    await loadWorktreeFiles(cwd, list, { now: 1500, force: true })
    expect(calls).toBe(2)
    await loadWorktreeFiles(cwd, list, { now: 99999 }) // window elapsed → reload
    expect(calls).toBe(3)
  })
})
