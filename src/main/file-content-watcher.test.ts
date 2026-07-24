import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'

import { FileContentWatcher } from './file-content-watcher'

type FsCallback = (eventType: string, filename: string | null) => void

interface FakeWatcher {
  path: string
  listener: FsCallback
  close: ReturnType<typeof vi.fn>
}

let fakeWatchers: FakeWatcher[] = []

function fireFsEvent(path: string, eventType: string): void {
  for (const w of fakeWatchers) {
    if (w.path === path) w.listener(eventType, null)
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
      close: w.close
    } as unknown as fs.FSWatcher
  }) as unknown as typeof fs.watch)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('FileContentWatcher', () => {
  it('notifies a single subscriber after debounce window elapses', () => {
    const watcher = new FileContentWatcher()
    const listener = vi.fn()
    watcher.subscribe('/wt/a/file.txt', listener)

    fireFsEvent('/wt/a/file.txt', 'change')
    expect(listener).not.toHaveBeenCalled()

    vi.advanceTimersByTime(149)
    expect(listener).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('coalesces multiple events within the debounce window into one notification', () => {
    const watcher = new FileContentWatcher()
    const listener = vi.fn()
    watcher.subscribe('/wt/a/file.txt', listener)

    fireFsEvent('/wt/a/file.txt', 'change')
    fireFsEvent('/wt/a/file.txt', 'change')
    fireFsEvent('/wt/a/file.txt', 'change')

    vi.advanceTimersByTime(150)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notifies every subscriber on the same path', () => {
    const watcher = new FileContentWatcher()
    const a = vi.fn()
    const b = vi.fn()
    watcher.subscribe('/wt/a/file.txt', a)
    watcher.subscribe('/wt/a/file.txt', b)

    fireFsEvent('/wt/a/file.txt', 'change')
    vi.advanceTimersByTime(150)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('reuses the underlying fs.watch handle across subscribers', () => {
    const watcher = new FileContentWatcher()
    watcher.subscribe('/wt/a/file.txt', vi.fn())
    watcher.subscribe('/wt/a/file.txt', vi.fn())

    expect(activeWatchers('/wt/a/file.txt')).toHaveLength(1)
  })

  it('reference-counts: unsubscribing one keeps the watcher alive for the rest', () => {
    const watcher = new FileContentWatcher()
    const a = vi.fn()
    const b = vi.fn()
    const offA = watcher.subscribe('/wt/a/file.txt', a)
    watcher.subscribe('/wt/a/file.txt', b)

    offA()

    fireFsEvent('/wt/a/file.txt', 'change')
    vi.advanceTimersByTime(150)

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    expect(activeWatchers('/wt/a/file.txt')).toHaveLength(1)
  })

  it('closes the underlying fs.watch handle when the last subscriber leaves', () => {
    const watcher = new FileContentWatcher()
    const offA = watcher.subscribe('/wt/a/file.txt', vi.fn())
    const offB = watcher.subscribe('/wt/a/file.txt', vi.fn())

    const created = fakeWatchers.filter((w) => w.path === '/wt/a/file.txt')
    expect(created).toHaveLength(1)
    expect(created[0].close).not.toHaveBeenCalled()

    offA()
    expect(created[0].close).not.toHaveBeenCalled()

    offB()
    expect(created[0].close).toHaveBeenCalledTimes(1)
  })

  it('keeps subscriptions on different paths independent', () => {
    const watcher = new FileContentWatcher()
    const a = vi.fn()
    const b = vi.fn()
    watcher.subscribe('/wt/a/file.txt', a)
    watcher.subscribe('/wt/b/file.txt', b)

    fireFsEvent('/wt/a/file.txt', 'change')
    vi.advanceTimersByTime(150)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
  })

  it('shutdown closes every open watcher and clears entries', () => {
    const watcher = new FileContentWatcher()
    watcher.subscribe('/wt/a/file.txt', vi.fn())
    watcher.subscribe('/wt/b/file.txt', vi.fn())

    const aWatcher = fakeWatchers.find((w) => w.path === '/wt/a/file.txt')!
    const bWatcher = fakeWatchers.find((w) => w.path === '/wt/b/file.txt')!

    watcher.shutdown()

    expect(aWatcher.close).toHaveBeenCalledTimes(1)
    expect(bWatcher.close).toHaveBeenCalledTimes(1)
  })

  it('survives fs.watch throwing (e.g. file missing) and produces no notifications', () => {
    ;(fs.watch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })

    const watcher = new FileContentWatcher()
    const listener = vi.fn()
    expect(() => watcher.subscribe('/wt/missing/file.txt', listener)).not.toThrow()

    vi.advanceTimersByTime(500)
    expect(listener).not.toHaveBeenCalled()
  })

  it('re-arms the watcher after a rename event (atomic save)', () => {
    const watcher = new FileContentWatcher()
    const listener = vi.fn()
    watcher.subscribe('/wt/a/file.txt', listener)

    expect(activeWatchers('/wt/a/file.txt')).toHaveLength(1)
    const original = fakeWatchers.find((w) => w.path === '/wt/a/file.txt')!

    // Atomic-save: editor renames-over the inode. fs.watch fires 'rename'.
    fireFsEvent('/wt/a/file.txt', 'rename')

    // Debounced notify fires for the rename event itself.
    vi.advanceTimersByTime(150)
    expect(listener).toHaveBeenCalledTimes(1)

    // After the rearm delay the original watcher is closed and a fresh
    // one is opened against the same path.
    vi.advanceTimersByTime(50)
    expect(original.close).toHaveBeenCalledTimes(1)
    expect(activeWatchers('/wt/a/file.txt')).toHaveLength(1)

    // Subsequent change on the re-armed watcher still notifies.
    fireFsEvent('/wt/a/file.txt', 'change')
    vi.advanceTimersByTime(150)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
