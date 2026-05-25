# Replacing global hooks with a Harness plugin — investigation

Issue #44. Today Harness installs status hooks by writing entries into
`~/.claude/settings.json` and `~/.codex/hooks.json` (see
`src/main/agents/claude.ts:85-101` and `src/main/agents/codex.ts:101-120`).
This polluted-global-config approach is the root of #43 (dedup edge
cases across multiple Harness installs / shared dotfiles) and adds
boot-time migration code that has accreted scar tissue
(`src/main/index.ts:2948-3010`).

The proposal: ship Harness-owned plugins to both agents and load them
per-spawn via a CLI flag, so the agent's user-scope config stays clean.
This doc captures whether that's actually viable per the upstream specs.

## TL;DR

**Claude Code: viable today.** `claude --plugin-dir <path>` is a
documented, GA flag that loads a plugin "for this session only"
(<https://code.claude.com/docs/en/cli-reference#--plugin-dir>). The
plugin's `hooks/hooks.json` supports every event we currently install
(`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `Notification`)
and our `$HARNESS_TERMINAL_ID`-gated bash one-liner ports verbatim
because we control the spawn env. The status-detection contract
(`/tmp/harness-status/<id>.ndjson` + `fs.watch`) is unaffected.

**Codex: not viable yet.** Codex has a plugin model
(<https://developers.openai.com/codex/plugins/build>) but no CLI flag
to load one per-invocation — plugins must be registered in
`~/.codex/config.toml`, so we'd swap one global mutation for another
without a net reduction in pollution. `--ignore-user-config` exists
but is `codex exec` only, not interactive.

**System prompt: stays as `--append-system-prompt`.** Plugins
contribute prompt content via skills, which are name-dispatched
(`/<skill>`), not always-on. The plugin reference is explicit: "A
`CLAUDE.md` file at the plugin root is not loaded as project context."
The closest alternative, `--append-system-prompt-file`, doesn't
reduce flag count.

**Recommended path: Claude-only plugin migration now, Codex stays
on the current install path.** The dual-agent symmetry regresses
slightly (Claude is cleaner, Codex unchanged) but Codex's behavior is
no worse than today. Re-evaluate Codex when upstream adds a
`--plugin-dir` equivalent.

## Claude Code plugin support

Source: <https://code.claude.com/docs/en/plugins-reference> and the
`--plugin-dir` entry in
<https://code.claude.com/docs/en/cli-reference>.

### Directory layout

Plugin root is a directory (or a `.zip`); the manifest is at
`.claude-plugin/plugin.json`, components at the root. From the
reference:

> The `.claude-plugin/` directory contains the `plugin.json` file. All
> other directories (commands/, agents/, skills/, output-styles/,
> themes/, monitors/, hooks/) must be at the plugin root, not inside
> `.claude-plugin/`.

Default file locations:

| Component | Default location |
|---|---|
| Manifest | `.claude-plugin/plugin.json` |
| Hooks | `hooks/hooks.json` |
| MCP servers | `.mcp.json` |
| Bin (added to Bash tool PATH) | `bin/` |

The manifest is optional — without one, Claude derives the plugin
name from the directory and auto-discovers components in default
locations. For our use case (Harness-owned, no marketplace
distribution, single hooks file), a minimal
`.claude-plugin/plugin.json` with just `name: "harness"` is
sufficient.

### Hook surface

Plugin hooks fire on the same events as user-scope hooks. The
reference enumerates them
(<https://code.claude.com/docs/en/plugins-reference#hooks>); every
event Harness currently installs (`src/main/agents/claude.ts:17-23`)
appears in the table:

- `UserPromptSubmit` — "When you submit a prompt, before Claude processes it"
- `PreToolUse` — "Before a tool call executes. Can block it"
- `PostToolUse` — "After a tool call succeeds"
- `Stop` — "When Claude finishes responding"
- `Notification` — "When Claude Code sends a notification"

Plus events we don't currently install but might want
(`SessionStart`, `SubagentStop`, `PostToolUseFailure`,
`InstructionsLoaded`, `PreCompact`/`PostCompact`).

Hook entry format is identical to today's:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "..." }
        ]
      }
    ]
  }
}
```

That's the same `{type, command, timeout}` shape we already produce in
`makeHarnessHookEntry()` (`src/main/agents/claude.ts:57-61`).

### Activation model

> Plugins are specified in one of two ways:
>
> - Through `claude --plugin-dir` or `claude --plugin-url`, for the
>   duration of a session.
> - Through a marketplace, installed for future sessions.

The `--plugin-dir` flag:

> Load a plugin from a directory or `.zip` archive for this session
> only. Each flag takes one path. Repeat the flag for multiple
> plugins: `--plugin-dir A --plugin-dir B.zip`

That's the unambiguous answer to "do we need to combine everything
into one dir" — repeatable flag, multiple plugins fine.

`--bare` mode "skip[s] auto-discovery of hooks, skills, plugins, MCP
servers". We need to make sure we don't pass `--bare` (we don't
today) and we don't need to do anything special to opt-in beyond
passing `--plugin-dir`.

### System prompt inclusion

A plugin **cannot** contribute always-on system-prompt text. The
reference says:

> A `CLAUDE.md` file at the plugin root is not loaded as project
> context. Plugins contribute context through skills, agents, and
> hooks rather than CLAUDE.md. To ship instructions that load into
> Claude's context, put them in a skill.

Skills are surfaced as `/<name>` shortcuts — they only get pulled in
when invoked. That doesn't replace `--append-system-prompt`, which
unconditionally adds text to every turn.

`--append-system-prompt-file ./path.txt` exists as an alternative to
inline text
(<https://code.claude.com/docs/en/cli-reference#--append-system-prompt-file>),
but it just relocates the prompt — we'd still pass a CLI flag every
spawn. No net win.

Verdict: keep `--append-system-prompt` in `json-claude-manager.ts:454`
and `src/main/agents/claude.ts:174` as-is.

### Versioning / compatibility

The reference doesn't pin a minimum version for `--plugin-dir` itself
(it pins later features: `displayName` at v2.1.143, plugin monitors
at v2.1.105, plugin prune at v2.1.121). The flag has been in the CLI
reference long enough that any reasonably current Claude Code has it.
Bundled `@anthropic-ai/claude-code` is pinned in `package.json`
(2.1.126 per the json-mode plan doc), so we control the floor for
json-mode tabs. xterm tabs use the user's PATH `claude`, which is the
existing exposure model — same risk surface as `--permission-prompt-tool`.

Action item: smoke-test that `--plugin-dir` exists on the pinned
2.1.126 binary before relying on it (one-line check: `claude
--help | grep plugin-dir`).

### Multiple plugins / extending

`--plugin-dir` is repeatable. If users have already installed their
own plugins via `claude plugin install <name>` (which writes to
`~/.claude/settings.json` `enabledPlugins`), those continue to load
in parallel with our `--plugin-dir`-loaded plugin. There's no
isolation flag like `--only-this-plugin`.

### Resume behavior

`--plugin-dir` is per-session (per-invocation, really). On every
spawn — fresh, `--resume`, `--continue` — we pass `--plugin-dir`
again. Harness already controls the spawn for all three paths
(`src/main/agents/claude.ts:170-193`), so this is fine.

## Codex plugin / hooks support

Sources:
- <https://developers.openai.com/codex/hooks>
- <https://developers.openai.com/codex/plugins/build>
- <https://developers.openai.com/codex/cli/reference>

### Hooks system

Hooks live in any of:

- `~/.codex/hooks.json`
- `~/.codex/config.toml` (inline `[hooks]` table)
- `<repo>/.codex/hooks.json`
- `<repo>/.codex/config.toml`

Format is the same shape as Claude's
(`{matcher, hooks: [{type, command, timeout, statusMessage?}]}`),
which matches what `src/main/agents/codex.ts:28-34` already produces.

Events supported: `SessionStart`, `SubagentStart`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`UserPromptSubmit`, `SubagentStop`, `Stop`. We install
`SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
`Stop` (`src/main/agents/codex.ts:20-26`) — full overlap.

Enable flag: `[features] hooks = true` in `~/.codex/config.toml`
(deprecated alias `codex_hooks = true` still works; we use the alias
at `src/main/agents/codex.ts:81`). This is one of the things current
Harness writes to global config.

Per-project hooks load "only when the project `.codex/` layer is
trusted" — Harness used to install per-worktree and migrated away
from it (`src/main/index.ts:2993-3007`), so going back to per-worktree
would regress.

### Plugin system

Codex has plugins. From the build-plugins page:

```
my-plugin/
├── .codex-plugin/
│   └── plugin.json (Required: plugin manifest)
├── skills/
├── hooks/
│   └── hooks.json
├── .app.json
├── .mcp.json
└── assets/
```

Manifest is at `.codex-plugin/plugin.json`. Plugin hooks default to
`hooks/hooks.json` inside the plugin root, override via a `hooks`
entry in the manifest. Same `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}`
substitution as Claude (the Claude env vars are documented as
compatibility aliases).

### The blocker: no `--plugin-dir` flag

The Codex CLI reference
(<https://developers.openai.com/codex/cli/reference>) does not list a
`--plugin-dir` equivalent. Plugins enable via:

- `codex plugin marketplace add <source>` to register a source
- Entries in `~/.codex/config.toml` under the plugin section
- `enabled = false` in the same TOML to turn off

The only thing close to per-invocation isolation:

- `--config, -c key=value` — overrides individual config keys, not a
  whole TOML; can't point at a separate plugin set
- `--profile, -p <name>` — loads a named profile from
  `~/.codex/config.toml`; the profile itself still lives in the
  user's TOML
- `--ignore-user-config` — "Do not load `$CODEX_HOME/config.toml`"
  but **only available for `codex exec`**, not the interactive
  command Harness spawns

So the cleanest Codex equivalent would be:

1. Write a single plugin entry into `~/.codex/config.toml` pointing
   at our bundled plugin directory
2. Stop touching `~/.codex/hooks.json` entirely

That's still writing to the user's TOML, but the surface area
shrinks from "a hooks block per event" to "a single plugin entry."
It's an improvement but not the clean break the Claude path gives us.
The dedup-by-signature logic at `src/main/agents/codex.ts:65-73` would
still be needed (for cleaning up legacy hooks, not for the new plugin
entry).

### Codex CLI / `$CODEX_HOME` workaround (rejected)

`$CODEX_HOME` defaults to `~/.codex` and can be redirected. We could
set `CODEX_HOME=<harness-temp>/codex` per spawn and put our plugin
config there. This is rejected because:

- The user's auth tokens live in `~/.codex/auth.json` (or similar);
  redirecting `CODEX_HOME` strands every Codex session as logged-out
- We'd need to copy auth state into the temp dir, which is brittle
  and adds another moving piece

The Claude analog (`CLAUDE_CONFIG_DIR` redirection in
`json-claude-manager.ts`) only works because that path is
*intentionally* isolating json-mode memory from the user's project
dir — auth isn't in `CLAUDE_CONFIG_DIR`. Codex doesn't have that
split.

## Today's hook surface

What we install per agent (read from `src/main/agents/claude.ts:17-23`
and `src/main/agents/codex.ts:20-26`):

**Claude** — into `~/.claude/settings.json`:
- `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`

**Codex** — into `~/.codex/hooks.json` (plus
`codex_hooks = true` in `~/.codex/config.toml`):
- `SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`

Each entry is a single command of the shape produced by
`makeHookCommand()` in `src/main/hooks.ts:42-50`:

```bash
bash -c 'h="$HARNESS_TERMINAL_ID"; [ -z "$h" ] && h="$CLAUDE_HARNESS_ID"; [ -z "$h" ] && exit 0; \
  d=/tmp/harness-status; mkdir -p "$d"; \
  p=$(cat); [ -z "$p" ] && p=null; \
  printf "{\"event\":\"<EVENT>\",\"ts\":%s,\"payload\":%s}\n" "$(date +%s)" "$p" >> "$d/$h.ndjson"'
```

Three load-bearing details:

1. **Gated on `$HARNESS_TERMINAL_ID` / `$CLAUDE_HARNESS_ID`**. Set by
   `PtyManager` when it spawns terminals on our behalf. Sessions
   spawned outside Harness (plain `claude` in a terminal, CI, etc.)
   hit `exit 0` and do nothing. This inert-by-default behavior is
   what makes a user-scope install safe today.
2. **POSIX bash one-liner — no jq, no python**. Reads stdin into a
   shell var, defaults empty to `null`, single `printf` writes one
   line to an append-mode file. Single `write(2)` under PIPE_BUF
   (4096B) is atomic vs. other O_APPEND writers on POSIX.
3. **Status path baked in as the dedup signature**. The string
   `/tmp/harness-status` is both the output dir AND the marker we
   use to recognize Harness-installed entries
   (`src/main/agents/claude.ts:12-13`, `:63-67`).

The renderer-side consumption is in `src/main/hooks.ts:155-223`:
`watchStatusDir()` watches `/tmp/harness-status` via `fs.watch`,
tails each `<terminalId>.ndjson` via `openSync`/`readSync` from a
stored byte offset, parses NDJSON lines, derives the appropriate
`PtyStatus`, and dispatches `terminals/statusChanged` events through
the store.

Stop events additionally fan out to `onStopEvent()` listeners
(`src/main/hooks.ts:118-153`) — `CostTracker` consumes those to
re-tail session transcripts. Anything that subscribes to
`onStopEvent` keeps working regardless of where the hook gets
installed, as long as the hook payload still carries `session_id`
and `transcript_path`.

## Status-detection contract under the plugin model

Three things have to keep working:

1. **`$HARNESS_TERMINAL_ID` reaches the hook subprocess.** Harness
   spawns the agent via `PtyManager` and sets this env var on the
   child. Plugin hooks run as child processes of the agent and
   inherit its env. Verified by the plugin reference:
   `${CLAUDE_PLUGIN_ROOT}` and friends are "exported as environment
   variables to hook processes" — implies other env passes through
   normally. Same way today's user-scope hooks see the var.

2. **The hook can write to `/tmp/harness-status/`.** This is just
   filesystem access from a child process; nothing about the plugin
   sandbox model restricts it. (There's no plugin sandbox — hooks
   run unsandboxed, same as user-scope: "Plugin monitors […] run
   unsandboxed at the same trust level as hooks.")

3. **The hook command resolves.** Today's command is `bash -c '...'`
   inlined into the JSON. Plugin hooks support the same `type:
   "command"` shape with the same string field. Could also move the
   one-liner into a `bin/harness-status.sh` script inside the plugin
   and invoke `"${CLAUDE_PLUGIN_ROOT}/bin/harness-status.sh
   <EVENT>"`, which is cleaner but not required.

Net: status detection is preserved by a faithful port. The hook
events still write to `/tmp/harness-status/<id>.ndjson`, the
`fs.watch` loop is unchanged, and nothing about
`onStopEvent`/`StopEvent` plumbing has to move.

One nuance: the bundled `@anthropic-ai/claude-code` binary used by
json-mode tabs (`json-claude-manager.ts:427-474`) already has memory
isolation that gates it out of user-scope hooks
(`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` + `CLAUDE_CONFIG_DIR`
redirection). If we ship the plugin, json-mode tabs will start
firing the plugin hooks too — but json-mode tracks status via the
stream-json protocol, not via the NDJSON tail, and the hook's
`$HARNESS_TERMINAL_ID` gate (which checks both `$HARNESS_TERMINAL_ID`
and `$CLAUDE_HARNESS_ID`, and falls back to `exit 0`) makes the hook
a no-op for json-mode tabs unless we explicitly pass the env. So
this is a non-issue, but worth being deliberate about: don't pass
`HARNESS_TERMINAL_ID` to json-mode spawns if we want them to stay
quiet (today's behavior — `json-claude-manager.ts:410-411` sets it
only on the `harness-control` MCP env, not on the parent process).

## System prompt bundling

Today: `src/main/agents/claude.ts:174` and
`src/main/json-claude-manager.ts:453-454` pass `--append-system-prompt
<text>` at spawn time. Text comes from `settings.systemPrompt`,
plumbed through `getLaunchSettings()`.

Options evaluated:

| Approach | Verdict |
|---|---|
| Drop prompt text into `<plugin>/CLAUDE.md` | Won't work. "A `CLAUDE.md` file at the plugin root is not loaded as project context." |
| Ship as a plugin skill | Wrong dispatch model. Skills are invoked via `/<name>` shortcuts, not always-on. |
| Plugin `agents/` | Only relevant when Claude dispatches to that sub-agent, same dispatch problem. |
| `--append-system-prompt-file <plugin>/system-prompt.txt` | Works, but we still pass a flag every spawn — no net win over inline text. |
| `--system-prompt-file` (replaces default prompt) | Replaces the default Claude system prompt entirely. Not what we want. |

Verdict: keep `--append-system-prompt` as-is. The plugin migration
is hook-scoped, not prompt-scoped.

## Migration for existing users

Two populations:

**Group A — never gave hook consent.** Nothing to migrate. New
behavior: pass `--plugin-dir` from boot onward.

**Group B — accepted hook install, has entries in
`~/.claude/settings.json` and `~/.codex/hooks.json` already.**

The current dedup logic (`src/main/agents/claude.ts:63-71` and
`src/main/agents/codex.ts:65-73`) recognizes Harness entries by the
`/tmp/harness-status` substring baked into the hook command. The
existing `uninstallHooks()` calls strip exactly those entries and
leave everything else intact, including user-authored hooks in
unrelated event blocks. That's a clean migration primitive.

Boot logic change:

1. On first boot after the upgrade, call
   `claudeAgent.uninstallHooks()` unconditionally (idempotent — no-op
   if nothing matches). Set a one-shot flag (`config.hooksMigratedToPlugin`).
2. From then on, pass `--plugin-dir <our-plugin>` on every Claude
   spawn (`src/main/agents/claude.ts:buildSpawnArgs`).
3. For Codex, leave the existing `~/.codex/hooks.json` path alone
   pending upstream `--plugin-dir` support, OR optionally consolidate
   to a single plugin entry in `config.toml` (smaller surface; still
   global). Decision deferred — see Recommended path.

Hook consent UX: the "give Harness permission to install hooks"
banner was justified by the global-config write. Once we move to
`--plugin-dir`, Claude tab consent is implicit (we always pass the
flag; the plugin only does anything in Harness-spawned subprocesses
because of the `$HARNESS_TERMINAL_ID` gate). The banner can either
disappear for Claude-only users or be reframed as "we're bundling
hooks into the agent subprocess" — needs a UX decision separate
from this investigation.

## Risks and unknowns

**1. `--plugin-dir` resolution from a packaged `.app`.** Plugin path
needs to be a real filesystem path. Resources outside asar live at
`process.resourcesPath` in packaged Electron, configured via
`extraResources` in `package.json:65-74` (today: `mcp-bridge.js`,
`permission-prompt-mcp.js`). Shipping a plugin folder via
`extraResources` puts it at e.g.
`/Applications/Harness.app/Contents/Resources/harness-claude-plugin/`
— a normal directory, readable by the spawned `claude`. Expected to
work but not verified end-to-end; **action item: bench-test before
shipping**. Don't put the plugin under `asarUnpack` for the main
asar — `extraResources` is the right primitive (no asar mount-point
weirdness, no read-only filesystem layers).

**2. Plugin version pinning.** Bundled
`@anthropic-ai/claude-code` is 2.1.126; `--plugin-dir` should be
present, but **action item: smoke-test on first PR** (`claude
--plugin-dir <empty-dir> --help`). User-PATH `claude` is the same
risk surface we already accept for `--permission-prompt-tool`.

**3. `--resume` / `--continue` plugin reload.** `--plugin-dir` is
documented as "for this session only" — implied per-invocation.
Harness controls the spawn for resume (`buildSpawnArgs` always runs)
so we just always pass `--plugin-dir`. **Action item: smoke-test
that resumed sessions actually see the plugin** (resume should be a
fresh subprocess, so plugin should activate normally, but worth
confirming).

**4. Auth / signing.** No documented signing requirement for
plugins loaded via `--plugin-dir` (signing matters for the
marketplace path). Local-dir plugins load directly from the path
we hand the CLI.

**5. Plugin cache and path-traversal.** From the reference:
"Installed plugins cannot reference files outside their directory."
Our hook command writes to `/tmp/harness-status/`, which is outside
the plugin dir, but the hook is a *runtime* shell command, not a
path-traversal at install/load time — the restriction is on plugin
file resolution, not on what hook scripts do. Same as today. (For
plugins installed via `--plugin-dir`, only symlinks resolving inside
the plugin's own directory are preserved; we shouldn't need
symlinks.)

**6. Codex feature gap.** The biggest unknown. If we ship Claude
plugin-ification now and Codex never adds `--plugin-dir`, we're
permanently asymmetric. Counter-argument: the Codex surface is no
worse than today — it stays at its current global-config-mutation
behavior — so we're not regressing anything, just leaving an unmet
opportunity. **Action item: file an upstream issue with the Codex
team requesting `--plugin-dir`-equivalent, or `--ignore-user-config`
on the interactive command. Link this doc.**

**7. xterm vs json-mode Claude.** json-mode tabs (the bundled
binary, `json-claude-manager.ts`) already skip user-scope hooks via
`CLAUDE_CONFIG_DIR` redirection. If we start passing `--plugin-dir`
from json-mode spawns too, the plugin hooks will fire — but they'll
no-op because `$HARNESS_TERMINAL_ID` isn't set on the parent
process for json-mode (it's only set on the harness-control MCP env,
which is a child of the parent, not the parent itself). Decision:
pass `--plugin-dir` from xterm spawns only; json-mode keeps its
current isolation. Trivial to implement — the call site is
different.

**8. User's own plugins.** Users may have installed plugins via
`claude plugin install`. Those are loaded from `~/.claude/settings.json`
`enabledPlugins` alongside our `--plugin-dir` plugin — no conflict.

## Recommended path

**Do it for Claude. Skip Codex for now. Don't touch system prompt.**

Concrete shape:

1. **Add the plugin source.** Create
   `resources/harness-claude-plugin/` with:
   - `.claude-plugin/plugin.json` — minimal manifest, just
     `{"name": "harness", "version": "1.0.0", "description":
     "Harness status hooks"}`.
   - `hooks/hooks.json` — the five existing hook entries
     (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
     `Notification`), reusing the exact `makeHookCommand()` output
     so the status-dir signature stays unchanged.
   - Optional: move the bash one-liner into
     `bin/harness-status.sh` and reduce `hooks.json` to per-event
     `${CLAUDE_PLUGIN_ROOT}/bin/harness-status.sh <EVENT>` calls. Cleaner,
     but breaks the dedup-by-signature trick the migration code
     relies on — keep inline at least through the migration window.

2. **Wire `extraResources`** in `package.json` to ship the plugin
   directory at `process.resourcesPath/harness-claude-plugin/`. Add
   a `pluginDirPath()` helper alongside `permissionPromptScriptPath()`
   in `src/main/paths.ts`.

3. **Plumb `--plugin-dir` into Claude spawn args.** Modify
   `src/main/agents/claude.ts:buildSpawnArgs` to prepend
   `--plugin-dir <plugin-path>` ahead of session-id / resume flags.
   Add a unit test confirming the flag lands.

4. **Stop writing global hooks for Claude.** Remove
   `installHooks()` / `uninstallHooks()` *invocations* for the Claude
   agent from `src/main/index.ts:installHooksGlobally`. Keep the
   functions themselves around for one release as cleanup helpers.

5. **Migration.** On boot, run `claudeAgent.uninstallHooks()` once
   if `config.hooksMigratedToPlugin !== true`, then set the flag.
   This strips legacy entries from `~/.claude/settings.json` cleanly
   by signature. The existing migration sweep at
   `src/main/index.ts:2997-3007` is the template.

6. **Hook consent UX.** Out of scope for the plugin migration —
   needs a separate decision. Minimum viable: leave the banner alone
   for now (Codex still wants consent for `~/.codex/hooks.json`
   writes; the banner stays useful). Long-term: split the consent
   per-agent or remove it if/when Codex moves to plugins too.

7. **Codex: no change.** Continue installing into
   `~/.codex/hooks.json`. Document the upstream gap in the issue
   tracker. When Codex ships `--plugin-dir` or extends
   `--ignore-user-config` to the interactive command, revisit.

8. **CI guard.** Add a smoke test that spawns the pinned bundled
   `claude` with `--plugin-dir <empty-dir>` and confirms it doesn't
   error. Pin a regression for the "did Claude rename the flag"
   case.

**What this buys us:**

- Issue #43 resolved by removing the surface (no more global hook
  entry dedup conflicts across multiple Harness installs)
- Clean uninstall: removing Harness leaves no trace in
  `~/.claude/settings.json` for any user upgraded past the migration
  point
- Boot logic shrinks — the legacy-hook-migration sweep in
  `index.ts:2948-3010` collapses to a single "strip legacy + set
  flag" call
- Future hook event additions (e.g. `SessionStart` for activity
  tracking) ship with the plugin file, no IPC + write-to-disk dance

**What this costs:**

- Dual-agent symmetry regresses (Claude clean, Codex unchanged)
  until upstream Codex catches up
- One additional `.app` packaging line (`extraResources`) and one
  additional spawn flag
- A boot-time smoke-test commit to lock in the `--plugin-dir`
  contract

**Rough implementation outline (one PR, maybe two):**

PR 1: ship the plugin file + extraResources + spawn-flag plumbing
+ migration sweep + CI smoke test. Don't change consent UX.

PR 2 (optional): consent-banner copy update for Claude-only users.

## Open ambiguities (capture for the next agent)

- **Confirm `--plugin-dir` exists on pinned 2.1.126.** One-shot CLI
  check; the documented flag has been around long enough that this
  should pass, but verify before relying on it.
- **Confirm packaged-app plugin path resolution.** A 5-minute
  smoke-test under `npm run pack`: drop a plugin in `extraResources`,
  spawn `claude --plugin-dir <process.resourcesPath>/...`, run an
  empty session, confirm the plugin loads (look for "loading
  plugin" in `claude --debug`).
- **Should we move the inline bash to `bin/harness-status.sh`?**
  Cleaner, but changes the dedup signature. Recommendation: keep
  inline through the migration window; revisit after `hooksMigratedToPlugin`
  is universally true.
- **Codex feature request.** Worth a one-line issue upstream so the
  ask is on record.
