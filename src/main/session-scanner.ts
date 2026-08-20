import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { userDataDir } from './paths'
import { log } from './debug'

/** Scans `~/.claude/projects` for Claude Code transcripts the user produced
 *  outside Ness, so they can be browsed and imported.
 *
 *  Two properties of the on-disk corpus drive the design here, both measured
 *  against a real 8.2k-session / 1.0GB tree rather than assumed:
 *
 *  1. `cwd` and `gitBranch` are read from the LINE CONTENT, never from the
 *     project directory name. The directory name is a lossy encoding of the
 *     cwd (every non-alphanumeric collapses to '-'), and in practice one
 *     directory can accumulate the overwhelming majority of all sessions —
 *     on the machine this was developed against, 6097 of 8266 sessions sat
 *     in a single dir named '-' (cwd '/'). Grouping by directory name
 *     produces one useless mega-bucket; grouping by line-content cwd does
 *     not.
 *
 *  2. Sessions are read in a single bounded chunk where possible. 94% of
 *     transcripts are under 64KB, so a 64KB tail read covers the whole file
 *     and yields exact counts for free. Only the ~5% above that need the
 *     head+tail path, and those are unambiguously substantive already, so
 *     their turn counts are reported as a lower bound rather than paying a
 *     full read of the multi-hundred-MB tail of the corpus. */

const TAIL_BYTES = 64 * 1024
const HEAD_BYTES = 32 * 1024
const CACHE_VERSION = 1

export interface DiscoveredSession {
  sessionId: string
  transcriptPath: string
  /** Working directory the session actually ran in, read from line content. */
  cwd: string | null
  gitBranch: string | null
  title: string | null
  titleSource: 'custom' | 'ai' | 'first-message' | null
  prNumber: number | null
  prUrl: string | null
  prRepository: string | null
  firstTimestamp: number | null
  lastTimestamp: number | null
  /** Count of turns the user would actually see in the transcript, using the
   *  same filters as JsonClaudeManager.parseTranscriptEntries so the substance
   *  filter agrees with what an import would render. */
  userTurns: number
  /** False when the file was too large to read whole — `userTurns` is then a
   *  lower bound taken from the head+tail chunks. */
  userTurnsExact: boolean
  sizeBytes: number
  mtimeMs: number
  cliVersion: string | null
}

export interface ScanResult {
  sessions: DiscoveredSession[]
  scannedFiles: number
  cacheHits: number
  elapsedMs: number
}

interface Accumulator {
  cwd: string | null
  gitBranch: string | null
  customTitle: string | null
  aiTitle: string | null
  firstUserMessage: string | null
  prNumber: number | null
  prUrl: string | null
  prRepository: string | null
  firstTimestamp: number | null
  lastTimestamp: number | null
  userTurns: number
  cliVersion: string | null
}

function emptyAccumulator(): Accumulator {
  return {
    cwd: null,
    gitBranch: null,
    customTitle: null,
    aiTitle: null,
    firstUserMessage: null,
    prNumber: null,
    prUrl: null,
    prRepository: null,
    firstTimestamp: null,
    lastTimestamp: null,
    userTurns: 0,
    cliVersion: null
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Mirrors the skip rules in JsonClaudeManager.parseTranscriptEntries: the
 *  SDK writes synthetic user records around compactions and slash commands
 *  that aren't user-typed input and don't render as user bubbles. Counting
 *  them would make one-shot `/clear` sessions look substantive. */
function isRenderableUserTurn(parsed: Record<string, unknown>): boolean {
  if (parsed['isCompactSummary'] === true) return false
  if (parsed['isMeta'] === true) return false
  const message = parsed['message'] as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content !== 'string') return false
  if (content.startsWith('<command-name>')) return false
  if (content.startsWith('<local-command-stdout>')) return false
  return content.trim().length > 0
}

/** Records carry their top-level metadata block AFTER the `message` payload
 *  (observed key order: parentUuid, isSidechain, message, …, type, uuid,
 *  timestamp, cwd, sessionId, version, gitBranch). That ordering is what
 *  makes the fast path below safe: scanning for `"type":"…"` from the START
 *  of an assistant line would hit the inner content blocks' own type fields
 *  ("text", "thinking", "tool_use") long before the record's own type, but
 *  a bounded slice off the END reliably lands in the trailing metadata. */
const TRAILER_BYTES = 512
/** Lines longer than this skip JSON.parse. Assistant records and tool-result
 *  user records make up the bulk of a transcript's bytes and none of them
 *  need a materialised object — parsing them was 80% of scan time. */
const BIG_LINE_BYTES = 2 * 1024

const TRAILER_TYPE_RE = /"type":"([a-zA-Z_-]+)"/
const TRAILER_TIMESTAMP_RE = /"timestamp":"([^"]+)"/
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/
const BRANCH_RE = /"gitBranch":"((?:[^"\\]|\\.)*)"/
const VERSION_RE = /"version":"([^"]*)"/
function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value
  }
}

/** Pull metadata off a large ASSISTANT line without materialising it.
 *
 *  Deliberately limited to assistant records. An earlier version took this
 *  path for large user records too, extracting `message.content` with a
 *  regex — but a user record carrying tool results has array content whose
 *  elements have their OWN `"content":"…"` field, so the regex matched the
 *  tool output and both mis-counted turns and produced garbage titles.
 *  Assistant records need nothing but timestamps here, which makes the
 *  regex path unambiguous; large user records fall back to JSON.parse,
 *  and they're rare enough next to assistant traffic that the scan keeps
 *  almost all of its speed-up.
 *
 *  Returns false when the caller must fall back to a full parse. */
function absorbBigAssistantLine(line: string, acc: Accumulator): boolean {
  const trailer = line.slice(-TRAILER_BYTES)
  const type = TRAILER_TYPE_RE.exec(trailer)?.[1]
  if (type !== 'assistant') return false

  if (acc.cwd === null) {
    const m = CWD_RE.exec(trailer)
    if (m) acc.cwd = unescapeJsonString(m[1])
  }
  if (acc.gitBranch === null) {
    const m = BRANCH_RE.exec(trailer)
    if (m) acc.gitBranch = unescapeJsonString(m[1])
  }
  if (acc.cliVersion === null) {
    const m = VERSION_RE.exec(trailer)
    if (m) acc.cliVersion = m[1]
  }
  const tsRaw = TRAILER_TIMESTAMP_RE.exec(trailer)?.[1]
  const ts = tsRaw ? parseTimestamp(tsRaw) : null
  if (ts !== null) {
    if (acc.firstTimestamp === null || ts < acc.firstTimestamp) acc.firstTimestamp = ts
    if (acc.lastTimestamp === null || ts > acc.lastTimestamp) acc.lastTimestamp = ts
  }
  return true
}

function absorbLine(raw: string, acc: Accumulator): void {
  const trimmed = raw.trim()
  if (!trimmed || trimmed[0] !== '{') return

  if (trimmed.length > BIG_LINE_BYTES && absorbBigAssistantLine(trimmed, acc)) return

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Expected on the first line of a tail chunk, which starts mid-record.
    return
  }

  const type = parsed['type']

  if (type === 'custom-title') {
    const t = parsed['customTitle']
    if (typeof t === 'string' && t.trim()) acc.customTitle = t.trim()
    return
  }
  if (type === 'ai-title') {
    const t = parsed['aiTitle']
    if (typeof t === 'string' && t.trim()) acc.aiTitle = t.trim()
    return
  }
  if (type === 'pr-link') {
    const n = parsed['prNumber']
    if (typeof n === 'number') acc.prNumber = n
    const url = parsed['prUrl']
    if (typeof url === 'string') acc.prUrl = url
    const repo = parsed['prRepository']
    if (typeof repo === 'string') acc.prRepository = repo
    return
  }

  if (type !== 'user' && type !== 'assistant') return

  const cwd = parsed['cwd']
  if (typeof cwd === 'string' && cwd) acc.cwd = acc.cwd ?? cwd
  const branch = parsed['gitBranch']
  if (typeof branch === 'string' && branch) acc.gitBranch = acc.gitBranch ?? branch
  const version = parsed['version']
  if (typeof version === 'string' && version) acc.cliVersion = acc.cliVersion ?? version

  const ts = parseTimestamp(parsed['timestamp'])
  if (ts !== null) {
    if (acc.firstTimestamp === null || ts < acc.firstTimestamp) acc.firstTimestamp = ts
    if (acc.lastTimestamp === null || ts > acc.lastTimestamp) acc.lastTimestamp = ts
  }

  if (type === 'user' && isRenderableUserTurn(parsed)) {
    acc.userTurns++
    if (acc.firstUserMessage === null) {
      const message = parsed['message'] as { content?: unknown }
      acc.firstUserMessage = (message.content as string).trim()
    }
  }
}

function readRange(path: string, start: number, length: number): string {
  if (length <= 0) return ''
  const buf = Buffer.alloc(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, length, start)
  } finally {
    closeSync(fd)
  }
  return buf.toString('utf8')
}

function titleFrom(acc: Accumulator): {
  title: string | null
  titleSource: DiscoveredSession['titleSource']
} {
  if (acc.customTitle) return { title: acc.customTitle, titleSource: 'custom' }
  if (acc.aiTitle) return { title: acc.aiTitle, titleSource: 'ai' }
  if (acc.firstUserMessage) {
    const oneLine = acc.firstUserMessage.replace(/\s+/g, ' ')
    const clipped = oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine
    return { title: clipped, titleSource: 'first-message' }
  }
  return { title: null, titleSource: null }
}

export function readSessionFile(
  transcriptPath: string,
  sizeBytes: number,
  mtimeMs: number
): DiscoveredSession {
  const sessionId = transcriptPath.replace(/^.*\//, '').replace(/\.jsonl$/, '')
  const acc = emptyAccumulator()
  let userTurnsExact = true

  if (sizeBytes <= TAIL_BYTES) {
    let raw = ''
    try {
      raw = readFileSync(transcriptPath, 'utf8')
    } catch {
      raw = ''
    }
    for (const line of raw.split('\n')) absorbLine(line, acc)
  } else {
    // Head gives the opening user turn (title fallback) and first timestamp;
    // tail gives the titles, pr-link and last timestamp, which are appended
    // as the session progresses.
    userTurnsExact = false
    try {
      const head = readRange(transcriptPath, 0, HEAD_BYTES)
      for (const line of head.split('\n')) absorbLine(line, acc)
      const tail = readRange(transcriptPath, sizeBytes - TAIL_BYTES, TAIL_BYTES)
      for (const line of tail.split('\n')) absorbLine(line, acc)
    } catch {
      // Fall through with whatever was absorbed.
    }
  }

  const { title, titleSource } = titleFrom(acc)
  return {
    sessionId,
    transcriptPath,
    cwd: acc.cwd,
    gitBranch: acc.gitBranch,
    title,
    titleSource,
    prNumber: acc.prNumber,
    prUrl: acc.prUrl,
    prRepository: acc.prRepository,
    firstTimestamp: acc.firstTimestamp,
    lastTimestamp: acc.lastTimestamp,
    userTurns: acc.userTurns,
    userTurnsExact,
    sizeBytes,
    mtimeMs,
    cliVersion: acc.cliVersion
  }
}

interface CacheEntry {
  mtimeMs: number
  sizeBytes: number
  session: DiscoveredSession
}

interface CacheFile {
  version: number
  entries: Record<string, CacheEntry>
}

function cachePath(): string {
  return join(userDataDir(), 'session-scan-cache.json')
}

function loadCache(): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as CacheFile
    if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== 'object') {
      return {}
    }
    return parsed.entries ?? {}
  } catch {
    return {}
  }
}

function saveCache(entries: Record<string, CacheEntry>): void {
  const path = cachePath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    const payload: CacheFile = { version: CACHE_VERSION, entries }
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    log('session-scan', 'cache write failed', err instanceof Error ? err.message : String(err))
  }
}

export function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

export interface ScanOptions {
  root?: string
  /** Skip the on-disk cache entirely. Used by tests. */
  useCache?: boolean
  onProgress?: (done: number, total: number) => void
}

/** How many transcripts to process between event-loop yields. The scan runs
 *  on the main process's thread, so a straight-through loop over a large
 *  corpus blocks every IPC reply and every render for its whole duration —
 *  measured at several seconds on an 8.3k-session tree. Yielding keeps the
 *  UI responsive and lets progress events actually reach the renderer while
 *  the scan is in flight. */
const YIELD_EVERY = 100

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function scanSessions(options: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now()
  const root = options.root ?? projectsRoot()
  const useCache = options.useCache !== false
  const cache = useCache ? loadCache() : {}
  const nextCache: Record<string, CacheEntry> = {}

  let dirEntries: string[]
  try {
    dirEntries = readdirSync(root)
  } catch {
    return { sessions: [], scannedFiles: 0, cacheHits: 0, elapsedMs: Date.now() - started }
  }

  const candidates: { path: string; sizeBytes: number; mtimeMs: number }[] = []
  let dirsWalked = 0
  for (const dir of dirEntries) {
    // The walk itself stats thousands of files; yield here too or the scan
    // blocks before it has even reported progress.
    if (++dirsWalked % YIELD_EVERY === 0) await yieldToEventLoop()
    let files: string[]
    try {
      files = readdirSync(join(root, dir))
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const path = join(root, dir, file)
      try {
        const st = statSync(path)
        if (!st.isFile()) continue
        candidates.push({ path, sizeBytes: st.size, mtimeMs: st.mtimeMs })
      } catch {
        continue
      }
    }
  }

  const sessions: DiscoveredSession[] = []
  let cacheHits = 0
  let done = 0
  for (const candidate of candidates) {
    const cached = cache[candidate.path]
    let session: DiscoveredSession
    if (
      cached &&
      cached.mtimeMs === candidate.mtimeMs &&
      cached.sizeBytes === candidate.sizeBytes
    ) {
      session = cached.session
      cacheHits++
    } else {
      session = readSessionFile(candidate.path, candidate.sizeBytes, candidate.mtimeMs)
    }
    sessions.push(session)
    nextCache[candidate.path] = {
      mtimeMs: candidate.mtimeMs,
      sizeBytes: candidate.sizeBytes,
      session
    }
    done++
    options.onProgress?.(done, candidates.length)
    if (done % YIELD_EVERY === 0) await yieldToEventLoop()
  }

  if (useCache) saveCache(nextCache)

  sessions.sort((a, b) => (b.lastTimestamp ?? b.mtimeMs) - (a.lastTimestamp ?? a.mtimeMs))
  return {
    sessions,
    scannedFiles: candidates.length,
    cacheHits,
    elapsedMs: Date.now() - started
  }
}

/** True when a session looks like real work rather than a throwaway probe.
 *  Drives the default filter in the import browser. */
export function isSubstantive(session: DiscoveredSession): boolean {
  if (!session.userTurnsExact) return true
  return session.userTurns >= 2
}

export function sessionExists(session: DiscoveredSession): boolean {
  return existsSync(session.transcriptPath)
}
