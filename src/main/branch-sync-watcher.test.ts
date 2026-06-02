import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'

import { BranchSyncWatcher } from './branch-sync-watcher'

type FsCallback = (eventType: string, filename: string | null) => void

interface FakeWatcher {
  path: string
  listener: FsCallback
  close: ReturnType<typeof vi.fn>
}

let fakeWatchers: FakeWatcher[] = []

function fireFsEvent(path: string, filename: string | null): void {
  for (const w of fakeWatchers) {
    if (w.path === path) w.listener('change', filename)
  }
}

function openWatchers(path: string): FakeWatcher[] {
  return fakeWatchers.filter((w) => !w.close.mock.calls.length && w.path === path)
}

beforeEach(() => {
  fakeWatchers = []
  vi.useFakeTimers()
  // resolveGitdir stats <path>/.git; pretend it's always a real directory so
  // the watcher attaches to <path>/.git without touching disk.
  vi.spyOn(fs, 'statSync').mockImplementation(((() => ({
    isDirectory: () => true
  })) as unknown) as typeof fs.statSync)
  vi.spyOn(fs, 'watch').mockImplementation(((
    path: fs.PathLike,
    optionsOrListener?: unknown,
    maybeListener?: unknown
  ) => {
    const listener = (typeof optionsOrListener === 'function'
      ? optionsOrListener
      : maybeListener) as FsCallback
    const w: FakeWatcher = { path: String(path), listener, close: vi.fn() }
    fakeWatchers.push(w)
    return { close: w.close } as unknown as fs.FSWatcher
  }) as unknown as typeof fs.watch)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('BranchSyncWatcher', () => {
  it('calls onChange after the debounce window on a HEAD event', () => {
    const onChange = vi.fn()
    const watcher = new BranchSyncWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }])

    fireFsEvent(join('/wt/a', '.git'), 'HEAD')
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(249)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('fires on rebase markers so the label clears when a rebase ends', () => {
    const onChange = vi.fn()
    const watcher = new BranchSyncWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }])

    fireFsEvent(join('/wt/a', '.git'), 'rebase-merge')
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated gitdir files (a commit on a branch touches index, not HEAD)', () => {
    const onChange = vi.fn()
    const watcher = new BranchSyncWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }])

    const gitdir = join('/wt/a', '.git')
    fireFsEvent(gitdir, 'index')
    fireFsEvent(gitdir, 'config')
    fireFsEvent(gitdir, 'ORIG_HEAD')
    fireFsEvent(gitdir, 'logs')
    vi.advanceTimersByTime(500)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('still refreshes when the platform omits the filename', () => {
    const onChange = vi.fn()
    const watcher = new BranchSyncWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }])

    fireFsEvent(join('/wt/a', '.git'), null)
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of events into one onChange', () => {
    const onChange = vi.fn()
    const watcher = new BranchSyncWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }])

    const gitdir = join('/wt/a', '.git')
    fireFsEvent(gitdir, 'HEAD')
    fireFsEvent(gitdir, 'HEAD')
    fireFsEvent(gitdir, 'rebase-merge')
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('sync opens a watcher per new worktree and closes ones that went away', () => {
    const watcher = new BranchSyncWatcher(vi.fn())
    watcher.sync([{ path: '/wt/a' }, { path: '/wt/b' }])
    expect(openWatchers(join('/wt/a', '.git'))).toHaveLength(1)
    expect(openWatchers(join('/wt/b', '.git'))).toHaveLength(1)

    const bWatcher = fakeWatchers.find((w) => w.path === join('/wt/b', '.git'))!
    // /wt/b removed, /wt/c added.
    watcher.sync([{ path: '/wt/a' }, { path: '/wt/c' }])
    expect(bWatcher.close).toHaveBeenCalledTimes(1)
    expect(openWatchers(join('/wt/c', '.git'))).toHaveLength(1)
  })

  it('sync is idempotent — re-syncing the same set reuses watchers', () => {
    const watcher = new BranchSyncWatcher(vi.fn())
    watcher.sync([{ path: '/wt/a' }])
    watcher.sync([{ path: '/wt/a' }])
    expect(fakeWatchers.filter((w) => w.path === join('/wt/a', '.git'))).toHaveLength(1)
  })

  it('keeps worktrees independent', () => {
    const onChange = vi.fn()
    const watcher = new BranchSyncWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }, { path: '/wt/b' }])

    fireFsEvent(join('/wt/a', '.git'), 'HEAD')
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)

    // After /wt/b is removed, its events no longer fire.
    watcher.sync([{ path: '/wt/a' }])
    fireFsEvent(join('/wt/b', '.git'), 'HEAD')
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('shutdown closes every open watcher', () => {
    const watcher = new BranchSyncWatcher(vi.fn())
    watcher.sync([{ path: '/wt/a' }, { path: '/wt/b' }])
    const all = fakeWatchers.slice()
    watcher.shutdown()
    for (const w of all) expect(w.close).toHaveBeenCalledTimes(1)
  })

  it('survives fs.watch throwing (gitdir missing) without firing', () => {
    ;(fs.watch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })
    const onChange = vi.fn()
    const watcher = new BranchSyncWatcher(onChange)
    expect(() => watcher.sync([{ path: '/wt/missing' }])).not.toThrow()
    vi.advanceTimersByTime(500)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('BranchSyncWatcher.resolveGitdir', () => {
  // Drop the file-level fs spies so these exercise real fs (the gitlink-follow
  // cases need a real stat/read); individual tests re-spy where needed.
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns <path>/.git when it is a real directory (main worktree)', () => {
    vi.spyOn(fs, 'statSync').mockImplementation(((() => ({
      isDirectory: () => true
    })) as unknown) as typeof fs.statSync)
    expect(BranchSyncWatcher.resolveGitdir('/repo')).toBe(join('/repo', '.git'))
  })

  it('returns null when .git is absent', () => {
    vi.spyOn(fs, 'statSync').mockImplementation((() => {
      throw new Error('ENOENT')
    }) as unknown as typeof fs.statSync)

    expect(BranchSyncWatcher.resolveGitdir('/nope')).toBeNull()
  })

  it('follows a linked-worktree gitlink file to the real gitdir', () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'bsw-'))
    const wt = join(tmp, 'wt')
    const realGitdir = join(tmp, 'main', '.git', 'worktrees', 'wt')
    fs.mkdirSync(wt, { recursive: true })
    fs.mkdirSync(realGitdir, { recursive: true })
    fs.writeFileSync(join(wt, '.git'), `gitdir: ${realGitdir}\n`)

    expect(BranchSyncWatcher.resolveGitdir(wt)).toBe(realGitdir)

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('resolves a relative gitlink against the worktree path', () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'bsw-'))
    const wt = join(tmp, 'wt')
    fs.mkdirSync(join(wt, '.real-gitdir'), { recursive: true })
    fs.writeFileSync(join(wt, '.git'), 'gitdir: .real-gitdir\n')

    expect(BranchSyncWatcher.resolveGitdir(wt)).toBe(join(wt, '.real-gitdir'))

    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
