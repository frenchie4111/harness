# Remote main — running Harness's backend off-machine

This is the forward-looking plan for letting `main` run on a remote
host (or just headlessly on the same machine) while the user drives it
from a local Electron window or a browser. The architecture itself is
documented in [CLAUDE.md](../CLAUDE.md); the WS transport that makes
this possible is documented in commits `f18f337` (transport) and
`da87ee9` (web client). This doc is the **why**, the **what's already
landed**, and the **what's next**.

## Why we want this

The 2.0 state migration (see [2.0-state-migration.md](./2.0-state-migration.md))
moved all shared world state into the main process and added a
transport abstraction so renderers talk to the store over a swappable
pipe. The web-client + WS transport then proved a network client can
drive the existing main process unchanged.

The natural next step: let `main` itself run somewhere other than
inside the user's local Electron app.

Three concrete shapes for this:

1. **Headless self-hosted** — user runs `node dist-headless/main/index.js`
   on their own machine (or a home server), points a browser at it.
   No Electron, no window. Works today.
2. **Remote-SSH (à la VS Code)** — user opens local Electron Harness,
   picks "Connect to remote host", Harness SSHes in, installs the
   server, port-forwards the WS, the local renderer drives the remote
   backend. Doesn't work yet.
3. **Hosted multi-tenant** — Harness-the-service. Out of scope for
   this plan; sketched at the end as a constraint to keep the design
   honest.

The first two share the same load-bearing plumbing: a self-contained
main process that boots without Electron and a renderer that can
target an arbitrary WS endpoint.

## What's landed in the headless-main slice (PR #18)

The first slice toward all three shapes. Concretely:

### Runtime mode detection

`src/main/paths.ts` is the seam. `process.versions.electron` decides
which path to take — there's no env-var override or config file to
fight with. Electron mode delegates to `app.getPath('userData')`
(dynamically `require`'d to keep the static import out of headless
bundles); headless mode reads `$HARNESS_DATA_DIR` (default `~/.harness`)
and creates the dir 0700.

Five files that previously imported `electron` directly (`persistence`,
`activity`, `mcp-config`, `debug`, `secrets`) now go through this
shim. Net effect: those modules compile and run identically in either
mode.

### Pluggable secrets backend

`src/main/secrets.ts` exposes the same external API (`setSecret`,
`getSecret`, `hasSecret`, `deleteSecret`) but picks a backend at first
call:

- **Electron** → `safeStorage`. Existing `secrets.enc` files decrypt
  unchanged on upgrade (deliberate — we don't want users to lose
  their GitHub PAT just because the secrets layer got refactored).
- **Headless + keytar available** → keytar (OS keychain). Loaded via
  dynamic require so a missing native binding falls through.
- **Headless + no keytar** → AES-256-GCM with a random key file at
  `<userData>/.secret-key` (mode 0600). Documented as dev/self-hosted
  only — anyone with shell access can read both files. Not safe for
  hosted multi-tenant; see "what's still missing" below.

### Desktop shell extraction

`src/main/desktop-shell.ts` is the home for everything Electron-only:
`BrowserWindow`, `dialog`, `Menu`, `screen`, `shell`, `electron-updater`,
the `WebContentsView`-backed `BrowserManager`, the `app.whenReady`
boot, the dev-mode userData override, and the IPC handlers that touch
any of those (`repo:add`, `dialog:pickDirectory`, `updater:*`,
`shell:openExternal`, `browser:setBounds`).

`index.ts` loads it via `(0, eval)('require')('./desktop-shell')` under
`if (runtime === 'electron')`. The eval-trick require hides the
lookup from the bundler so the headless build doesn't pull electron
in via static analysis. Both files end up in `out/main/` next to each
other in the Electron build (added as a second input in
`electron.vite.config.ts`).

The split with index.ts is now:

- **`index.ts`** — mode-agnostic boot. Store, FSMs, PTY, WS server,
  control server, hook installer, the bulk of the IPC handler
  registrations. Knows nothing about Electron.
- **`desktop-shell.ts`** — the desktop window + menu, the
  `BrowserManager` (WebContentsView), the auto-updater, and the small
  set of IPC handlers that are inherently desktop-bound.

A small `desktopHooks` object in `index.ts` holds `start/stop`
auto-update callbacks that the shell populates after boot, so the
mode-agnostic `config:setAutoUpdateEnabled` handler still toggles
polling without import-time coupling.

### HeadlessBrowserManager stub

`src/main/headless-browser-manager.ts` satisfies a shared
`BrowserManagerLike` interface (defined in `browser-manager-types.ts`)
that both the real and stub implementations conform to. Every method
warns once + returns "no tabs / no URL / null". MCP browser tools and
the control server's browser endpoints degrade cleanly instead of
crashing. The seam comment at the top of the file marks where the
future real headless implementation will plug in.

### Headless build pipeline

`vite.headless.config.ts` bundles `src/main/index.ts` to
`dist-headless/main/index.js` as plain Node CJS. Externalizes
`electron`, `electron-updater`, `node-pty`, `./desktop-shell`,
`keytar`. `vite.headless-web.config.ts` bundles the web client to
`dist-headless/web-client/`.

Two npm scripts: `build:headless` (both bundles) and `dev:headless`
(builds + runs with `HARNESS_DATA_DIR=./.headless-data` so it doesn't
fight with a regular Harness install).

### Verified

- `npm run typecheck` clean.
- All 318 vitest tests pass.
- Electron build still emits both `out/main/index.js` and
  `out/main/desktop-shell.js`.
- Headless bundle has zero static `from 'electron'` imports (verified
  via grep).
- `node dist-headless/main/index.js` boots, prints WS + web-client
  URLs, no errors.
- Opened the printed URL in a browser — full Harness onboarding UI
  rendered, theme picker live, zero console errors.

## What's not done yet

These are the gaps that prevent the three shapes above from working
end to end. Listed in the order the next worktrees should pick them
up — see "sequence" at the bottom.

### 1. In-browser folder picker (blocks headless being usable)

Currently `addRepo` and `pickDirectory` in `src/web-client/main.tsx`
are stubbed as `unavailable`. The headless web UI loads, you can pick
a theme, but you cannot open a repo — the Open Repository button
calls `addRepo` which the web-client stubs out. Headless mode is
**unusable** without this.

The user explicitly flagged this as the most urgent next step:
"there's no way to file browse so I can't open a repo from this UI."

Shape of the fix:

- A `fs:listDirectory` request handler in main that returns
  `[{ name, isDirectory, isGitRepo? }]` for a given absolute path,
  with path-traversal guards (no `..` escape, no symlink-following
  across configured roots).
- A directory-tree component in the renderer that hits that handler
  and lets the user navigate to a folder.
- Wire it to every existing `pickDirectory` call site: Open
  Repository, worktree base path picker (Settings), new-project
  parent-dir picker.
- The Electron path keeps `dialog.showOpenDialog`; the new picker
  is the headless fallback (or a unified replacement — TBD).

Self-contained worktree. Does not block any of the remote-SSH work
below; can ship in parallel.

### 2. Prebuilt `node-pty` matrix

`node-pty` is a native module compiled per platform/arch/Node-ABI.
Today `npm install` runs `electron-builder install-app-deps` in
`postinstall`, which rebuilds it against the installed Electron's V8.
Running the headless bundle on a system Node ABI **fails** unless you
manually `npm rebuild node-pty` first.

For remote-SSH this gets worse: the remote box has its own platform/
arch/Node version. We can't just scp our local `node_modules`.

Two options:

- **Bundle prebuilds** — ship per-platform tarballs (`linux-x64`,
  `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`) as part
  of the GitHub Release. The bootstrap script picks the right one.
- **Rebuild on the remote** — needs Node + a C++ toolchain. Fragile
  on minimal Linux images, blocked on read-only filesystems.

Recommend the prebuild route; rebuild as a fallback.

### 3. "Connect to remote" UI in the Electron app

The Electron renderer currently uses `ElectronClientTransport` (IPC).
The web-client uses `WebSocketClientTransport`. To make the local
Electron app drive a remote backend, the Electron renderer needs to
be able to switch its transport at runtime — IPC for "this machine"
or WS pointing at a remote URL.

Shape:

- A "Connect to remote host…" entry somewhere obvious (likely the
  workspace switcher / sidebar header, since "remote workspace" is
  conceptually a sibling of "local workspace").
- Connection metadata stored in the user's local config: `[{ name,
  host, port, token, lastConnected }]`. Tokens encrypted via the
  existing secrets backend.
- A transport switcher in `src/renderer/store.ts` — today it's
  hardcoded to the IPC client; needs to accept a chosen target.
- UI for "connecting…" / "disconnected" / "reconnecting" states.
  The web-client already handles snapshot-resync on reconnect; reuse
  that logic.

This is the biggest UX lift in the remote-SSH story. The plumbing
underneath (WS transport, snapshot-resync) is done.

### 4. Bootstrap script (the "remote-ssh" magic)

What VS Code's Remote-SSH does and we don't:

1. SSH in (user already has the keys).
2. Detect the remote's platform + arch (`uname -ms` or similar).
3. `curl` the matching Harness server tarball from a known URL
   (extending the existing GitHub Release artifacts).
4. Extract to `~/.harness-server/<version>/` on the remote.
5. Start it (probably via `nohup` + a PID file, or `systemd --user`
   if available).
6. SSH-tunnel the WS port back to the local machine.
7. Hand the local Electron app the tunnel endpoint to connect to.

A "lifecycle manager" sub-piece: detect when the remote server is
out of date relative to the local app, prompt to upgrade, restart
cleanly.

This is its own worktree, fairly self-contained once #2 (prebuilds)
is in.

### 5. Headless browser tabs (out of scope, deferred)

`HeadlessBrowserManager` is a stub. Real implementation backs onto
Playwright or chrome-devtools-protocol. The `BrowserManagerLike`
contract is already defined; the new class drops in.

User explicitly classified this as a feature, not core: "browser
tabs is sort of a stretch goal — we can do it later since it's a
feature not a core." It works fine in Electron; missing in headless
is a feature gap, not a blocker. Ship after the remote-SSH story is
complete.

## Sequence

1. **Folder picker** — without it headless mode is unusable. Self-
   contained, doesn't block anything else.
2. **Prebuilt `node-pty` matrix** — required before remote-SSH can
   work end to end on hosts that aren't bit-for-bit identical to the
   developer's machine.
3. **"Connect to remote" UI in the Electron app** — the bigger UX
   piece. Can start in parallel with #2 since it's mostly renderer-
   side; the runtime-loadable transport already exists.
4. **Bootstrap script** — ties #2 and #3 together into the actual
   "click here, work on a remote box" flow.
5. **Headless browser tabs (Playwright/CDP)** — feature gap, not
   structural. After everything above.

## What "hosted multi-tenant" would need (not in scope)

Sketched here only to keep the design honest, so we don't paint
ourselves into a corner that makes it impossible later.

- **Per-tenant secret storage.** The current LocalEncryptedFile
  backend in headless mode is single-user; the key file sits next to
  the encrypted blob. Multi-tenant needs a real KMS (AWS KMS, GCP
  KMS, HashiCorp Vault, or per-tenant OS users with separate keychains).
- **Auth.** Today: a 32-byte random token in a `<meta>` tag. Adequate
  for SSH-tunneled or loopback use; nowhere near enough for a hosted
  service. Need OAuth or session-cookie auth, plus account/billing.
- **TLS.** None today. Hosted needs HTTPS at the edge (nginx/Caddy
  in front, or native TLS in the Node WS server).
- **Process isolation per tenant.** One main process per tenant, or
  hard sandboxing of git/PTY operations. The current single-process
  shape does not support multi-tenant on its own.
- **Resource quotas.** PTYs are unbounded today. A hosted service
  needs per-tenant CPU/memory/PTY-count caps.
- **Repo storage location.** Right now repos live wherever the user
  has them on disk. Hosted needs a per-tenant filesystem with quotas
  and backup.

None of this is in the path of the remote-SSH work above; just
worth not designing things in ways that make these later additions
require another rewrite. The single big constraint to keep in mind:
**don't bake "one user per main process" assumptions into anything
new.** The store, FSMs, and transports are already structured this
way; keep them that way.
