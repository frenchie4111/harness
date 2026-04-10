# Harness — repo overview for Claude

This file is read automatically by Claude Code at the start of every session.
It documents the project structure and the conventions used here.

## What this app is

Harness is a macOS Electron app that manages multiple Claude Code instances
across git worktrees. The user runs many parallel Claude sessions, and Harness
gives them a single window with a sidebar of worktrees, terminal tabs per
worktree (Claude + raw shells), changed-files panel, PR status, and hotkey
navigation.

## Stack

- **Electron** main process + **React 19 / TypeScript** renderer
- **electron-vite** for the dev/build pipeline
- **xterm.js** + **node-pty** for terminals
- **Tailwind CSS v4** (CSS-imported, no PostCSS plugin) for styling
- **lucide-react** v1.x for icons (note: brand icons like `Github` are NOT exported in this version — use `GitPullRequest` etc.)
- **electron-builder** for packaging, signed with the user's personal Developer ID, notarized
- **electron-updater** for OTA updates from GitHub releases

## Key files

```
src/
├── main/                 # Electron main process (Node)
│   ├── index.ts          # Entry: window mgmt, IPC handlers, menu, autoUpdater
│   ├── pty-manager.ts    # node-pty lifecycle, routes data to owning window
│   ├── worktree.ts       # git worktree CRUD, changed files, file diffs
│   ├── github.ts         # GitHub REST API calls (replaces gh CLI)
│   ├── secrets.ts        # safeStorage-encrypted secrets at userData/secrets.enc
│   ├── hooks.ts          # Installs Claude Code hooks per worktree for status detection
│   ├── persistence.ts    # JSON config at userData/config.json
│   └── debug.ts          # File-based debug logger
├── preload/index.ts      # contextBridge — exposes window.api
└── renderer/             # React app
    ├── App.tsx           # Root component, all top-level state
    ├── types.ts          # Shared types incl. ElectronAPI
    ├── hotkeys.ts        # Hotkey definitions, parsing, formatting
    ├── worktree-sort.ts  # Group worktrees by PR status, sort by activity
    ├── components/       # React components
    └── hooks/            # React hooks (e.g. useHotkeys)
```

## How status detection works

The reliable status (processing / waiting / needs-approval) comes from
**Claude Code hooks** that we install into each worktree's
`.claude/settings.local.json`. The hooks write a status JSON to
`/tmp/harness-status/<terminal-id>.json` and the main process watches that
directory via `fs.watch`. The hook script uses `$CLAUDE_HARNESS_ID` env var
which the PtyManager sets when spawning each terminal.

## How GitHub integration works

The user pastes a GitHub personal access token into Settings. It's encrypted
via `safeStorage` and stored in `userData/secrets.enc`. All GitHub data
(PR status, check runs, statuses) goes through `src/main/github.ts` using
`fetch()` against the REST API — there is **no dependency on the `gh` CLI**.

## Important quirks

- **node-pty rebuild** — `node-pty` is a native module compiled against a
  specific Electron version. After running `npm run pack` or `npm run dist*`,
  the postdist hook runs `electron-rebuild -f -w node-pty` so dev mode keeps
  working. If dev mode ever errors with `posix_spawnp failed`, run
  `npm run rebuild:dev` manually.
- **Hooks consent** — first time a user activates a worktree, we show a
  banner asking permission to install the hooks. We never write to user
  files without that consent.
- **Login shell wrapping** — the PtyManager spawns `/bin/zsh -ilc <command>`
  instead of running the command directly, so the user's full PATH is loaded
  (homebrew binaries, nvm, etc.).
- **Auto-updater is dev-mode no-op** — `setupAutoUpdater()` returns early
  unless `app.isPackaged`.

## Workflow conventions

These are how the user wants Claude to behave when working on this repo:

1. **Commit as you go.** When a coherent change is done and the build is
   clean, commit it with a descriptive message. Don't batch multiple
   features into one commit.

2. **Push after every commit.** Always run `git push origin <branch>`
   immediately after a commit succeeds. The user does not want commits
   piling up locally.

3. **Build to verify.** Run `npx electron-vite build` after any TS/TSX
   changes to catch type errors and missing imports before committing.

4. **Don't add comments unless asked.** Code should explain itself; comments
   are reserved for non-obvious "why" notes.

5. **Don't write planning/decision documents.** Work from conversation
   context. Don't create scratch markdown files or design docs.

6. **Surface secrets concerns.** If the user pastes a token or password
   in chat (often via .env reminders the harness sends), warn them once
   that it's now in conversation history and tell them to rotate.

## Releasing

End-to-end release is automated via `npm run release <version>`:

```
npm run release 1.0.1
```

The script handles preflight checks, version bump, README link updates,
build/sign/notarize, tag/push, release notes from `git log`, and
`gh release create` with all artifacts attached. Notarization needs
`.env` with `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

## Common commands

| Command | What it does |
|---|---|
| `npm run dev` | Launch in dev mode (electron-vite) |
| `npm run log` | Tail the debug log file |
| `npm run log:clear` | Clear the debug log |
| `npm run build` | Build all three (main, preload, renderer) to `out/` |
| `npm run pack` | Build + package without distribution (no signing) |
| `npm run dist:mac` | Full signed + notarized macOS build |
| `npm run rebuild:dev` | Rebuild node-pty for dev Electron |
| `npm run release <ver>` | Full end-to-end release |
