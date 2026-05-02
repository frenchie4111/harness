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
- Per-tool cards (Read / Edit / Write / Bash / Grep / Glob / TodoWrite)
  with a generic fallback for everything else. Tool calls collapsed by
  default, expandable on click. Compact one-line headers
  (`Read foo/bar.ts`, `Bash: npm test`, `Edit foo.ts (+12 −3)`).
  Errored tool calls show an "error" badge.
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

### Other
- Sidebar/tab status dots derived from the `jsonClaude` slice
  (processing / waiting / needs-approval).
- Mobile/web client renders json-claude tabs (textarea uses 16px to
  avoid iOS auto-zoom).
- Integration test that spawns real `claude -p` and exercises the
  approval round-trip.

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
The per-session "Allow {tool} this session" lands matching tool calls
without an approval prompt for the rest of the session — but isn't
persisted. The persisted "always allow" affordance is still missing.
We rolled the original spike back when we found the MCP
`--permission-prompt-tool` path doesn't carry Claude's
`permission_suggestions` (only the hook + WebSocket paths do). Two
options:
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
