import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'

import { WorktreeWatcher } from './worktree-watcher'

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

function activeWatchers(path: string): FakeWatcher[] {
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

describe('WorktreeWatcher — changed-files subscriptions', () => {
  it('notifies a single subscriber after debounce window elapses', () => {
    const watcher = new WorktreeWatcher()
    const listener = vi.fn()
    watcher.subscribe('/wt/a', listener)

    fireFsEvent(join('/wt/a', '.git'), 'index')
    expect(listener).not.toHaveBeenCalled()

    vi.advanceTimersByTime(199)
    expect(listener).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('coalesces multiple events within the debounce window into one notification', () => {
    const watcher = new WorktreeWatcher()
    const listener = vi.fn()
    watcher.subscribe('/wt/a', listener)

    const gitDir = join('/wt/a', '.git')
    fireFsEvent(gitDir, 'index')
    fireFsEvent(gitDir, 'HEAD')
    fireFsEvent(gitDir, 'index')
    fireFsEvent(gitDir, 'MERGE_HEAD')
    fireFsEvent(gitDir, 'HEAD')

    vi.advanceTimersByTime(200)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores fs events for unrelated filenames', () => {
    const watcher = new WorktreeWatcher()
    const listener = vi.fn()
    watcher.subscribe('/wt/a', listener)

    const gitDir = join('/wt/a', '.git')
    fireFsEvent(gitDir, 'objects')
    fireFsEvent(gitDir, 'config')
    fireFsEvent(gitDir, 'logs')

    vi.advanceTimersByTime(500)
    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies every subscriber on the same path', () => {
    const watcher = new WorktreeWatcher()
    const a = vi.fn()
    const b = vi.fn()
    watcher.subscribe('/wt/a', a)
    watcher.subscribe('/wt/a', b)

    fireFsEvent(join('/wt/a', '.git'), 'index')
    vi.advanceTimersByTime(200)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('reuses the underlying fs.watch handle across subscribers', () => {
    const watcher = new WorktreeWatcher()
    watcher.subscribe('/wt/a', vi.fn())
    watcher.subscribe('/wt/a', vi.fn())

    expect(activeWatchers(join('/wt/a', '.git'))).toHaveLength(1)
  })

  it('reference-counts: unsubscribing one keeps the watcher alive for the rest', () => {
    const watcher = new WorktreeWatcher()
    const a = vi.fn()
    const b = vi.fn()
    const offA = watcher.subscribe('/wt/a', a)
    watcher.subscribe('/wt/a', b)

    offA()

    fireFsEvent(join('/wt/a', '.git'), 'index')
    vi.advanceTimersByTime(200)

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    expect(activeWatchers(join('/wt/a', '.git'))).toHaveLength(1)
  })

  it('closes the underlying fs.watch handle when the last subscriber leaves', () => {
    const watcher = new WorktreeWatcher()
    const offA = watcher.subscribe('/wt/a', vi.fn())
    const offB = watcher.subscribe('/wt/a', vi.fn())

    const created = fakeWatchers.filter((w) => w.path === join('/wt/a', '.git'))
    expect(created).toHaveLength(1)
    expect(created[0].close).not.toHaveBeenCalled()

    offA()
    expect(created[0].close).not.toHaveBeenCalled()

    offB()
    expect(created[0].close).toHaveBeenCalledTimes(1)
  })

  it('keeps subscriptions on different paths independent', () => {
    const watcher = new WorktreeWatcher()
    const a = vi.fn()
    const b = vi.fn()
    watcher.subscribe('/wt/a', a)
    watcher.subscribe('/wt/b', b)

    fireFsEvent(join('/wt/a', '.git'), 'index')
    vi.advanceTimersByTime(200)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('survives fs.watch throwing (e.g. .git/ missing) and produces no notifications', () => {
    ;(fs.watch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })

    const watcher = new WorktreeWatcher()
    const listener = vi.fn()
    expect(() => watcher.subscribe('/wt/missing', listener)).not.toThrow()

    vi.advanceTimersByTime(500)
    expect(listener).not.toHaveBeenCalled()
  })

  it('retries fs.watch on a subsequent subscribe after the first attempt failed', () => {
    ;(fs.watch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })

    const watcher = new WorktreeWatcher()
    const first = vi.fn()
    watcher.subscribe('/wt/racy', first)
    expect(activeWatchers(join('/wt/racy', '.git'))).toHaveLength(0)

    // Second subscribe should retry the open — the gitdir race lost on the
    // first attempt is a real production case (worktree just created).
    const second = vi.fn()
    watcher.subscribe('/wt/racy', second)
    expect(activeWatchers(join('/wt/racy', '.git'))).toHaveLength(1)

    fireFsEvent(join('/wt/racy', '.git'), 'index')
    vi.advanceTimersByTime(200)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('WorktreeWatcher — branch-label sync', () => {
  it('calls onBranchChange after the debounce window on a HEAD event', () => {
    const onChange = vi.fn()
    const watcher = new WorktreeWatcher(onChange)
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
    const watcher = new WorktreeWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }])

    fireFsEvent(join('/wt/a', '.git'), 'rebase-merge')
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('ignores a plain commit (touches index, not HEAD)', () => {
    const onChange = vi.fn()
    const watcher = new WorktreeWatcher(onChange)
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
    const watcher = new WorktreeWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }])

    fireFsEvent(join('/wt/a', '.git'), null)
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of events into one onBranchChange', () => {
    const onChange = vi.fn()
    const watcher = new WorktreeWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }])

    const gitdir = join('/wt/a', '.git')
    fireFsEvent(gitdir, 'HEAD')
    fireFsEvent(gitdir, 'HEAD')
    fireFsEvent(gitdir, 'rebase-merge')
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('sync opens a watcher per new worktree and closes ones that went away', () => {
    const watcher = new WorktreeWatcher(vi.fn())
    watcher.sync([{ path: '/wt/a' }, { path: '/wt/b' }])
    expect(activeWatchers(join('/wt/a', '.git'))).toHaveLength(1)
    expect(activeWatchers(join('/wt/b', '.git'))).toHaveLength(1)

    const bWatcher = fakeWatchers.find((w) => w.path === join('/wt/b', '.git'))!
    // /wt/b removed, /wt/c added.
    watcher.sync([{ path: '/wt/a' }, { path: '/wt/c' }])
    expect(bWatcher.close).toHaveBeenCalledTimes(1)
    expect(activeWatchers(join('/wt/c', '.git'))).toHaveLength(1)
  })

  it('sync is idempotent — re-syncing the same set reuses watchers', () => {
    const watcher = new WorktreeWatcher(vi.fn())
    watcher.sync([{ path: '/wt/a' }])
    watcher.sync([{ path: '/wt/a' }])
    expect(fakeWatchers.filter((w) => w.path === join('/wt/a', '.git'))).toHaveLength(1)
  })

  it('does not fire for a path dropped from the sync set', () => {
    const onChange = vi.fn()
    const watcher = new WorktreeWatcher(onChange)
    watcher.sync([{ path: '/wt/a' }, { path: '/wt/b' }])

    fireFsEvent(join('/wt/a', '.git'), 'HEAD')
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)

    watcher.sync([{ path: '/wt/a' }])
    fireFsEvent(join('/wt/b', '.git'), 'HEAD')
    vi.advanceTimersByTime(250)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('survives fs.watch throwing (gitdir missing) without firing', () => {
    ;(fs.watch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })
    const onChange = vi.fn()
    const watcher = new WorktreeWatcher(onChange)
    expect(() => watcher.sync([{ path: '/wt/missing' }])).not.toThrow()
    vi.advanceTimersByTime(500)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('WorktreeWatcher — shared handle across both consumers', () => {
  it('subscribe + sync on the same path share one fs.watch handle', () => {
    const watcher = new WorktreeWatcher(vi.fn())
    watcher.subscribe('/wt/a', vi.fn())
    watcher.sync([{ path: '/wt/a' }])

    expect(activeWatchers(join('/wt/a', '.git'))).toHaveLength(1)
  })

  it('a single HEAD event drives both a changed-files listener and the branch callback', () => {
    const onChange = vi.fn()
    const fileListener = vi.fn()
    const watcher = new WorktreeWatcher(onChange)
    watcher.subscribe('/wt/a', fileListener)
    watcher.sync([{ path: '/wt/a' }])

    fireFsEvent(join('/wt/a', '.git'), 'HEAD')
    vi.advanceTimersByTime(250)

    expect(fileListener).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('dropping from sync keeps the handle open while a changed-files subscriber remains', () => {
    const watcher = new WorktreeWatcher(vi.fn())
    const off = watcher.subscribe('/wt/a', vi.fn())
    watcher.sync([{ path: '/wt/a' }])

    // Branch sync no longer wants it, but the subscriber still does.
    watcher.sync([])
    expect(activeWatchers(join('/wt/a', '.git'))).toHaveLength(1)

    // Last subscriber leaves → handle closes.
    off()
    expect(activeWatchers(join('/wt/a', '.git'))).toHaveLength(0)
  })

  it('shutdown closes every open watcher and clears entries', () => {
    const watcher = new WorktreeWatcher(vi.fn())
    watcher.subscribe('/wt/a', vi.fn())
    watcher.sync([{ path: '/wt/b' }])

    const aWatcher = fakeWatchers.find((w) => w.path === join('/wt/a', '.git'))!
    const bWatcher = fakeWatchers.find((w) => w.path === join('/wt/b', '.git'))!

    watcher.shutdown()

    expect(aWatcher.close).toHaveBeenCalledTimes(1)
    expect(bWatcher.close).toHaveBeenCalledTimes(1)
  })
})

describe('WorktreeWatcher.resolveGitdir', () => {
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
    expect(WorktreeWatcher.resolveGitdir('/repo')).toBe(join('/repo', '.git'))
  })

  it('returns null when .git is absent', () => {
    vi.spyOn(fs, 'statSync').mockImplementation((() => {
      throw new Error('ENOENT')
    }) as unknown as typeof fs.statSync)

    expect(WorktreeWatcher.resolveGitdir('/nope')).toBeNull()
  })

  it('follows a linked-worktree gitlink file to the real gitdir', () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'wtw-'))
    const wt = join(tmp, 'wt')
    const realGitdir = join(tmp, 'main', '.git', 'worktrees', 'wt')
    fs.mkdirSync(wt, { recursive: true })
    fs.mkdirSync(realGitdir, { recursive: true })
    fs.writeFileSync(join(wt, '.git'), `gitdir: ${realGitdir}\n`)

    expect(WorktreeWatcher.resolveGitdir(wt)).toBe(realGitdir)

    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('resolves a relative gitlink against the worktree path', () => {
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'wtw-'))
    const wt = join(tmp, 'wt')
    fs.mkdirSync(join(wt, '.real-gitdir'), { recursive: true })
    fs.writeFileSync(join(wt, '.git'), 'gitdir: .real-gitdir\n')

    expect(WorktreeWatcher.resolveGitdir(wt)).toBe(join(wt, '.real-gitdir'))

    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
