import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

import { listDir, isGitRepo, resolveHome } from './fs-listing'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'harness-fs-test-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('listDir', () => {
  it('returns dirs first, then files, alphabetically', async () => {
    mkdirSync(join(tmp, 'banana'))
    mkdirSync(join(tmp, 'apple'))
    writeFileSync(join(tmp, 'zebra.txt'), 'z')
    writeFileSync(join(tmp, 'mango.txt'), 'm')

    const entries = await listDir(tmp)
    expect(entries.map((e) => e.name)).toEqual([
      'apple',
      'banana',
      'mango.txt',
      'zebra.txt'
    ])
    expect(entries[0].isDir).toBe(true)
    expect(entries[1].isDir).toBe(true)
    expect(entries[2].isDir).toBe(false)
  })

  it('filters dotfiles by default and includes them when showHidden is true', async () => {
    mkdirSync(join(tmp, 'visible'))
    mkdirSync(join(tmp, '.hidden-dir'))
    writeFileSync(join(tmp, '.hidden-file'), 'x')
    writeFileSync(join(tmp, 'shown.txt'), 'x')

    const visible = await listDir(tmp)
    expect(visible.map((e) => e.name).sort()).toEqual(['shown.txt', 'visible'])

    const all = await listDir(tmp, { showHidden: true })
    expect(all.map((e) => e.name).sort()).toEqual([
      '.hidden-dir',
      '.hidden-file',
      'shown.txt',
      'visible'
    ])
  })

  it('marks .git-containing dirs with isGitRepo: true', async () => {
    mkdirSync(join(tmp, 'plain-dir'))
    mkdirSync(join(tmp, 'repo'))
    mkdirSync(join(tmp, 'repo', '.git'))
    mkdirSync(join(tmp, 'worktree'))
    writeFileSync(join(tmp, 'worktree', '.git'), 'gitdir: /elsewhere')

    const entries = await listDir(tmp)
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(byName['repo'].isGitRepo).toBe(true)
    expect(byName['worktree'].isGitRepo).toBe(true)
    expect(byName['plain-dir'].isGitRepo).toBe(false)
  })

  it('throws on a nonexistent path', async () => {
    await expect(listDir(join(tmp, 'does-not-exist'))).rejects.toThrow(/No such directory/)
  })

  it('throws when the path is a regular file (ENOTDIR)', async () => {
    const filePath = join(tmp, 'file.txt')
    writeFileSync(filePath, 'x')
    await expect(listDir(filePath)).rejects.toThrow(/Not a directory/)
  })

  it('truncates at 500 entries with a sentinel row', async () => {
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(tmp, `file-${String(i).padStart(4, '0')}.txt`), '')
    }
    const entries = await listDir(tmp)
    expect(entries).toHaveLength(501)
    expect(entries[500].truncated).toBe(true)
    expect(entries[500].isDir).toBe(false)
  })

  it('falls back to the home directory when given an empty path', async () => {
    const entries = await listDir('')
    // Just sanity-check that the call returned without throwing — content
    // depends on the user's actual home directory.
    expect(Array.isArray(entries)).toBe(true)
  })
})

describe('isGitRepo', () => {
  it('returns true for a directory containing a .git subdirectory', async () => {
    mkdirSync(join(tmp, 'repo'))
    mkdirSync(join(tmp, 'repo', '.git'))
    expect(await isGitRepo(join(tmp, 'repo'))).toBe(true)
  })

  it('returns true for a directory containing a .git file (linked worktree)', async () => {
    mkdirSync(join(tmp, 'wt'))
    writeFileSync(join(tmp, 'wt', '.git'), 'gitdir: /elsewhere')
    expect(await isGitRepo(join(tmp, 'wt'))).toBe(true)
  })

  it('returns false for a plain directory', async () => {
    mkdirSync(join(tmp, 'plain'))
    expect(await isGitRepo(join(tmp, 'plain'))).toBe(false)
  })

  it('returns false for a nonexistent directory', async () => {
    expect(await isGitRepo(join(tmp, 'missing'))).toBe(false)
  })
})

describe('resolveHome', () => {
  it('returns os.homedir()', async () => {
    expect(await resolveHome()).toBe(homedir())
  })
})
