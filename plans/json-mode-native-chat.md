# JSON-mode native chat — backlog

Phase 1 (MCP permission bridge) and Phase 2 (json-claude tab MVP) are
shipped in PR #21 and merged into this branch. This file is the live
backlog of what's left, organized so each item can be picked up in its
own worktree.

## What works today

- `claude -p --input-format stream-json --output-format stream-json` per
  json-claude tab, behind `settings.jsonModeClaudeTabs` (default off).
- Per-tool approvals via the bundled stdio MCP server
  (`resources/permission-prompt-mcp.js`) → Unix domain socket →
  `ApprovalBridge` → `jsonClaude` slice → `<JsonClaudeApprovalCard />`.
  Allow / Allow with edits / Deny + interrupt-turn checkbox.
- `harness-control` MCP server is co-injected alongside
  `harness-permissions` so worktree/browser/shell tools work inside
  json-claude sessions.
- Session persistence via `--resume <sessionId>` on restart, plus
  on-disk transcript replay so the chat scrollback rehydrates after a
  full app restart.
- Mid-session permission-mode toggle (`default` / `acceptEdits` /
  `plan`) by killing + respawning with `--resume`.
- Mid-turn interrupt via stdin `{type:"control_request",
  request:{subtype:"interrupt"}}` — keeps the subprocess alive.
- Sidebar/tab status dots derived from the `jsonClaude` slice
  (processing / waiting / needs-approval).
- Memory isolation via `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` +
  `HARNESS_TERMINAL_ID` scrub so json-claude sessions don't pollute
  user memory or fire the user-scope status hooks.
- Markdown rendering via `react-markdown` + `rehype-highlight`, scoped
  `.markdown` CSS so the global preflight reset doesn't strip
  bullets / heading sizes / code-block padding.
- Per-tool cards (Read / Edit / Write / Bash / Grep / Glob / TodoWrite)
  with a generic fallback for everything else.
- Bottom statusline (Claude TUI style): connection state + thinking
  indicator on the left, interrupt + permission-mode chip on the right.
- Mobile/web client renders json-claude tabs (textarea uses 16px to
  avoid iOS auto-zoom).
- Integration test that spawns real `claude -p` and exercises the
  approval round-trip.
- Default tab type setting (`settings.defaultClaudeTabType`) — when
  JSON mode is enabled, choose whether new agent tabs default to xterm
  or JSON-mode Claude.
- In-place swap between xterm and JSON-mode Claude tabs (right-click
  the tab), preserving the on-disk session via `--session-id`/`--resume`.

## Backlog — pick one per worktree

Each entry is sized for an independent branch + PR. Listed roughly in
descending user-visible value.

### High value

#### Cost meter
The xterm path tails the session jsonl on `Stop` hooks via `CostTracker`
and rolls usage into the `costs` slice. We don't fire those hooks for
json-claude. Either tap `result.usage` from the stream and dispatch into
`costs/` directly, or have `CostTracker` poll the json-claude jsonl too.
Then surface the per-tab + per-worktree totals in the existing cost
panel.

#### Send-to-agent integration
`handleSendToAgent` in `useTabHandlers.ts` writes bracketed-paste escape
sequences via `writeTerminal`. When the active tab is json-claude this
silently no-ops. Add a parallel path that calls
`window.api.sendJsonClaudeMessage` instead. Hits in: ReviewScreen,
DiffView, FileView "Send to agent" buttons.

#### Restart action
`handleRestartAgentTab` does kill+respawn for xterm tabs. Add the
equivalent for json-claude (`killJsonClaude` + `startJsonClaude`;
session id is preserved on disk so `--resume` picks up). Wire to the
existing restart affordance.

#### Inline diff card for Edit / MultiEdit
Today: before/after `<pre>` blocks side-by-side. Want: a real unified
or split diff using the same diff renderer the existing DiffView uses.
Same for MultiEdit (multiple before/after pairs).

#### Read card with syntax highlighting
Today: plain `<pre>` of the file content. Want: highlight by extension
using the same `rehype-highlight` we already use for markdown code
blocks. Bonus: line numbers + line-range highlighting when `offset` /
`limit` were passed.

#### "Allow always" with our own suggestions
We rolled this back when we found the MCP `--permission-prompt-tool`
path doesn't carry Claude's `permission_suggestions` (only the hook +
WebSocket paths do). Two options:
  1. Generate per-tool patterns ourselves (Bash → `<head>:*`,
     Write/Read/Edit → exact `file_path`, Grep/Glob → pattern,
     WebFetch → URL host, MCP tools → bare tool name). Render as a
     radio picker over those patterns. Always write to
     `localSettings`.
  2. File a bug with Anthropic asking that suggestions be attached on
     the MCP path too, then rebuild the picker against
     `permission_suggestions` when it lands.
The plumbing for `updatedPermissions` on the response side is fine —
returning an `addRules` entry already works end-to-end. Only the
*input* side (suggestions to display) is missing.

#### Slash commands
Test which `/x` commands work via stdin in `-p` mode. `/cost` and
`/compact` are the obvious wins; `/clear` and `/resume` overlap with
features we already have. Reimplement the ones that don't pass through
as our own UI affordances.

#### Image paste
Clipboard → stream-json image content block on stdin. Need to verify
the input format accepts image blocks — spike never tested.

#### `@`-mention file picker
Type `@` in the textarea to pop a fuzzy-search picker over worktree
files. On select, insert the path (or a markdown link). Drag-in file
attachments belong in the same flow.

#### Partial-message streaming
`--include-partial-messages` enables token-level streaming of assistant
text. UI today shows turns all-at-once; with partials, text would
appear progressively. Mostly a UX polish; some buffer-management work
needed in the slice (assistant entries become append-only character
streams instead of one-shot blocks).

### Medium value

#### `result.usage` rate-limit warnings
We drop `rate_limit_event` and `system/init` events silently. Both
carry useful state — surface rate-limit warnings inline in the chat,
and an MCP-server-status row for `system/init.mcp_servers[]` entries
that report `needs-auth` (with a re-auth CTA where relevant).

#### Sub-agent nesting
`assistant` events carry `parent_tool_use_id` when nested. Build a
tree-view that nests sub-agent activity under the parent Task tool
call instead of flattening them.

#### Mid-session model switch
Already have permission-mode cycling that kills + respawns with
`--resume`. Extend the same pattern to model switching: a model picker
in the statusline, on change kill + respawn with `--resume --model X`.

#### Hook-event observability
`--include-hook-events` lets us see auto-approved tool calls (Reads,
safe Bash) that the classifier never sends to the approval bridge.
Render them in a dimmer style — no approval needed but useful for
"what did Claude actually do this turn".

#### Settings UI toggle for the feature flag
Today `jsonModeClaudeTabs` is `config.json`-only. Add it to the
existing Experimental settings section so users can toggle without
hand-editing.

#### Per-worktree / per-repo override of the global `defaultClaudeTabType`
The global setting (`settings.defaultClaudeTabType`) is wired today
but a per-worktree or per-repo override would let a user opt one
specific repo into JSON mode without flipping it for everything.
Likely lives alongside the existing per-repo `.harness.json`.

### Smaller / polish

- Multi-tool cards still missing: WebFetch (URL preview),
  WebSearch (hit list), NotebookEdit, BashOutput (background polling),
  Task (sub-agent nesting display).
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
- Pinned-Claude-version smoke test in CI: `--permission-prompt-tool`
  is `.hideHelp()` and could rename without notice.
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

## Standing risks

- **`--permission-prompt-tool` is `.hideHelp()`.** Pinned to Claude
  Code 2.1.114 today. An Anthropic release could rename or remove the
  flag with zero deprecation. Mitigations: feature-flagged off by
  default; add a CI smoke test on every Claude Code bump.
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
