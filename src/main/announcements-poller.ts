import { log, formatErr } from './debug'
import type { Store } from './store'
import type { Announcement } from '../shared/state/announcements'

const FEED_URL = 'https://harness.mikelyons.org/announcements.json'
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const MAX_SUMMARY_LEN = 240

interface RawAnnouncement {
  id?: unknown
  title?: unknown
  href?: unknown
  publishedAt?: unknown
  summary?: unknown
  expiresAt?: unknown
}

interface RawFeed {
  announcements?: unknown
}

/** Validate one raw entry. Returns the cleaned Announcement or null if any
 *  required field is missing/malformed. */
function validateEntry(raw: unknown): Announcement | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as RawAnnouncement
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.title !== 'string' || !r.title) return null
  if (typeof r.href !== 'string' || !r.href) return null
  if (typeof r.publishedAt !== 'string' || Number.isNaN(Date.parse(r.publishedAt))) {
    return null
  }
  try {
    const url = new URL(r.href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  } catch {
    return null
  }
  const cleaned: Announcement = {
    id: r.id,
    title: r.title,
    href: r.href,
    publishedAt: r.publishedAt
  }
  if (typeof r.summary === 'string' && r.summary.trim()) {
    if (r.summary.length > MAX_SUMMARY_LEN) {
      log(
        'announcements',
        `summary on ${r.id} is ${r.summary.length} chars (max ${MAX_SUMMARY_LEN}) — dropping summary, keeping entry`
      )
    } else {
      cleaned.summary = r.summary
    }
  }
  if (typeof r.expiresAt === 'string' && !Number.isNaN(Date.parse(r.expiresAt))) {
    cleaned.expiresAt = r.expiresAt
  }
  return cleaned
}

/** Fetch + validate the feed. Pure-ish: separate from the polling class so
 *  it's easy to unit-test the validation logic without touching timers. */
export async function fetchAnnouncementsFeed(
  url: string = FEED_URL,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<{ items: Announcement[]; rawCount: number }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as RawFeed
    const raw = Array.isArray(body?.announcements) ? body.announcements : []
    const items: Announcement[] = []
    for (const entry of raw) {
      const cleaned = validateEntry(entry)
      if (cleaned) items.push(cleaned)
    }
    return { items, rawCount: raw.length }
  } finally {
    clearTimeout(timer)
  }
}

export class AnnouncementsPoller {
  private store: Store
  private timer: NodeJS.Timeout | null = null
  private inFlight = false

  constructor(store: Store) {
    this.store = store
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.refresh()
    }, POLL_INTERVAL_MS)
    void this.refresh()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const { items, rawCount } = await fetchAnnouncementsFeed()
      const dropped = rawCount - items.length
      if (dropped > 0) {
        log('announcements', `fetched ${items.length} valid, dropped ${dropped} malformed`)
      }
      this.store.dispatch({
        type: 'announcements/loaded',
        payload: { items, fetchedAt: Date.now() }
      })
    } catch (err) {
      const message = formatErr(err)
      log('announcements', `fetch failed: ${message}`)
      this.store.dispatch({ type: 'announcements/fetchFailed', payload: message })
    } finally {
      this.inFlight = false
    }
  }
}
