# JSON-mode Claude spike — findings

(Scratch file, delete before any merge to main.)

## Phase 1: protocol investigation

### CLI shape

- `claude -p --input-format stream-json --output-format stream-json --verbose`
  is the full combination. `--verbose` is required for `stream-json` output.
- `--include-hook-events` and `--include-partial-messages` are optional flags
  that layer in more events.
- `--replay-user-messages` re-emits user messages from stdin for acknowledgement.
- `--session-id <uuid>` pins a session; `--resume <uuid>` reopens one.
- `--permission-mode` choices: `acceptEdits`, `auto`, `bypassPermissions`,
  `default`, `dontAsk`, `plan`.

### Event types observed in `spike-stream.ndjson` (real capture)

Top-level `type` values seen in one invocation that did a Read + a Bash call:

| type | subtype | notes |
|---|---|---|
| `system` | `init` | first event; includes `session_id`, `model`, `tools`, `mcp_servers`, `slash_commands`, `agents`, `skills`, `plugins`, `permissionMode`, `apiKeySource`, `memory_paths` |
| `rate_limit_event` | — | `rate_limit_info` with reset times |
| `assistant` | — | standard Anthropic `message` shape: `role`, `content[]` where items are `{type: 'text', text}` or `{type: 'tool_use', id, name, input}`; includes full `usage` block |
| `user` | — | `message.content[]` where items are `{type: 'tool_result', tool_use_id, content, is_error}` |
| `result` | `success` | last event; includes `duration_ms`, `num_turns`, `total_cost_usd`, `usage` rollup, `modelUsage`, `permission_denials`, `terminal_reason` |

Every event carries `session_id` and `uuid`; assistant events also carry
`parent_tool_use_id` when nested.

### Multi-turn input (stream-json → stream-json)

Confirmed: piping multiple NDJSON lines into one `claude -p` invocation keeps
the same process alive across turns. Within one process, context is retained
(asked for "the number 42" then "what number did I tell you?" got "42").

Format accepted on stdin:
```
{"type":"user","message":{"role":"user","content":"hello"}}
```

This means a JSON-mode tab can be a single long-running subprocess we pipe
into, rather than per-turn spawn. **Architecture: stateful, long-running.**

### Cross-process resume

Confirmed: `claude -p --resume <session-id> --input-format stream-json ...`
in a fresh process successfully recovered the `42` context from a prior
stream-json session. The session jsonl persistence is shared between TUI
and JSON mode, so Harness's existing `latestClaudeSessionId` logic should
work for JSON tabs.

### Permissions — the big unknown (partially blocking)

- In `-p` mode **there is no interactive approval flow**. Permission is
  decided by `--permission-mode` + `--allowedTools`/`--disallowedTools`
  flags at spawn time.
- There is no `--permission-prompt-tool` flag visible in this version
  (2.1.109). Earlier versions of Claude Code documented one; it may be
  gated behind an MCP permission-prompt server.
- Observed: with `--permission-mode default`, a `Bash echo hello` ran
  without prompting (auto-approved for safe commands). With
  `--disallowedTools Bash`, the tool is simply hidden from the model.
- `result` events include a `permission_denials` array we can surface.

**Implication:** To replicate the TUI's per-tool approval dialog in JSON
mode we need one of:
1. Spawn with `bypassPermissions` and ship an in-harness guard that
   intercepts tool calls via hook events (`--include-hook-events`,
   `PreToolUse`) — but hook events are *post-facto* notifications, they
   don't block execution.
2. Keep a whitelist of pre-approved tools per tab, and upgrade the list
   over time via process restart (ugly, loses context unless combined
   with `--resume`).
3. Ship a tiny MCP "permission prompt" server the CLI can consult, if a
   flag for that surfaces in a newer CLI release.

None of the above are as clean as the TUI's inline approval. This is the
single biggest architectural risk for a full-replacement approach.

### Slash commands in JSON mode

- The `system/init` event lists `slash_commands` (16 in my env).
- I did not test sending `/compact` via stream-json stdin — worth doing
  next. Based on the CLI's `--disable-slash-commands` flag existing,
  slash commands probably DO flow into JSON mode, but I didn't confirm.
  **Todo for follow-up spike.**

### MCP tools

- `system/init.tools` lists every MCP tool by `mcp__server__tool_name`
  flat. They show up as regular `tool_use` entries in the stream — the
  protocol doesn't distinguish built-in vs MCP tools.
- **Verdict:** MCP tools pass through cleanly.

## Phase 2: prototype

Built end-to-end: `spike-stream.ndjson` sample + new main-side
`json-claude-manager.ts` + IPC + renderer `JsonModeChat.tsx`, wired into
`WorkspaceView` behind a new `'json-claude'` tab type. Alt-click the
Sparkles ("new Claude tab") button to create one.

- Subprocess model: spawn `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions` once per tab; pipe JSON messages on stdin, parse NDJSON on stdout, forward to renderer via a single `json-claude:event` channel.
- Renderer state is purely local (chat scroll, busy flag); no slice
  touched. Sandbox-compatible (renderer only uses `window.api`).
- Minimal markdown: paragraphs, headers, bullets, fenced code blocks,
  inline bold/code.
- Tool rendering: one generic `ToolCard` with a Read/Bash summary and
  a truncated result body; covers all tools (not just Read).
- Close / kill on tab close via new `json-claude:kill` IPC.
- The Claude-side classic `'claude'` tab path was not modified.

Build passes (`npx electron-vite build`). The pre-existing `npx tsc`
errors (JSX namespace, test file drift) are unchanged by this spike.

## Phase 3: what would it take to ship this?

### Feature-parity gap list (what JSON-mode at v1 can NOT do vs. the TUI)

1. **Interactive per-tool approval.** No inline Allow/Deny; see permissions
   section above.
2. **Permission rule editing in-flow** ("always allow Bash(git log)").
3. **Ctrl+C to interrupt.** Need to reimplement as a Stop button that
   either kills the subprocess (loses context) or figures out how to
   cancel mid-turn via the CLI protocol (unknown).
4. **Ctrl+R to resume, interactive `--resume` picker.** Must rebuild.
5. **Image paste.** Unknown whether stream-json input accepts image
   content blocks — not tested.
6. **File drag-in with @-mention.** Need to reimplement.
7. **@-mention file picker.** Not tested.
8. **Slash command UI** (autocomplete, parameters). Unconfirmed whether
   `/xxx` in stdin even works; needs testing.
9. **`/clear`, `/compact`, `/cost`, `/resume` behaviors.** See above.
10. **Skills UI** (`/skill-name` discovery).
11. **Agents UI.** `system/init.agents` lists them but launching is TBD.
12. **Plan mode toggle.** `--permission-mode plan` can be passed at spawn
    but flipping at runtime is unknown.
13. **Effort / model switch mid-session.** TUI has `/model`; JSON mode
    would need a process restart with `--resume`.
14. **TUI-native markdown rendering quirks** (nested task lists,
    diagrams, KaTeX) — must all be reimplemented in React.
15. **Syntax highlighting for code blocks.** TUI has it; our prototype
    doesn't.
16. **Tool-specific rich rendering** (Read → code with line numbers,
    Edit → diff, Grep → hit list, WebFetch → URL card, TodoWrite →
    checklist). Each is its own mini-feature.
17. **Sub-agent task nesting.** `parent_tool_use_id` threads exist; we'd
    need a tree-view.
18. **Hook event stream** (`--include-hook-events`) and its UI.
19. **Partial message streaming** (`--include-partial-messages`) — token
    streaming UX.
20. **Cost / usage display in-line.** We get it in `result` events, but
    the TUI has live usage meters.
21. **Rate limit warnings.** TUI surfaces these; we have `rate_limit_event`
    but no UI.
22. **Transcript scrollback before current session** (TUI shows earlier
    session history after `--continue`).
23. **Status bar integrations.** TUI shows mode/model/branch/cost; we'd
    rebuild.
24. **Keyboard muscle memory.** Every shortcut would differ.
25. **Copy-with-formatting semantics.** Terminal selection vs. HTML
    selection behave differently; user expectations will drift.
26. **Image attachments in assistant output** (if any — unknown).
27. **MCP server status indicators** (`system/init.mcp_servers` has
    `needs-auth` — we'd need a re-auth UI).
28. **`/login` flow for expired auth.** Currently TUI-only.
29. **BashOutput / background task polling UX.**
30. **xterm search, copy, clear-scrollback shortcuts.** Must reimplement.
31. **Fonts / ligatures / terminal font settings.** Become irrelevant,
    but user preference must be honored somewhere else.
32. **Offline CLAUDE.md auto-discovery display.**

It's 30+ easily. Many are small individually, but every one is another
surface the user bumps into.

### Effort estimates

**Sidecar (1–2 weeks).** Keep the xterm tab authoritative; run a second
invisible `claude -p --output-format stream-json --resume <sessionId>`
process **only to tap the stream for structured data** and render an
activity panel (tool timeline, cost chart, recent tool results,
permission denial log). Zero risk to the TUI path. Most valuable
low-effort deliverable. Main risk: double-spawn cost + the fact that
`--resume` on stream-json is a fresh turn, not a passive tap —
**this may not actually work without CLI changes.** Alternative: tail
the session jsonl file on disk directly (Harness already knows where
it is for `latestClaudeSessionId`) and parse events from there. That's
definitely feasible.

**Dual-mode (6–10 weeks).** Ship `'json-claude'` tab alongside classic.
Usable for read-only / small sessions where permissions aren't an issue;
power users stay on xterm. Need to build: real markdown/syntax
highlighting, 5 tool-specific cards (Read, Edit, Write, Bash, Grep),
interrupt via kill+resume, slash command passthrough tests, basic image
paste, @-mention file picker, session pickup on app restart, activity
slice integration, cost/usage panel. Explicitly ship with a "this
doesn't replace the TUI" banner and a known-gaps list.

**Full replacement (4–6 months + ongoing maintenance tax).** Means
deprecating xterm Claude tabs, which means reaching parity on all 30+
items above — including a usable approval flow, which is currently
unresolved. The maintenance tax is real: every Claude Code release that
adds a TUI feature becomes a Harness porting task.

### Recommendation

**Do the sidecar first** — but with a twist: *don't* double-spawn, tail
the session jsonl file Harness already locates via
`latestClaudeSessionId`. It's a pure read path, zero subprocess cost,
zero protocol risk, and gives us an activity/tool/cost panel that works
immediately on every existing Claude tab. That's a ~1 week deliverable
with real user-visible value.

After shipping the sidecar, reassess. If the JSON event stream proves
stable and rich enough, AND Anthropic lands a proper permission-prompt
mechanism for `-p` mode, THEN consider dual-mode. Do not commit to full
replacement under current CLI constraints — the permission story alone
would force us to ship an app that's strictly worse than the TUI for
power users, and we'd eat the parity treadmill forever.

If the sidecar experiment reveals that the jsonl tail is surprisingly
powerful (e.g., we can drive a real React chat view off it *without*
taking over input), that might collapse the dual-mode phase to something
much smaller — an add-on view that reads but doesn't write, with input
still going through xterm.

### Risks and unknowns

- **Stability of the stream-json protocol.** Not documented as a stable
  contract anywhere I can find. Minor version bumps could rename or
  restructure fields. This is the biggest ship-blocker: every Harness
  release would need re-validation.
- **Permission prompt mechanism.** No workable in-flow approval today.
- **Interrupt semantics.** Can we cancel a mid-turn tool call without
  killing the process? Unknown.
- **Image / non-text content blocks on stdin.** Not tested.
- **Slash commands via stdin.** Not tested.
- **`/login` / auth expiry.** In JSON mode we can't proxy the interactive
  OAuth flow — the user has to drop to a real terminal to re-auth.
- **Sandbox compatibility.** Our prototype uses only `window.api` +
  IPC, no Node APIs in renderer. Should be sandbox-safe, but not yet
  tested with `sandbox: true` on a BrowserWindow.
- **Memory-system cross-contamination.** When I ran the spike `claude`
  subprocess for testing, it wrote into my personal memory directory
  (`user_number_42.md`). If Harness runs JSON-mode Claude as child
  processes, we need `--bare` or an isolated memory path, or the
  user's memory will fill up with artifacts from every JSON-mode tab.
  Cleaned up manually during the spike; flag for real implementation.
