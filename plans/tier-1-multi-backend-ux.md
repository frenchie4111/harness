# Tier 1 — multi-backend UX

A single Harness window connects to N backends (the in-process local
one + remote `harness-server` instances) and switches between them like
Slack switches workspaces. Each backend has its own worktrees,
terminals, panes, PRs, costs, hooks state — switching changes which
backend's UI is rendered. Background backends keep streaming so the
user notices things happening on machines they aren't currently
looking at.

This doc tracks the UX/architecture decisions. Tier 1 is interim — Tier
2 (unified sidebar, cross-backend operations) will replace the chrome —
but Tier 1 is bounded and pays off the moment you have one remote box.

**Status: all 12 questions resolved.** The implementation worktree
can pick this up. KISS was the dominant principle — every "could go
either way" was resolved toward less code, less surface, less
ceremony. Anything fancier (notifications, multi-window, capability
framework, version handshake) is an additive change later.

Status tags: 🟢 Decided · 🟡 Leaning · 🔴 Open

The plumbing this builds on: the 2.0 state migration (every slice runs
the same reducer in main and renderer over a swappable transport) and
the `electron-remote-mode` work (renderer can already pick
`WebSocketClientTransport` or `ElectronClientTransport` at boot). Both
in `plans/remote-main.md`. What changes: the renderer instantiates **N
transports + N mirrored stores**, one per backend, and the active
backend determines which mirror feeds the existing `useWorktrees()` /
`usePrs()` / etc. hooks.

---

## A. Where does the switcher live in the chrome? 🟢 Decided — chip strip above the bottom icon row in the sidebar

Lives at the bottom of the existing `Sidebar`
(`src/renderer/components/Sidebar.tsx:421`), as a new strip directly
above the existing icon row (refresh / cleanup / activity / settings).
Same visual grouping — the user reads the bottom of the sidebar as
"workspace-level chrome," and the backends list belongs there.

Shape:

- **Horizontal chip strip.** Each backend = a chip with an avatar
  (initial or color block) plus a truncated label below or beside it,
  and a status dot in the corner.
- **Chips sized for the 2-backend baseline.** Common case is "here"
  and "there" — so chips are large enough to read the label at a
  glance without hover. ~44–48px avatars with the label visible by
  default (instead of avatar-only with hover tooltips). At the default
  224px sidebar width, two labeled chips fit comfortably side-by-side.
- **`+` button** sits at the end of the strip; opens the add-backend
  modal (section B).
- **Active chip** has visual emphasis (background tint or accent
  border).
- **Status dot** in the corner of the avatar — red for "needs-approval
  somewhere on this backend," amber for "something changed since you
  last visited" (per section E).

Auto-hide rule:

- 1 backend → strip not rendered. Single-backend users see today's
  chrome unchanged. The existing in-process Local backend is the
  implicit single backend for first-run users (per section H).
- 2+ backends → strip appears.

Density at higher N:

- At 4–5 backends the strip stays a single row; chips compress to
  avatar-with-label-truncated.
- At 6+ backends, either wrap to a second row or fall back to
  avatar-only with the label in a hover tooltip. Implementation
  detail; works either way.

Sidebar hidden case:

- Toggling the sidebar off (`sidebarVisible=false`) hides the chip
  strip too. Acceptable for v1 — when the user is heads-down in a
  terminal with the sidebar dismissed, the active backend is implicit.
  Reopening the sidebar restores the strip. (If this turns out to be a
  problem, a tiny floating "active backend" chip in the chrome is the
  follow-up.)

Why not the Slack-style left rail: it costs 56–64px of horizontal
real estate forever, and the common case is 2 backends — that's a lot
of empty rail. The bottom-of-sidebar chip strip is invisible at 1
backend, modest at 2, and degrades gracefully as N grows.

Why not a header dropdown: discovery is weaker, and a popover is one
extra click for what's literally the most-frequent action when you
work across two machines.

**Decision:** ✅ chip strip above the bottom icon row, ~44–48px
avatars with labels, auto-hidden at 1 backend.

---

## B. How does adding a backend work? 🟢 Decided — paste the link Settings already displays

The user pastes whatever link they see in the host machine's Settings
panel. Today that's an `http://host:port/?token=...` URL
(`Settings.tsx:593`) — the same one used to open the web client in a
browser, since the HTTP web-client server and the WS transport share
a port. No need for the user to know whether to type `ws://` vs
`http://` — they paste the exact string they're given.

Accepted forms (parser is permissive):

- `http://host:port/?token=...` — current Settings format. Most common.
- `https://host:port/?token=...` — once TLS lands.
- `ws://...` / `wss://...` — also accepted for the user who knows
  what they're doing.

The renderer normalizes any of those to the right WS endpoint
internally (`http`→`ws`, `https`→`wss`, ws/wss pass through). Token
is parsed out of the query string and stored separately via
`secrets.ts` keyed by backend id; the persisted `BackendConfig.url`
holds only the schemeless authority + path so reading it back doesn't
expose the secret.

UI shape:

- Modal with one big textarea (URL with token), optional label.
- "Test & save" button — hits the endpoint, validates the token,
  fetches a snapshot, and only persists on success. Failures surface
  inline with the specific reason ("invalid token", "couldn't reach
  host", "version mismatch — server is older than this client").
- Same modal pattern as the existing repo-picker / new-worktree
  modals.

Opened from:

- The `+` button on the chip strip (section A).
- A `File → Add Backend…` menu item (parallels `File → New Project…`).

Label is auto-suggested from the host (`build-box` for
`http://build-box.local:37291`) but editable.

**Decision:** ✅ paste-the-link modal, accepts http/https/ws/wss,
"Test & save" validates before persisting, token stored separately.

---

## C. Persistence 🟢 Decided — connections list owned by the renderer shell

The connections list is the **only** thing stored outside any
backend's store (per section G). It's owned by the Electron
renderer shell — not synced from any backend, not part of any
backend's `SettingsState`.

**Where it lives:** add `connections` + `activeBackendId` as
top-level fields in the existing `Config` interface in
`src/main/persistence.ts`. Same file that holds `repoRoots`,
`hotkeys`, etc. — `userData/config.json`. (A separate
`userData/connections.json` is also fine; it's a wash. Defaulting
to "extend the existing file" because there's no migration cost.)

In headless mode (`harness-server` running on its own), the
connections list doesn't exist — a server only represents itself.
Multi-backend is an Electron-renderer concept. Web client connecting
to a single server gets that one backend.

**Tokens:** keep encrypted in `secrets.enc` (the same file that holds
the GitHub PAT today via `setSecret/getSecret` in
`src/main/secrets.ts`). Use `backend-token:<backendId>` as the secret
key so each backend's token is independently retrievable.

**Schema (proposed):**

```ts
interface BackendConnection {
  id: string             // uuid v4
  label: string          // "Build box", "Local", user-editable
  url: string            // schemeless authority + path; e.g. "build-box.local:37291/"
                         // (token stripped on save; held in secrets.enc)
  kind: 'local' | 'remote'  // 'local' = the in-process backend, exactly one
  addedAt: number        // ms since epoch
  lastConnectedAt?: number
  // optional UI niceties:
  color?: string         // hex, used for the chip avatar background
  initials?: string      // override for chip avatar (default: first 2 chars of label)
}

// in Config:
connections?: BackendConnection[]
activeBackendId?: string  // last active, restored on next launch
```

`activeBackendId` is implicit/last-used — the user's last focused
backend persists across restart.

The local backend's `BackendConnection` is auto-seeded on first
launch with `kind: 'local'`, `url: ''`. The renderer recognizes
`kind:'local'` and routes through `ElectronClientTransport` instead
of WS.

Tokens stay in `secrets.enc` keyed `backend-token:<id>` via
`secrets.ts`. No tokens in `config.json`.

**Decision:** ✅ extend `config.json` with `connections[]` +
`activeBackendId`, tokens in `secrets.enc` keyed by backend id.

---

## D. Active-backend semantics + transitions 🟢 Decided — always connected

The hard question. Three shapes:

1. **Always connected (recommended for v1)** — every backend's WS
   stays open all the time. State events stream into N renderer-side
   mirrored stores; switching just changes which mirror feeds the
   visible UI hooks. Inactive backends keep accumulating state, so
   when you switch back the UI is instant and notifications work
   natively. Cost: N idle WS connections + state-event bandwidth (low
   — the cascade detector in `src/main/store.ts` already keeps event
   rates bounded).

2. **Disconnect on background, reconnect on switch** — saves a socket
   per backend but introduces a "loading…" flash on every switch and
   defeats notifications entirely. Only worth it if N gets large
   (>10) which Tier 1 doesn't realistically face.

3. **Connected but data-paused** — WS stays open, but the renderer
   tells the server "pause `terminal:data` for me on these terminals
   while I'm not looking." Optimization for high-output PTYs (think
   `npm run dev` blasting output for hours). Works in concept (the
   `terminal:data` channel is already separate from state events per
   the architecture notes) but adds protocol surface and isn't
   measurably needed for v1.

**PTY data on inactive backends:** with always-connected, bytes keep
flowing into xterm-headless instances on all backends — the existing
`WorkspaceView` pattern of rendering ALL worktrees with `display:none`
for inactive ones (see `App.tsx:1112-1164`) extends naturally to N
backends. Cost is bounded; xterm.js scrollback eviction handles the
tail.

**Json-mode tabs:** the `jsonClaude` slice stores chat history in
state; streaming continues regardless of active backend. Switching
back is instant.

**Approval cards on inactive backends:** they fire on the inactive
backend's mirror, the rail icon shows the red dot per section E, click
to switch and see the card.

**Decision:** ✅ always connected, all backends stream state
continuously. No per-backend pause for v1. Add #3 (data-pause for
noisy PTYs) later only if a real user hits a problem.

---

## E. Notification / unread surfacing 🟢 Decided — current-status dot only, no extras

Simplest thing that's still useful: each chip shows a status dot
derived from the existing per-backend worst-status aggregation
(`worktreeStatuses` in `App.tsx:577–595`, but one level higher —
worst status across all worktrees for that backend).

Visuals:
- **Red dot** = at least one worktree on the backend currently
  needs approval (`needs-approval`).
- **Amber dot** = at least one is `waiting` (Claude finished a turn).
- **No dot** = idle.

Stateless — the dot is a function of current state, not memory of
past events. Switch to a backend, resolve the approval, dot clears
because the condition no longer holds.

What's explicitly out of scope for v1:
- "Something changed since last visit" tracking (no
  `lastVisitedAt`, no per-backend unread state).
- Count badges (no "5 worktrees need approval" number).
- OS notification banners (no `Notification` API integration, no
  per-backend `notifyOnInactive` setting).

If a user later asks for any of these, they're additive and don't
require changing the v1 plumbing.

**Decision:** ✅ chip-level current-status dot only (red /
amber / none), derived from existing aggregation logic. No OS
notifications, no unread tracking, no per-backend settings.

---

## F. Keyboard shortcuts 🟢 Decided — `Cmd+Shift+1..9` for backend index

`Cmd+Shift+1`..`Cmd+Shift+9` jumps to backends 1–9 in order. Keeps
the existing `Cmd+1..9` worktree-index hotkeys untouched (no
migration cost, no collision).

Cycle: `` Cmd+` `` for next backend, `` Cmd+Shift+` `` for previous
(macOS-native window-cycling muscle memory). Subject to a final
collision check against `src/renderer/hotkeys.ts` during
implementation, but the Shift-modifier slot is generally clear.

Both registered as new `Action` entries in the `hotkeys` slice so
they show up in the cheatsheet and are user-rebindable.

**Decision:** ✅ `Cmd+Shift+1..9` for index, `` Cmd+` `` /
`` Cmd+Shift+` `` for cycle.

---

## G. Settings split 🟢 Decided — no global tier; settings stay per-backend (which matches today)

Earlier drafts proposed splitting `SettingsState` into "global" and
"per-backend" buckets. Rejected — it adds classification work, a new
picker on each Settings section, persistence ceremony, and a mental
model the user has to maintain. Cleaner to keep the shape that already
exists.

The decision:

- **`SettingsState` is unchanged.** Every field in
  `src/shared/state/settings.ts` stays exactly where it is. Each
  backend owns a full copy of the slice — same schema, same defaults,
  same reducer. From the backend's perspective, nothing about being
  multi-backend is visible: it's still a self-contained world.
- **`useSettings()` reads from the active backend's mirror.** When the
  user switches backends, the Settings panel reflects that backend's
  values. No picker at the top of sections, no "scope" indicator,
  nothing. The panel is what it always was — for the current backend.
- **The connections list lives outside any backend.** New persistence
  file or new top-level fields in the Electron renderer shell's
  `config.json` (e.g. `userData/connections.json`); tokens remain in
  `secrets.enc`. The headless `harness-server` doesn't know about it
  — multi-backend is an Electron-renderer concept; a server only ever
  represents itself.

What this means in practice:

- **Theme, hotkeys, fonts, editor preference all "switch with the
  backend."** When the user activates "build-box," they see whatever
  theme/font/editor they configured for build-box. This can mean a
  visible flicker when switching to a backend the user hasn't
  configured yet.
- **Mitigation: "Copy settings from \<backend\>"** in the add-backend
  modal. A checkbox or button that, on save, copies the active
  backend's full `SettingsState` into the new backend so it starts
  aligned. The user is free to diverge later. One-click symmetry,
  zero schema gymnastics.
- **GitHub PAT is naturally per-backend** (each backend's
  `secrets.enc` holds its own token, `gh auth token` resolution runs
  on the backend). Confirms the rest of the design.
- **`autoUpdateEnabled` is technically per-backend** in this model, but
  it only governs the *Electron app's* auto-updater (no remote
  backend updates your local binary). The local backend is the only
  one whose value matters; non-local backends' values are ignored.
  Cleaner than carving a special case in the slice.
- **`hooksConsent`** (in the `hooks` slice, not `settings`) gets the
  same treatment — per-backend, lives in each backend's store, no
  classification needed.

Already correctly per-session, no change:
- `sessionToolApprovals` (jsonClaude per-session)
- `permissionMode` (jsonClaude per-session)

What this saves vs. the bucketed approach:

- No new "Backend: \<local▾\>" picker on Settings sections.
- No per-field decision about which bucket it belongs in.
- No new event variants in the slice.
- No subset of settings that lives in a different file with different
  persistence rules.

**Decision:** ✅ no global tier. Settings slice unchanged, lives
per-backend. Connections list is the only thing stored outside the
backends, owned by the Electron renderer shell.
"Copy settings from \<backend\>" in the add-backend modal as the
divergence-mitigation affordance.

---

## H. Local backend 🟢 Decided — implicit, pinned, not removable

Local is the leftmost chip in the strip, always present, can't be
removed. Internally marked `kind:'local'` so the renderer routes
through `ElectronClientTransport` rather than WS.

Why this over first-class:
- No "wait, where's my local backend?" recovery path needed.
- No Settings entry for "add local back."
- No confirmation flow on remove.
- Local genuinely *is* the odd one out (it's in-process, not over a
  wire) — the chrome reflecting that is honest, not inconsistent.

Concrete v1 behavior:
- First launch: a single Local chip auto-seeded.
- Local label is fixed as "Local" in v1. Rename support can be added
  later if anyone wants it; not worth ceremony today.
- Local has a distinct visual marker (e.g. a small "house" /
  "computer" glyph instead of an initials avatar) so users can tell
  at a glance which chip is the in-process one.
- The implementation still uses the same `BackendConnection` shape in
  `config.json` for Local — `kind:'local'` is the only special case
  in the renderer transport routing. The "can't remove" rule is a UI
  guard, not a data-model carve-out.

**Decision:** ✅ Local is pinned, leftmost, implicit, not removable
in v1. Distinct visual marker. Same `BackendConnection` schema as
remotes; UI guards against removal.

---

## I. Connection status + error surfacing 🟢 Decided — two states (KISS)

Two states only:

- **Connected** → chip looks normal, status dot from section E.
- **Disconnected** → chip greyed out. Tooltip on hover surfaces the
  reason (e.g. "Reconnecting…", "Auth failed", "Host unreachable").

No transient/terminal distinction in v1. The existing
`WebSocketClientTransport` reconnect-with-backoff is what runs in the
background; the chip just reflects "are we currently connected or
not."

Click on a disconnected chip:
- Switches to it as if connected.
- Main panel shows a centered "Couldn't reach \<label\> — \<reason\>"
  with a "Retry" button and an "Edit connection" link that opens that
  backend's settings inline.

Empty state isn't really reachable in v1 — Local is pinned per
section H, so there's always at least one connected backend.

Implementation surface:
- One renderer-side field per backend mirror:
  `connectionStatus: 'connected' | 'disconnected'`.
- The chip strip reads that field plus the per-backend worst-status
  from E.

If a real user later asks for a more nuanced visual ("this one is
reconnecting vs. this one is permanently broken"), it's an additive
change — split the disconnected state into two and add a second
visual.

**Decision:** ✅ two states only (connected / disconnected). Tooltip
surfaces the reason. Click switches and shows a retry screen.

---

## J. Migration from `electron-remote-mode` 🟢 Decided — drop the env var entirely

The `HARNESS_REMOTE_URL` env-var path isn't really used in practice.
Tier 1 deletes it: the chip strip is the only way to reach a remote
backend from the Electron app.

What gets removed:
- The `HARNESS_REMOTE_URL` short-circuit at the top of
  `src/main/index.ts`.
- `src/main/desktop-shell-remote.ts` and its `bootRemote(url)`
  function.
- The preload's `findRemoteUrl(process.argv)` /
  `--harness-remote-url=` arg parsing in `src/preload/index.ts`.
- Any docs / scripts referencing the env var.

What replaces it functionally: add a remote connection to the chip
strip, switch to it. Same UX, persisted, less code.

If anyone later actually wants a "one-shot, don't persist" launcher
flag, it's an additive change — gate `connections[]` writes on a
`HARNESS_EPHEMERAL=1` env var or similar. No need to keep the
removed code around for that.

Default boot path on first launch of the Tier 1 build: load
`connections[]` from `config.json`; if empty (existing user, new
schema), auto-seed a single Local entry. Existing users see a single
Local chip which auto-hides per section A — net visible change:
zero.

**Decision:** ✅ remove `HARNESS_REMOTE_URL` and the entire
`bootRemote` code path. Chip strip is the only entry point for
remote backends. Auto-seed Local on first launch with empty
`connections[]`.

---

## K. Per-window vs per-app 🟢 Decided — single window

One window, one chip strip, one active backend at a time. No
`Window → New Window` menu item in v1.

`activeBackendId` lives in renderer-shell persistence as a single
value per app (per the C decision).

The store + slices already support N clients per the existing
architecture, so multi-window remains an additive change later if
real demand surfaces. Don't bake in single-window assumptions that
would block Tier 2's unified sidebar.

**Decision:** ✅ single window only.

---

## L. The "everything else" check 🟢 Decided — replace `__HARNESS_WEB__` with `kind === 'remote'` checks; no capability object, no version handshake

**Slice audit.** Every existing slice (`worktrees`, `terminals`,
`prs`, `repoConfigs`, `jsonClaude`, `costs`, `hooks`, `settings`)
becomes per-backend automatically because each backend has its own
store. `onboarding` and `updater` technically live in each backend
too, but only the local backend's value matters in practice (same
logic as `autoUpdateEnabled` in section G — non-local values are
ignored). No new design work for the slices.

**The real change — `__HARNESS_WEB__`.** The process-wide flag set
in the preload (`src/preload/index.ts`) breaks in multi-backend mode:
the same renderer is now talking to N backends, some local (have
native APIs), some remote (don't). When you switch from Local to a
remote, the renderer needs to switch from `dialog.showOpenDialog` to
`RemoteFilePicker`, and from native `WebContentsView` overlay to the
polled screenshot view.

Replace the flag with **per-call-site checks against the active
backend's `kind`**:

- `useActiveBackend().kind === 'remote' ? RemoteFilePicker : NativeFilePicker`
  at each existing branch.
- Same pattern for the browser overlay vs. polled screenshot.

`kind` is already in the data model from section C, so no new state
or schema. ~3–4 conditional branches across the renderer total. No
generalized "capabilities" object — if more call sites appear later
that need finer-grained capability info (e.g. "this remote backend
doesn't support browser tabs at all"), build the capabilities
framework then.

**Renderer-only stuff that doesn't change:**
- `localStorage` keys (`harness:sidebarWidth`, etc.) — per-window UI
  focus, stay as is.
- `crashedTabIds`, `prevStatusesRef`, `questVisitedRef` — per-renderer
  ephemeral state, stay as is.
- xterm.js font config — read from active backend's `settings.terminalFontFamily`
  per section G. If a user wants different fonts per backend, that
  falls out for free.

**Backend-version mismatch — explicitly out of scope for v1.** A
stale `harness-server` connected to a newer Electron app will produce
state-event shape mismatches at runtime, and the user will see broken
UI / errors. KISS: don't build a protocol-version handshake until a
real user hits this. The first symptom is loud enough that "rebuild
your server" is an acceptable answer.

**Decision:** ✅ replace `__HARNESS_WEB__` with
`useActiveBackend().kind === 'remote'` at the existing call sites
(file picker, browser overlay). No capabilities object. No protocol
version handshake in v1.

---

## Summary of recommendations (one-line each)

- **A.** ✅ Horizontal chip strip at the bottom of the sidebar,
  directly above the existing icon row; ~44–48px avatars with labels,
  status dot in the corner, `+` at the end, auto-hidden at 1 backend.
- **B.** ✅ Paste the exact link Settings displays (`http://...?token=...`),
  accepts http/https/ws/wss, optional label, "Test & save" validates
  before persisting; token stored separately in `secrets.enc`.
- **C.** ✅ Extend `config.json` with `connections[]` +
  `activeBackendId`; tokens in `secrets.enc` keyed `backend-token:<id>`.
  The connections list is renderer-shell-owned, not synced from any
  backend.
- **D.** ✅ Always connected — every backend's WS stays open,
  state streams continuously into N renderer-side mirrored stores.
  Switching = instant.
- **E.** ✅ Current-status dot on each chip (red = needs-approval,
  amber = waiting, none = idle), derived from existing per-backend
  worst-status aggregation. No OS notifications, no unread tracking
  in v1.
- **F.** ✅ `Cmd+Shift+1..9` for backend index, `` Cmd+` `` /
  `` Cmd+Shift+` `` to cycle next/prev. Worktree-index hotkeys
  (`Cmd+1..9`) stay as-is.
- **G.** ✅ No global tier. `SettingsState` slice unchanged, lives
  per-backend. Active backend's settings are what the panel shows.
  Connections list is the only thing stored outside any backend
  (owned by the Electron renderer shell). "Copy settings from
  \<backend\>" in the add-backend modal mitigates first-time divergence.
- **H.** ✅ Local is pinned, leftmost, implicit, not removable.
  Distinct visual marker (house/computer glyph). Same
  `BackendConnection` schema; UI guards prevent removal.
- **I.** ✅ Two states only — connected or disconnected (greyed
  chip, tooltip with reason). Click switches and shows a retry
  screen with "Edit connection" link. No transient/terminal
  distinction in v1.
- **J.** ✅ Remove `HARNESS_REMOTE_URL` and the `bootRemote` code
  path entirely. Chip strip is the only entry point for remote
  backends. Auto-seed Local on first launch with empty `connections[]`.
- **K.** ✅ Single window only. Multi-window deferred (and probably
  obsoleted by Tier 2 anyway).
- **L.** ✅ All slices per-backend by virtue of the per-backend
  store. Replace `__HARNESS_WEB__` with `kind === 'remote'` checks at
  the existing call sites. No capabilities object, no protocol-version
  handshake in v1.

## Implementation skeleton (out-of-scope for this branch but worth flagging)

What the implementation worktree will need to touch — listed so the
design questions above stay grounded in real surface area:

- **Renderer:** `src/renderer/store.ts` becomes "N mirrored stores
  keyed by backend id." `useWorktrees()` etc. read from the active
  backend's mirror via context.
- **Preload:** `window.api` becomes a router. Each method either
  routes to the active backend's transport, or accepts an explicit
  backend-id arg (rare — only for cross-backend operations, which are
  Tier 2). The preload owns the map of `backendId → transport`.
- **Main:** `src/main/index.ts` continues to host the in-process
  store/FSMs/PTY for the local backend. New: a `BackendsRegistry` in
  the renderer (not main — main only knows about itself) that holds
  `{ backendId → { transport, mirroredStore, snapshot } }`.
- **Persistence:** new fields in `Config`, new secret keys in
  `secrets.enc`, no migration scripts needed (auto-seed handles it).
- **Settings UI:** add the backend picker to the Settings panel,
  refactor each section's read/write to operate on the picked backend
  for per-backend fields.
- **Sidebar:** add the rail component, gate visibility on
  `backends.length > 1`, wire reading from `BackendsRegistry`.
- **Hotkeys:** add backend-switch actions to `hotkeys.ts`.
- **Protocol:** version handshake on connect; reject mismatched server
  versions with a clear error.

None of this is committed yet — implementation lives in a separate
worktree once this doc reaches a 🟢 majority.
