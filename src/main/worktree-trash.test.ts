import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fsp, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('./debug', () => ({ log: () => {} }))

vi.mock('./paths', () => ({
  userDataDir: () => tmpUserData
}))

// Populated in beforeEach so each test gets a fresh dir.
let tmpUserData = ''

import {
  isSameVolume,
  sweepWorktreeTrashOnBoot,
  worktreeTrashDir,
  resetTrashDirCacheForTests
} from './worktree-trash'

describe('worktree-trash boot sweep', () => {
  beforeEach(() => {
    tmpUserData = join(tmpdir(), `harness-trash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpUserData, { recursive: true })
    resetTrashDirCacheForTests()
  })

  afterEach(() => {
    try {
      rmSync(tmpUserData, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('is a no-op when the trash dir does not exist', async () => {
    await expect(sweepWorktreeTrashOnBoot()).resolves.toBeUndefined()
  })

  it('detects the destination volume before the trash directory exists', () => {
    const worktree = join(tmpUserData, 'worktree')
    mkdirSync(worktree)

    expect(isSameVolume(worktree, join(tmpUserData, 'missing', 'trash'))).toBe(true)
  })

  it('queues every entry in the trash dir for removal', async () => {
    const trash = worktreeTrashDir()
    mkdirSync(trash, { recursive: true })
    for (const name of ['a', 'b', 'c']) {
      const child = join(trash, name)
      mkdirSync(child)
      writeFileSync(join(child, 'file.txt'), 'x')
    }

    await sweepWorktreeTrashOnBoot()

    // scheduleTrashUnlink is fire-and-forget — poll until entries are
    // gone (or until a short timeout so a stuck test still fails loud).
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const remaining = await fsp.readdir(trash).catch(() => [] as string[])
      if (remaining.length === 0) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(existsSync(join(trash, 'a'))).toBe(false)
    expect(existsSync(join(trash, 'b'))).toBe(false)
    expect(existsSync(join(trash, 'c'))).toBe(false)
  })
})
