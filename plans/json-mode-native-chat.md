# JSON-mode native chat — backlog

Phase 1 (MCP permission bridge) and Phase 2 (json-claude tab MVP) are
shipped in PR #21 and merged into this branch. This file is the live
backlog of what's left, organized so each item can be picked up in its
own worktree.

## What works today

### Subprocess / protocol
- `claude -p --input-format stream-json --output-format stream-json
  --include-partial-messages` per json-claude tab, behind
  `settings.jsonModeClaudeTabs` (toggleable from the Experimental
  Settings section).
- The json-mode subprocess is the bundled `@anthropic-ai/claude-code`
  native binary (pinned in `package.json`), spawned directly via
  `createRequire`-resolved path through the platform-specific
  `@anthropic-ai/claude-code-<platform>-<arch>` subpackage. xterm tabs
  still use the user's PATH `claude`. `settings.useSystemClaudeForJsonMode`
  (no UI; edit `config.json`) flips json-mode back to PATH for
  diagnostics. The bundled binary is unpacked from asar (216MB native
  Mach-O / ELF / PE per platform) so it can be exec'd at runtime.
- Session persistence via `--resume <sessionId>` on restart, plus
  on-disk transcript replay so the chat scrollback rehydrates after a
  full app restart. Replay dispatches a single `entriesSeeded` event
  so the chat appears in one render rather than ticking in.
- Mid-turn interrupt via stdin `{type:"control_request",
  request:{subtype:"interrupt"}}` — keeps the subprocess alive.
- Mid-session permission-mode change (`default` / `acceptEdits` /
  `plan`) via stdin `control_request` (subtype
  `set_permission_mode`) — does NOT abort the in-flight turn; the
  spawn-time flag is only consulted on a fresh respawn.
- Mid-turn user-message injection: typing while `busy=true` queues the
  message and writes it to stdin, rendered as a dashed/muted "queued"
  bubble with a cancel affordance until the next `result` resolves it.
- Restart action wired (`restartJsonClaude` = kill + start, preserves
  the session id so `--resume` rehydrates) and "Send to agent" works
  from ReviewScreen / DiffView / FileView.
- In-place swap between xterm and JSON-mode Claude tabs (right-click
  the tab), preserving the on-disk session via `--session-id`/`--resume`.
- Default tab type setting (`settings.defaultClaudeTabType`) — when
  JSON mode is enabled, choose whether new agent tabs default to xterm
  or JSON-mode Claude.
- Memory isolation via `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` +
  `HARNESS_TERMINAL_ID` scrub so json-claude sessions don't pollute
  user memory or fire the user-scope status hooks.

### Permissions
- Per-tool approvals via the bundled stdio MCP server
  (`resources/permission-prompt-mcp.js`) → Unix domain socket →
  `ApprovalBridge` → `jsonClaude` slice → `<JsonClaudeApprovalCard />`.
  Allow / Allow with edits / Deny + interrupt-turn checkbox.
- "Allow {tool} this session" / "Allow edits this session" buttons on
  the approval card record a per-session auto-allow set
  (`sessionToolApprovals`); the bridge resolves matching requests
  directly without the UI round-trip. Set survives kill+respawn but
  not app restarts.
- "Always allow…" button on the approval card opens an inline picker
  of self-generated rule suggestions (narrow → medium → broad scoped)
  derived from the tool name + input by `src/shared/permission-patterns.ts`
  — Bash gets `<head> <arg1>:*` / `<head>:*` / `*`, file tools get
  exact path / parent-dir glob / any, WebFetch gets URL / domain / any,
  MCP and other tools get the bare name. Selecting a rule resolves the
  approval with `updatedPermissions: [{type:'addRules', rules: [<rule>],
  destination:'localSettings'}]`, which Claude Code persists into the
  worktree's `.claude/settings.local.json`. Future matching tool calls
  in any session in that worktree are pre-approved before they reach
  the MCP bridge, across app restarts.
- Optional LLM-based auto-reviewer (`settings.autoApprovePermissions`,
  Experimental section). Routes each pending approval through a Haiku
  oneshot first; auto-resolves when Haiku returns approve, falls
  through to the UI otherwise. Decisions logged to debug.log.
  Hardcoded deny-list (push/delete/sudo/credentials/Slack-or-Gmail-
  send) bypasses Haiku and always asks the human.
- Tool cards show audit badges when an approval was auto-resolved —
  `auto-approved by haiku · <reason>` for the LLM path,
  `allowed by session policy` for the per-session set.
- `harness-control` MCP server is co-injected alongside
  `harness-permissions` so worktree/browser/shell tools work inside
  json-claude sessions.

### Chat UI
- Markdown rendering via `react-markdown` + `rehype-highlight`, scoped
  `.markdown` CSS so the global preflight reset doesn't strip
  bullets / heading sizes / code-block padding.
- Partial-message streaming. Assistant text appears progressively;
  deltas are coalesced (~30ms) in `JsonClaudeManager` before dispatching
  to avoid per-token re-renders. Tool calls render a "preparing call…"
  placeholder card the moment `content_block_start` arrives so the UI
  doesn't look frozen while the input streams. The consolidated
  `assistant` event reconciles the entry by replacing its blocks via
  `assistantEntryFinalized`.
- Extended-thinking blocks render as collapsible cards in the chat
  flow (default expanded while streaming, auto-collapsed once the
  message finalizes). Empty-period spinner row covers the dead time
  between user-send and the first stream event, and inter-turn gaps.
- Compaction surfaces as a centered system-style banner ("conversation
  compacted · N messages summarized"); both autocompact and `/compact`
  paths are recognized via the `compact_boundary` content-block type
  in the live stream and the synthetic `system` records in the JSONL
  on seed.
- Per-tool cards (Read / Edit / MultiEdit / Write / Bash / Grep / Glob /
  TodoWrite) with a generic fallback for everything else. Tool calls
  collapsed by default, expandable on click. Compact one-line headers
  (`Read foo/bar.ts`, `Bash: npm test`, `Edit foo.ts (+12 −3)`).
  Errored tool calls show an "error" badge.
- Edit / MultiEdit cards render a real unified diff with syntax
  highlighting (same `highlight.js` instance used for fenced code).
  Read cards render the file with syntax highlighting + line-number
  gutter, dimming non-`offset`/`limit` lines when a range was requested.
- Auto-stick scroll: chat pins to the bottom when streaming and the
  user is near the bottom; releases the pin the moment the user
  scrolls up so backreading isn't fought by new tokens.
- Mobile/narrow-viewport word-wrap fix: `.markdown` uses
  `overflow-wrap: anywhere`, user bubbles use `break-words`, the chat
  scroll container is `overflow-x-hidden`. Long unbroken tokens
  (URLs, hashes) no longer push the page wider than the viewport.
- Consecutive tool calls grouped into a collapsible block between
  assistant text turns. Group header shows count + tool name list.
  Auto-expands when any tool inside has a pending approval; auto-
  collapses again once all the pending approvals resolve, unless the
  user manually toggled the chevron mid-flight.
- harness-control MCP tool calls (`mcp__harness-control__*`) get the
  brand amber→red→purple gradient treatment — thin top bar, gradient
  tool name, and animated flow on hover — matching the Add worktree
  button. The mangled `mcp__harness-control__` prefix is stripped from
  the displayed name.
- Bottom statusline (Claude TUI style): connection state + thinking
  indicator on the left, interrupt + permission-mode chip on the right.
- Sub-agent nesting. `parent_tool_use_id` on assistant entries is
  persisted through the slice, so when Claude spawns a Task agent the
  sub-agent's chronological work (text, thinking, tool calls, results)
  renders inside an expandable `TaskCard` rather than flattening into
  the parent transcript. Recursive — a sub-agent that itself calls
  Task gets a nested TaskCard for its grandchildren. Same chevron +
  chrome treatment as ToolGroup so it reads as another level of the
  same nesting design. Auto-expands while the Task is in flight or any
  descendant has a pending approval; auto-collapses once everything
  resolves unless the user manually toggled.

### Composer
- Slash-command autocomplete: typing `/` pops a ranked picker over the
  session's `slashCommands` (sourced from claude's `system/init`),
  with pre-baked descriptions for built-ins (`/clear`, `/compact`,
  `/cost`, …).
- `@`-mention file picker: typing `@` pops a fuzzy-search picker over
  worktree files; selecting inserts the path into the message.
- Image paste + drag-drop attachments. Pasted/dropped images are
  written to a per-session attachments dir and embedded in the user
  message as `(image attached at <path>)` so the model can Read/Bash
  the file. Thumbnails render in the chat history via a lazy
  `jsonClaude:readAttachmentImage` IPC.

### Cost & usage
- Per-session token + dollar usage rolled up from `result.usage`
  events in the stream into the existing `costs` slice. Surfaces in
  the same per-tab + per-worktree cost panel the xterm path uses.

### Other
- Sidebar/tab status dots derived from the `jsonClaude` slice
  (processing / waiting / needs-approval). The deriver scopes per-event
  and dedups against last-derived status, so streaming tokens don't
  fan out into N status dispatches across N open chats.
- Mobile/web client renders json-claude tabs (textarea uses 16px to
  avoid iOS auto-zoom).
- Integration test that spawns real `claude -p` and exercises the
  approval round-trip.

## Backlog — pick one per worktree

Each entry is sized for an independent branch + PR. Listed roughly in
descending user-visible value.

### High value

#### Sub-agent nesting
`assistant` events carry `parent_tool_use_id` when nested. Today
sub-agent activity flattens into the parent transcript and looks
chaotic. Want: nest child entries under the parent Task tool card.
Renderer-side grouping is ready to consume this — only the manager/
slice plumbing for `parent_tool_use_id` is still missing: persist the
field on `JsonClaudeChatEntry` (or on each assistant entry) in
`src/shared/state/json-claude.ts`, populate it in
`src/main/json-claude-manager.ts` from the stream-json
`parent_tool_use_id` field, and the JsonModeChat grouping pass can
bucket child entries under the parent Task card.

### Medium value

#### `result.usage` rate-limit warnings + MCP auth-needed surface
We drop `rate_limit_event` silently and only partially consume
`system/init`. Surface rate-limit warnings inline in the chat, and an
MCP-server-status row for `system/init.mcp_servers[]` entries that
report `needs-auth` (with a re-auth CTA where relevant).

#### Mid-session model switch
Permission-mode cycling now uses a stdin `control_request` to flip
mid-turn without a respawn. Models don't have an equivalent control
request, so the model picker still has to kill + respawn with
`--resume --model X` (matches the original cycle pattern). Add a
picker in the statusline.

#### Hook-event observability
`--include-hook-events` lets us see auto-approved tool calls (Reads,
safe Bash) that the classifier never sends to the approval bridge.
Render them in a dimmer style — no approval needed but useful for
"what did Claude actually do this turn".

#### Per-worktree / per-repo override of the global `defaultClaudeTabType`
The global setting (`settings.defaultClaudeTabType`) is wired today
but a per-worktree or per-repo override would let a user opt one
specific repo into JSON mode without flipping it for everything.
Likely lives alongside the existing per-repo `.harness.json`.

### Backlog follow-ups from partial-message streaming

- `input_json_delta` for `tool_use` blocks. The partial-streaming PR
  shows a "preparing call…" placeholder card on `content_block_start`
  so the UI doesn't look frozen, but the actual tool input still pops
  in all-at-once when the consolidated `assistant` event arrives.
  Picking this up means accumulating the json fragments per tool_use
  block and progressively populating the per-tool cards as fields come
  in (e.g. `file_path` appears, then `offset`/`limit`).

### Smaller / polish

- Multi-tool cards still missing: WebFetch (URL preview),
  WebSearch (hit list), NotebookEdit, BashOutput (background polling).
- Code-block "copy" button on assistant text.
- `Cmd+F` search over chat scrollback.
- "Jump to bottom" affordance when paused on scroll-up.
- Honor `terminalFontFamily` / `terminalFontSize` settings for
  json-claude (today uses default sans).
- Tab-bar / mobile-app gain a way to *create* a json-claude tab (today
  must be done from desktop's shift-click affordance).
- Surface a `description` for tool calls when Claude provides one
  (rolled back with the suggestions work — the field is empty on the
  MCP path same as suggestions, gated on the same Anthropic-side fix).

### Testing / robustness

- Plain Allow path coverage in the integration test (regressed once;
  add a permanent guard).
- Deny-path coverage (only allow-with-edits is covered today).
- Auth-required / subprocess-crash recovery UI ("session ended; click
  to restart" instead of just `exited` text).
- Rate-limit error display with retry guidance.

### Phase 4 (maybe never) — full replacement

Same as before: only consider once the items above are done AND dual-
mode reveals it's strictly better. This means deprecating xterm and
solving:
  - `/login` / OAuth re-auth flow (currently TUI-only).
  - Every future Claude Code feature becoming a Harness porting task.
  - Stability guarantees on the stream-json protocol and the
    `--permission-prompt-tool` flag, which Anthropic still hasn't
    given.

## Ship as default — blockers and wants

What's required to flip `settings.defaultClaudeTabType` from `'xterm'`
to `'json-claude'` for new users without immediate rollback.

### P0 — must-have before flipping the default

- **Subprocess-crash recovery UI.** Today a crashed json-claude
  subprocess just leaves the tab showing `exited`. New users will hit
  this and not know what to do. Want a clear "session ended; click to
  restart" affordance, with the kill+respawn already wired
  (`restartJsonClaude` exists).
- **Rate-limit error display.** Surface `rate_limit_event` and
  `result` errors with retry guidance instead of dropping silently.
  Right now the chat just appears stuck.
- **`/login` / OAuth re-auth path** — or, at minimum, a clear "switch
  this tab to xterm to re-auth" CTA when auth fails. TUI-only `/login`
  means default users have no recovery path on token expiry today.
- **Pinned-Claude-version smoke test in CI.**
  `--permission-prompt-tool` is `.hideHelp()` and could rename without
  notice. Default users would break first. Run a smoke test on every
  Claude Code dependency bump.
### P1 — strong wants (not strict blockers, but noticeable gaps)

- **Sub-agent nesting.** Already in High-value backlog. Without it,
  Task-using turns look chaotic — sub-agent reads/edits flatten into
  the parent transcript. Definitely visible to a user trying json mode
  for the first time.
- **Mid-session model switch.** Picker in the statusline. Listed in
  Medium value below.
- **`input_json_delta` for tool_use blocks.** Tool input progressively
  pops in instead of one big jump. UX polish, but visible.

### P2 — polish that won't block the default flip

Code-block copy button, Cmd+F search, Jump-to-bottom, terminal
font-family/size, mobile/tab-bar create-json-claude-tab,
multi-tool cards (WebFetch/WebSearch/NotebookEdit/BashOutput/Task),
hook-event observability, per-worktree override of the default tab
type.

### Already in good shape

Performance is no longer a concern — the recent perf pass cut event-
loop spikes ~10x and brought streaming-chat re-render cost to O(1) per
token regardless of how many json-mode chats are open (see
`json-status-deriver-dedup-and-scope`, `cascade-detection-and-architecture-docs`,
`changed-files-watcher-not-poll`, `branch-commits-watcher-and-cascade-tuning`,
`watched-query-cache-for-panels`). Baseline polish (cost meter, real
diff cards, syntax-highlighted Read, scroll-stick, mobile word-wrap)
is shipped.

## Standing risks

- **`--permission-prompt-tool` is `.hideHelp()`.** json-mode runs
  against the bundled `@anthropic-ai/claude-code` (currently 2.1.126,
  pinned in `package.json`) so a global `npm i -g` of a breaking version
  can't surprise users. The integration test in
  `src/main/approval-bridge.test.ts` exercises the round trip on every
  vitest run; a future CI workflow can run that against the pinned dep
  to gate dep bumps. xterm tabs still hit the user's PATH `claude` and
  carry the same risk for that surface.
- **Stream-json schema drift.** `PermissionResult.updatedInput` was
  optional through 2.1.109, became required in 2.1.114 — we got bit
  once (the "plain Allow" regression). Same kind of drift could land
  on any field.
- **MCP path missing fields the TUI gets.** `permission_suggestions`
  + `description` are the known cases. There may be others.
  `--include-hook-events` may also expose differences worth auditing.

## Files / where things live

| Concern | File(s) |
|---|---|
| Subprocess lifecycle, stdin/stdout pump, session jsonl seed | `src/main/json-claude-manager.ts` |
| Permission MCP server (CommonJS, in resources/) | `resources/permission-prompt-mcp.js` |
| Per-session Unix socket bridge | `src/main/approval-bridge.ts` |
| Slice (sessions + pending approvals + permission mode + entries) | `src/shared/state/json-claude.ts` |
| Renderer chat UI + per-tool cards + statusline | `src/renderer/components/JsonModeChat.tsx` |
| Approval card | `src/renderer/components/JsonClaudeApprovalCard.tsx` |
| Approvals hook | `src/renderer/hooks/useJsonClaudeApprovals.ts` |
| Tab-type wiring (panes/persistence/types) | `src/main/panes-fsm.ts`, `src/main/persistence-migrations.ts`, `src/shared/state/terminals.ts` |
| Feature flag | `src/shared/state/settings.ts` (`jsonModeClaudeTabs`) |
| Markdown CSS | `src/renderer/styles.css` (`.markdown` scope) |
| Integration test | `src/main/approval-bridge.test.ts` |
| Diagnostic log | `/tmp/harness-permission-mcp.log` (tail to verify MCP wire) |
