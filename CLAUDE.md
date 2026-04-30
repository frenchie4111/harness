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

## Architecture (read this before touching state)

This app went through a large refactor where **the main process owns all
shared state**, the renderer is a thin view layer, and a single transport
(currently Electron IPC, future: WebSocket) carries both state events
and side-effect signals. If you find yourself adding a `useState` to
hold a value that any other client of this workspace would also want,
you're doing it wrong — that value belongs in a slice.

### The store + slice pattern

State is partitioned into **slices** under `src/shared/state/`. Each
slice has:
- A `State` interface (the data shape)
- An `Event` discriminated union (the mutations)
- A `reducer(state, event) → state` pure function
- An `initial<Slice>` constant
- A test file with one test per event variant

Current slices: `settings`, `prs`, `onboarding`, `hooks`, `worktrees`,
`terminals` (which also owns `panes` and `lastActive`), `updater`,
`repoConfigs`. Adding a new piece of shared state means picking the
right slice (or making a new one) and editing the reducer + event union.

### How a state mutation flows end-to-end

1. **Renderer**: user clicks something. The handler calls a thin IPC
   method like `window.api.setTheme('solarized')`.
2. **Main / preload**: the IPC handler in `src/main/index.ts` does the
   side effect (validation, writing to disk, etc.) and **dispatches a
   typed event** through the store: `store.dispatch({type: 'settings/themeChanged', payload: 'solarized'})`.
3. **Main / store**: `src/main/store.ts` runs the dispatched event
   through the shared `rootReducer`, updates its in-memory `AppState`,
   bumps a monotonic `seq`, and notifies subscribers.
4. **Main / transport**: `src/main/transport-electron.ts` subscribes to
   the store and forwards every event over the `state:event` IPC channel
   to all `BrowserWindow`s.
5. **Renderer / client store**: `src/renderer/store.ts` listens on
   `state:event`, applies the **same** shared `rootReducer` to its local
   mirror, and bumps its own seq.
6. **Renderer / hooks**: `useSyncExternalStore` notifies any component
   reading via `useSettings()` (or the slice-specific hook). React
   re-renders.

The key property: **main and renderer apply the exact same reducer
function** from `src/shared/state/`, so they're guaranteed to stay in
sync with no glue code. The renderer's "client store" is just a passive
mirror.

### Where each kind of state lives

| Kind | Lives in | Why |
|---|---|---|
| Worktree list, panes, terminal status, PR status, settings, hooks consent, onboarding quest, updater status, repo configs, lastActive timestamps | **Main store slices** | Shared world state — every viewer of this workspace needs the same value |
| `activeWorktreeId`, `activePaneId`, modal visibility (`showSettings` etc.), sidebar widths, tree expansion (`collapsedGroups`), form drafts | **Renderer `useState`** | Per-client UI focus / layout — different viewers can validly differ |
| `hooksChecked` Sets, `prevStatusesRef`, debounce refs | **Renderer `useRef`** | Per-session bookkeeping that doesn't survive reload |
| Background polling clocks, dedup state | **Main FSM/poller classes** | Lives wherever the loop runs (PRPoller, ActivityDeriver) |

The test for "is this slice or renderer state": **would a second client
connecting to the same workspace want to see the same value?** If yes,
slice. If no, renderer.

### Key files

```
src/
├── shared/state/                  # Slices imported by BOTH main and renderer
│   ├── index.ts                   # Root reducer + AppState + StateEvent union
│   ├── settings.ts                # Theme, hotkeys, claudeCommand, fonts, …
│   ├── prs.ts                     # byPath PRStatus, mergedByPath, loading
│   ├── worktrees.ts               # list, repoRoots, pending FSM entries
│   ├── terminals.ts               # statuses, pendingTools, shellActivity, panes, lastActive
│   ├── onboarding.ts              # quest step
│   ├── hooks.ts                   # consent + justInstalled
│   ├── updater.ts                 # status (checking/available/downloading/…)
│   ├── repo-configs.ts            # byRepo: per-repo .harness.json contents
│   └── *.test.ts                  # vitest reducer tests, one per slice
│
├── main/
│   ├── index.ts                   # IPC handlers, menu, autoUpdater, store init
│   ├── store.ts                   # The authoritative Store class (~40 lines)
│   ├── transport-electron.ts      # Forwards store events to all windows via state:event IPC
│   ├── pr-poller.ts               # Background PR polling, focus refresh, dedup
│   ├── worktrees-fsm.ts           # Pending-creation FSM (addWorktree → setup script → outcome)
│   ├── panes-fsm.ts               # Every pane/tab mutation (addTab, closeTab, splitPane, …)
│   ├── activity-deriver.ts        # Subscribes to store, derives + records activity transitions
│   ├── pty-manager.ts             # node-pty lifecycle, dispatches statuses to store
│   ├── hooks.ts                   # Installs Claude Code hooks, dispatches statuses to store
│   ├── worktree.ts                # git worktree CRUD primitives
│   ├── github.ts                  # GitHub REST API calls
│   ├── repo-config.ts             # Per-repo .harness.json read/write
│   ├── persistence.ts             # JSON config at userData/config.json
│   ├── secrets.ts                 # safeStorage-encrypted secrets
│   └── debug.ts                   # File-based debug logger
│
├── preload/index.ts               # contextBridge — exposes window.api
│
└── renderer/
    ├── App.tsx                    # Root component, per-client UI focus + JSX
    ├── store.ts                   # Client mirror + useSettings/usePrs/usePanes/etc. hooks
    ├── types.ts                   # ElectronAPI interface (re-exports shared types)
    ├── hotkeys.ts                 # Hotkey definitions, parsing, formatting
    ├── worktree-sort.ts           # Group worktrees by PR status
    ├── components/                # React components
    └── hooks/
        ├── useHotkeys.ts          # Keyboard event subscription
        ├── useMetaHeld.ts         # Meta key detection
        ├── useTailLineBuffer.ts   # Rolling tail-line cache for CommandCenter
        ├── useTabHandlers.ts      # All pane/tab mutation handlers (addTab, splitPane, …)
        ├── useWorktreeHandlers.ts # All worktree+repo+pending-creation handlers
        └── useHotkeyHandlers.ts   # Sidebar-aware hotkey action map + keystroke binding
```

### Adding a new piece of shared state — the 5-file checklist

This is more ceremony than just adding a `useState`, but the payoff is
that any future client (web/mobile/another window) gets the value for
free. Pattern is the same for every slice:

1. **Add to the slice** (`src/shared/state/<slice>.ts`):
   - Add the field to the `State` interface
   - Add an `Event` variant for mutations
   - Add a reducer case
   - Update `initial<Slice>`
2. **Seed it in main** (`src/main/index.ts`, in the `new Store({...})` block)
3. **Add the IPC mutation handler** (in `main/index.ts` `registerIpcHandlers`):
   ```ts
   ipcMain.handle('myslice:setX', (_, value) => {
     // …validation, persist…
     store.dispatch({type: 'myslice/xChanged', payload: value})
     return true
   })
   ```
4. **Expose in preload + types**:
   - `src/preload/index.ts`: `setX: (v) => ipcRenderer.invoke('myslice:setX', v)`
   - `src/renderer/types.ts`: add to `ElectronAPI` interface
5. **Add a reducer test** in `src/shared/state/<slice>.test.ts` (one
   test per new event variant)

The renderer reads the value via the existing `useSettings()` /
`usePrs()` / etc. hook automatically — no new subscription code.

### High-frequency streams (terminal data)

State events are for **mutations**. They go through the reducer and
trigger React re-renders. This is fine for events that fire a few times
per second.

PTY data is **not** a state event — it's a side-effect signal. It flows
through its own `terminal:data` IPC channel directly to xterm.js via
`window.api.onTerminalData`. If we put it through the reducer, every
byte from a noisy build would re-render the world. The same conceptual
distinction applies for any future high-frequency stream.

### How the FSMs / pollers / derivers interact with the store

Some main-side modules subscribe to the store and react to events:

- **`PRPoller`** — owns background polling cadence + dedup. Dispatches
  `prs/*` events. Doesn't subscribe to anything; called externally on
  events that should kick a refresh (focus, worktree add, manual
  refresh button).
- **`WorktreesFSM`** — runs the pending-creation state machine
  (addWorktree → setup script → outcome). Dispatches `worktrees/*`
  events. On success, fires an `onWorktreeCreated` callback that the
  host wires to (a) PR poller refresh and (b) `panesFSM.ensureInitialized`.
- **`PanesFSM`** — owns every pane/tab mutation. Dispatches
  `terminals/panes*` events. Auto-persists panes to disk after each
  mutation.
- **`ActivityDeriver`** — actively *subscribes* to the store. Watches
  `terminals/*` and `prs/*` events, computes per-worktree effective
  state, debounces `lastActive` updates, dedups `recordActivity` calls
  to `activity.ts`.
- **`installHooksForAcceptedWorktrees`** — small subscriber in
  `main/index.ts` that listens for `worktrees/listChanged` and
  `hooks/consentChanged`, installs hooks into any new worktree if
  consent is `'accepted'`.

Construction order in `main/index.ts` matters: `PanesFSM` is constructed
**before** `WorktreesFSM` because the latter's `onWorktreeCreated`
callback closes over `panesFSM`. Don't reorder without thinking.

### Anti-patterns to avoid in slices and derivers

The store-and-slice architecture is sharp. Four common mistakes turn it
into a quadratic CPU sink. All four are caught either at code review or
by the cascade detector in `src/main/store.ts`, which logs a `[cascade]`
line to `perf.log` whenever one root event triggers more than 5 nested
dispatches.

**1. Subscribers that sweep all entities on every event.** A
`store.subscribe(...)` listener that loops over every session / worktree
/ PR on each event is the most common form of this bug. Streaming
events fire 30+ times per second; with N entities, that's `N × token_rate`
dispatches per stream. Always pull the affected entity id out of the
event payload and re-derive only that one. If the event genuinely
affects everything (e.g. the whole tree was replaced), say so in a
comment so the sweep is self-documenting.

**2. Derivers that dispatch identity events.** Even when scoped to a
single entity, a deriver should cache its last-derived value per entity
and skip the dispatch when nothing changed. Most "status" derivations
don't change between adjacent streaming tokens — the dedup is the
difference between "once per turn" and "once per token."

**3. Reducers that lose reference identity on single-item patches.**
`collection.map((x) => x.id === target ? patch(x) : x)` always allocates
a new array, even when nothing matched. Downstream `useSyncExternalStore`
selectors that hold a reference to the array see "changed" and
re-evaluate. Use `findIndex + slice` instead: `return state` when no
match, otherwise build the new array as
`[...arr.slice(0, i), patched, ...arr.slice(i + 1)]`. Untouched entries
keep their reference; downstream selectors don't fire.

**4. Renderer hooks that read whole maps then filter in JS.** A hook
like `useJsonClaude()` that returns the entire slice causes every
consumer to re-evaluate on any change to any entity. Add a per-id
selector (`useJsonClaudeSession(id)`) and use that in components that
care about one entity. The whole-slice hook is only correct in the few
places that genuinely need the full map (sidebar grouping, etc.).

**Diagnosing in production.** The HUD at Cmd+Shift+D shows live event
rates and a stacked bar of which event types are firing most. The
`perf.log` file (see "How performance debugging works" below) captures
per-event detail including `[cascade]` lines when these anti-patterns
fire. If you see a `[cascade]` line for a streaming event type, suspect
anti-pattern #1 first.

### How the renderer reads + mutates state

```tsx
// Read — re-renders this component when the slice changes.
const settings = useSettings()
const theme = settings.theme

// Mutate — fire-and-forget IPC. The store dispatches and the read
// above re-renders automatically.
window.api.setTheme('solarized')
```

The renderer **never holds a local copy of shared state**. There's no
"I'll keep my own `themeState` and re-fetch" pattern anywhere. If you
catch yourself writing `useState` for a value that came from the store,
delete it and read via the hook.

Per-client UI state (active worktree, modal visibility, sidebar width)
**stays as `useState` in App.tsx** — those are inherently per-viewer.

### Why "where does this live" can take a few file hops to answer

A `useSettings().theme` read traces through:
1. `App.tsx` calls the hook
2. `src/renderer/store.ts` defines the hook (`useAppState((s) => s.settings)`)
3. `useSyncExternalStore` reads from the client mirror in `store.ts`
4. The mirror was populated by a `state:event` IPC message
5. Main dispatched that event from an IPC handler in `main/index.ts`
6. The handler ran the reducer in `src/shared/state/settings.ts`

Six files for one value. The mitigation: **the structure is the same
for every slice**. Once you understand it once, every other slice
follows the same path. Search for "settingsReducer" or grep for the
event type if you're trying to find where something happens.

## How status detection works

The reliable status (processing / waiting / needs-approval) comes from
**Claude Code hooks** that we install into each worktree's
`.claude/settings.local.json`. The hooks write a status JSON to
`/tmp/harness-status/<terminal-id>.json` and the main process watches that
directory via `fs.watch`. The hook script uses `$CLAUDE_HARNESS_ID` env var
which the PtyManager sets when spawning each terminal.

## How performance debugging works

Two log files in `userData`:

- **`debug.log`** — categorical events. Cleared on startup. Tail with
  `npm run log`.
- **`perf.log`** — perf trace. **Append-only across sessions** so lag
  that happened earlier (possibly before the most recent restart) is
  still inspectable. Tail with `npm run log:perf`. Clear before a fresh
  repro with `npm run log:perf:clear`.

What gets written to `perf.log` (and where the threshold lives):

- `[store-slow]` — any `store.dispatch` whose reducer + listener fan-out
  totals ≥ `SLOW_DISPATCH_MS` (5 ms; `src/main/store.ts`).
- `[ipc-slow]` — any IPC request or fire-and-forget signal handler that
  takes ≥ `SLOW_IPC_MS` (50 ms; `src/main/transport-electron.ts` and
  `src/main/transport-websocket.ts` — both transports are wrapped so
  headless gets the same trace).
- `[eventloop-spike]` — main-process event-loop lag (timer drift on a
  500 ms interval) ≥ `LAG_SPIKE_THRESHOLD_MS` (100 ms;
  `src/main/perf-monitor.ts`).
- `[snapshot]` — one summary line every `SNAPSHOT_INTERVAL_MS` (30 s)
  with current rates, lag, RSS, active PTYs, and top event types. Cheap
  continuous trace for "what was happening at <timestamp>".
- `[render-slow]` — React commits ≥ `SLOW_COMMIT_MS` (16 ms = one frame
  at 60 fps; `src/renderer/main.tsx`). Forwarded from the renderer over
  the `perf:logSlowRender` fire-and-forget signal — telemetry must not
  block the render.
- `[changed-files]` — every `getChangedFiles` / `getCommitChangedFiles`
  call (these are infrequent and a complete trace is invaluable).

The HUD at **Cmd+Shift+D** shows live aggregates (rates, history sparkline,
React commits per second, top event types). `perf.log` captures the
per-event detail the HUD can't display. They're complementary —
`PerfMonitor` aggregates for the HUD, `perfLog` writes discrete
slow-event lines.

For AI agents debugging perf: ask the user to `npm run log:perf:clear`,
reproduce, then tail `perf.log` and look for the slow-* lines around the
reported timestamp.

## How GitHub integration works

The user pastes a GitHub personal access token into Settings. It's encrypted
via `safeStorage` and stored in `userData/secrets.enc`. All GitHub data
(PR status, check runs, statuses) goes through `src/main/github.ts` using
`fetch()` against the REST API.

Token resolution lives in `src/main/github-auth.ts` and runs once at boot
(re-runs on a 401): an explicit PAT in `secrets.enc` or `GITHUB_TOKEN` wins,
then `gh auth token` (spawned through a login zsh so Homebrew's `gh` is on
PATH), then nothing. The `gh` CLI is an **optional** auto-detect convenience
— if it's installed and authenticated, Harness uses its token automatically;
if not, the PAT paste flow in Settings is still the fallback. Harness has no
hard dependency on `gh`.

## Important quirks

- **Worktree dep installs** — fresh git worktrees under
  `claude-harness-worktrees/` start with no `node_modules`. Run
  `npm install --legacy-peer-deps` once before building (the `--legacy-peer-deps`
  flag is required because `electron-vite@5` declares a peer range that
  npm's strict resolver rejects against the installed `vite@7`).
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

3. **Verify before committing.** After any TS/TSX change, run both:
   - `npm run typecheck` — catches type errors across main + renderer via
     project references. `electron-vite build` does NOT run `tsc`, so the
     build alone will miss type errors.
   - `npx electron-vite build` — catches missing imports, asset resolution,
     and other bundler-level issues.
   Run `npx vitest run` too if the change could affect reducer/FSM behavior.

4. **Don't add comments unless asked.** Code should explain itself; comments
   are reserved for non-obvious "why" notes. The exception is the comment
   blocks already present in `src/main/store.ts`, `src/main/index.ts`
   (around the panesFSM/worktreesFSM construction), `src/shared/state/index.ts`,
   `src/renderer/store.ts`, and `src/main/activity-deriver.ts` — those
   document the load-bearing architecture decisions and should be
   preserved/updated rather than removed.

5. **State changes go through slices, not `useState`.** If you're tempted
   to add `const [x, setX] = useState(...)` in the renderer for a value
   that should survive a reload or be visible to other clients, stop.
   Add it to a slice instead — see "Adding a new piece of shared state"
   above. Per-client UI focus / modal visibility / sidebar widths stay
   as `useState` in App.tsx; everything else is a slice.

6. **Don't write planning/decision documents.** Work from conversation
   context. Don't create scratch markdown files or design docs.

7. **Surface secrets concerns.** If the user pastes a token or password
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
| `npm run log:perf` | Tail the perf trace log (append-only across sessions) |
| `npm run log:perf:clear` | Clear the perf trace log (use before a fresh repro) |
| `npm run build` | Build all three (main, preload, renderer) to `out/` |
| `npm run pack` | Build + package without distribution (no signing) |
| `npm run dist:mac` | Full signed + notarized macOS build |
| `npm run rebuild:dev` | Rebuild node-pty for dev Electron |
| `npm run release <ver>` | Full end-to-end release |
