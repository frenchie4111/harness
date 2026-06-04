// Clickable file-path links for terminal & agent tabs.
//
// This implements the VS Code-style "link provider" model (see
// microsoft/vscode#91290): instead of eagerly scanning the whole viewport
// with regexes, xterm asks us for links on a single buffer line only when
// the mouse hovers it (`provideLinks`). We parse path-like tokens, validate
// them against the worktree's file list (so prose / flags / URLs don't
// linkify), and return a link per real, in-worktree file.
//
// Activation (gated in XTerminal): Cmd/Ctrl-click opens an in-app file tab;
// Cmd/Ctrl+Shift-click opens the file in the user's external editor.

import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

/** A file path parsed out of one line of terminal output. */
export interface ParsedFilePath {
  /** 0-based start offset of the whole match (path + any :line:col) in the line. */
  start: number
  /** Length of the whole match, in characters. */
  length: number
  /** The path portion only, as it appeared (no line/col suffix). */
  path: string
  /** 1-based line number if the token carried one (foo.ts:42 / foo.ts(42,5)). */
  line?: number
  /** 1-based column if present. */
  column?: number
}

// A path-like token: an optional `/`, `./` or `../` prefix, zero or more
// directory segments, then a filename with an extension. An optional
// trailing `:line[:col]` or `(line[,col])` (tsc style) is captured
// separately. The leading lookbehind keeps us from starting mid-token.
//
// We deliberately keep this permissive and lean on worktree-membership
// validation downstream rather than trying to encode every compiler's
// format — the lesson the VS Code issue calls out as "awfulness".
const FILE_TOKEN =
  /(?<![\w@/.\-])((?:\/|\.\.?\/)?(?:[\w.@\-+]+\/)*[\w.@\-+]+\.[A-Za-z][A-Za-z0-9]*)(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))?/g

/** Pure parser: extract candidate file paths (with optional line/col) from a
 *  single line of text. Validation against the worktree happens separately. */
export function parseFilePaths(line: string): ParsedFilePath[] {
  const out: ParsedFilePath[] = []
  FILE_TOKEN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILE_TOKEN.exec(line)) !== null) {
    const lineNo = m[2] ?? m[4]
    const colNo = m[3] ?? m[5]
    out.push({
      start: m.index,
      length: m[0].length,
      path: m[1],
      line: lineNo ? parseInt(lineNo, 10) : undefined,
      column: colNo ? parseInt(colNo, 10) : undefined
    })
  }
  return out
}

/** Normalize a parsed path to a worktree-relative path suitable for testing
 *  against the worktree file set, or null if it can't be resolved inside the
 *  worktree. Absolute paths must live under `cwd`; `../`-climbing paths are
 *  rejected (we only resolve against the worktree root, not the live cwd). */
export function toWorktreeRelative(path: string, cwd: string): string | null {
  let p = path
  while (p.startsWith('./')) p = p.slice(2)
  if (p.startsWith('/')) {
    const base = cwd.endsWith('/') ? cwd : cwd + '/'
    if (!p.startsWith(base)) return null
    p = p.slice(base.length)
  }
  if (p === '' || p.startsWith('../') || p === '..') return null
  return p
}

// ---------------------------------------------------------------------------
// Worktree file-set cache. listAllFiles() shells out, so we cache the result
// per worktree (shared across that worktree's terminal tabs) with a soft TTL
// and refresh on demand. provideLinks reads the cached set synchronously.
// ---------------------------------------------------------------------------

const fileSets = new Map<string, Set<string>>()
const inflight = new Map<string, Promise<void>>()
const loadedAt = new Map<string, number>()
const MIN_REFRESH_MS = 5000

/** Synchronously read the cached worktree file set (null if not loaded yet). */
export function getCachedWorktreeFiles(cwd: string): Set<string> | null {
  return fileSets.get(cwd) ?? null
}

/** Load (or refresh) the worktree file set. Dedupes concurrent loads and
 *  skips reloads within MIN_REFRESH_MS unless `force` is set. `now` is
 *  injectable for tests. */
export function loadWorktreeFiles(
  cwd: string,
  list: (cwd: string) => Promise<string[]>,
  opts: { force?: boolean; now?: number } = {}
): Promise<void> {
  const existing = inflight.get(cwd)
  if (existing) return existing
  const now = opts.now ?? Date.now()
  if (!opts.force && fileSets.has(cwd) && now - (loadedAt.get(cwd) ?? 0) < MIN_REFRESH_MS) {
    return Promise.resolve()
  }
  const p = list(cwd)
    .then((files) => {
      fileSets.set(cwd, new Set(files))
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
export function __resetWorktreeFileCache(): void {
  fileSets.clear()
  inflight.clear()
  loadedAt.clear()
}

// ---------------------------------------------------------------------------
// Link provider
// ---------------------------------------------------------------------------

export interface FileLinkProviderOptions {
  terminal: Terminal
  /** Worktree root (XTerminal's `cwd` prop). */
  cwd: string
  /** Synchronous accessor for the validated worktree file set. */
  getKnownFiles: () => Set<string> | null
  /** Open the worktree-relative file in an in-app file tab (Cmd/Ctrl-click). */
  openInApp: (rel: string, link: ParsedFilePath) => void
  /** Open the worktree-relative file in the external editor (plain click). */
  openInEditor: (rel: string, link: ParsedFilePath) => void
  /** Notified when the pointer enters/leaves a file link, so the host can
   *  withhold the click's mouse-report bytes from a mouse-aware PTY (the same
   *  trick the URL/commit link providers use to avoid a double-action). */
  onHoverChange?: (hovering: boolean) => void
}

/** Build an xterm ILinkProvider that linkifies real, in-worktree file paths.
 *  Every candidate is validated against the worktree's file set, so this works
 *  even on the alternate screen buffer (agent tabs / full-screen Claude/Codex
 *  TUI): a token only linkifies if it exactly matches a real in-worktree file,
 *  which TUI chrome won't accidentally produce. */
export function makeFileLinkProvider(opts: FileLinkProviderOptions): ILinkProvider {
  const { terminal, cwd, getKnownFiles, openInApp, openInEditor, onHoverChange } = opts
  return {
    provideLinks(lineNumber, callback) {
      const known = getKnownFiles()
      if (!known || known.size === 0) {
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
      for (const match of parseFilePaths(text)) {
        const rel = toWorktreeRelative(match.path, cwd)
        if (rel === null || !known.has(rel)) continue
        links.push({
          text: text.slice(match.start, match.start + match.length),
          range: {
            start: { x: match.start + 1, y: lineNumber },
            end: { x: match.start + match.length, y: lineNumber }
          },
          decorations: { pointerCursor: true, underline: true },
          // Mirror the URL link model: plain click → external (here, the
          // user's editor); Cmd/Ctrl-click → in-app (a file tab).
          activate: (event) => {
            if (event.metaKey || event.ctrlKey) openInApp(rel, match)
            else openInEditor(rel, match)
          },
          hover: () => onHoverChange?.(true),
          leave: () => onHoverChange?.(false)
        })
      }
      callback(links.length ? links : undefined)
    }
  }
}
