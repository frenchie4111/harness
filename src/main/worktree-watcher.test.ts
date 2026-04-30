import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { join } from 'path'

import { WorktreeWatcher } from './worktree-watcher'

type FsCallback = (eventType: string, filename: string | null) => void

interface FakeWatcher {
  path: string
  listener: FsCallback
  close: ReturnType<typeof vi.fn>
}

let fakeWatchers: FakeWatcher[] = []

function fireFsEvent(path: string, filename: string): void {
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
  vi.spyOn(fs, 'watch').mockImplementation(((
    path: fs.PathLike,
    optionsOrListener?: unknown,
    maybeListener?: unknown
  ) => {
    const listener = (typeof optionsOrListener === 'function'
      ? optionsOrListener
      : maybeListener) as FsCallback
    const w: FakeWatcher = {
      path: String(path),
      listener,
      close: vi.fn()
    }
    fakeWatchers.push(w)
    return {
      close: w.close,
      // The full FSWatcher interface has a few EventEmitter methods we
      // don't exercise in these tests; cast at the call site.
    } as unknown as fs.FSWatcher
  }) as unknown as typeof fs.watch)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WorktreeWatcher', () => {
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

  it('shutdown closes every open watcher and clears entries', () => {
    const watcher = new WorktreeWatcher()
    watcher.subscribe('/wt/a', vi.fn())
    watcher.subscribe('/wt/b', vi.fn())

    const aWatcher = fakeWatchers.find((w) => w.path === join('/wt/a', '.git'))!
    const bWatcher = fakeWatchers.find((w) => w.path === join('/wt/b', '.git'))!

    watcher.shutdown()

    expect(aWatcher.close).toHaveBeenCalledTimes(1)
    expect(bWatcher.close).toHaveBeenCalledTimes(1)
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
})
