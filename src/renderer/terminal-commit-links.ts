// Clickable git commit-SHA links for terminal & agent tabs.
//
// Same VS Code-style "link provider" model as terminal-file-links.ts (see
// microsoft/vscode#91290): xterm asks us for links on a single hovered
// buffer line only. We parse hex tokens that look like commit SHAs and
// validate them against the worktree's known commit set (so arbitrary hex
// — sha256 digests, hashes, IDs — doesn't linkify). Only abbreviations
// that resolve to a real commit get a link.
//
// Activation (gated in XTerminal): Cmd/Ctrl-click opens a popup rendering
// the commit's metadata + diff.

import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

/** A commit-SHA token parsed out of one line of terminal output. */
export interface ParsedCommitSha {
  /** 0-based start offset of the token in the line. */
  start: number
  /** Length of the token, in characters. */
  length: number
  /** The hex token as it appeared (7–40 chars, lowercase). */
  sha: string
}

// A standalone lowercase-hex run of 7–40 chars. The hex-char lookbehind /
// lookahead keep us from matching a slice of a longer hex string (e.g. a
// 64-char sha256), so only tokens that are hex-bounded on both sides — the
// way git prints abbreviated and full SHAs — are considered. Git SHAs are
// always lowercase, so we don't accept A–F.
const COMMIT_SHA_TOKEN = /(?<![0-9a-fA-F])([0-9a-f]{7,40})(?![0-9a-fA-F])/g

/** Pure parser: extract candidate commit-SHA tokens from a single line of
 *  text. Validation against the worktree's commit set happens separately. */
export function parseCommitShas(line: string): ParsedCommitSha[] {
  const out: ParsedCommitSha[] = []
  COMMIT_SHA_TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = COMMIT_SHA_TOKEN.exec(line)) !== null) {
    out.push({ start: m.index, length: m[1].length, sha: m[1] })
  }
  return out
}

/** Resolve a (possibly abbreviated) SHA prefix to a full commit SHA from a
 *  sorted list of full SHAs, or null if no commit starts with it. Binary
 *  search over the sorted array handles any prefix length. Returns the first
 *  match; ambiguous prefixes (rare for printed SHAs) resolve to one of them,
 *  which `git show` will still render. */
export function resolveCommitSha(prefix: string, sortedShas: string[]): string | null {
  let lo = 0
  let hi = sortedShas.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sortedShas[mid] < prefix) lo = mid + 1
    else hi = mid
  }
  const candidate = sortedShas[lo]
  return candidate !== undefined && candidate.startsWith(prefix) ? candidate : null
}

// ---------------------------------------------------------------------------
// Worktree commit-set cache. listRecentCommitShas() shells out, so we cache
// the result per worktree (shared across that worktree's tabs) with a soft
// TTL. The cached array is kept sorted so provideLinks can resolve prefixes
// synchronously via binary search.
// ---------------------------------------------------------------------------

const commitSets = new Map<string, string[]>()
const inflight = new Map<string, Promise<void>>()
const loadedAt = new Map<string, number>()
const MIN_REFRESH_MS = 5000

/** Synchronously read the cached, sorted worktree commit set (null if not
 *  loaded yet). */
export function getCachedWorktreeCommits(cwd: string): string[] | null {
  return commitSets.get(cwd) ?? null
}

/** Load (or refresh) the worktree commit set. Dedupes concurrent loads and
 *  skips reloads within MIN_REFRESH_MS unless `force` is set. `now` is
 *  injectable for tests. */
export function loadWorktreeCommits(
  cwd: string,
  list: (cwd: string) => Promise<string[]>,
  opts: { force?: boolean; now?: number } = {}
): Promise<void> {
  const existing = inflight.get(cwd)
  if (existing) return existing
  const now = opts.now ?? Date.now()
  if (!opts.force && commitSets.has(cwd) && now - (loadedAt.get(cwd) ?? 0) < MIN_REFRESH_MS) {
    return Promise.resolve()
  }
  const p = list(cwd)
    .then((shas) => {
      commitSets.set(cwd, [...shas].sort())
      loadedAt.set(cwd, opts.now ?? Date.now())
    })
    .catch(() => {
      /* leave any previously-cached set in place */
    })
    .finally(() => {
      inflight.delete(cwd)
    })
  inflight.set(cwd, p)
  return p
}

/** Test-only: drop all cached state. */
export function __resetWorktreeCommitCache(): void {
  commitSets.clear()
  inflight.clear()
  loadedAt.clear()
}

// ---------------------------------------------------------------------------
// Link provider
// ---------------------------------------------------------------------------

export interface CommitLinkProviderOptions {
  terminal: Terminal
  /** Synchronous accessor for the sorted worktree commit set. */
  getKnownCommits: () => string[] | null
  /** Open the commit popup for the resolved full SHA. `event` carries the
   *  click coordinates so the popup can anchor to the SHA. */
  openCommit: (fullSha: string, event: MouseEvent) => void
  /** Pointer entered a commit link (`event` carries hover coordinates). The
   *  host uses this both to show a blame-style hover card and to withhold the
   *  click's mouse-report bytes from a mouse-aware PTY (the same trick the URL
   *  link providers use to avoid a double-action). */
  onHover?: (fullSha: string, event: MouseEvent) => void
  /** Pointer left the commit link. */
  onLeave?: () => void
}

/** Build an xterm ILinkProvider that linkifies real commit SHAs.
 *
 *  Unlike the file-path provider, this does NOT bail on the alternate screen
 *  buffer: agent tabs (the full-screen Claude/Codex TUI) run there, and
 *  commit SHAs are exactly what shows up in that output (git logs, commit
 *  references). Validating every candidate against the worktree's commit set
 *  means TUI chrome can't false-positive into a link the way a loose path
 *  token could, so linkifying in the alternate buffer is safe here. */
export function makeCommitLinkProvider(opts: CommitLinkProviderOptions): ILinkProvider {
  const { terminal, getKnownCommits, openCommit, onHover, onLeave } = opts
  return {
    provideLinks(lineNumber, callback) {
      const known = getKnownCommits()
      if (!known || known.length === 0) {
        callback(undefined)
        return
      }
      const bufLine = terminal.buffer.active.getLine(lineNumber - 1)
      if (!bufLine) {
        callback(undefined)
        return
      }
      const text = bufLine.translateToString(true)
      const links: ILink[] = []
      for (const match of parseCommitShas(text)) {
        const full = resolveCommitSha(match.sha, known)
        if (full === null) continue
        links.push({
          text: text.slice(match.start, match.start + match.length),
          range: {
            start: { x: match.start + 1, y: lineNumber },
            end: { x: match.start + match.length, y: lineNumber }
          },
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => openCommit(full, event),
          hover: (event) => onHover?.(full, event),
          leave: () => onLeave?.()
        })
      }
      callback(links.length ? links : undefined)
    }
  }
}
