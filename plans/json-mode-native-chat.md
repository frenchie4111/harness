# JSON-mode native chat for Claude tabs

Spike branch: `json-mode-native-chat-spike`
Spike artifacts: `spike-findings.md`, `spike-stream.ndjson`,
`spike-mcp-approval.mjs`, `src/main/json-claude-manager.ts`,
`src/renderer/components/JsonModeChat.tsx`.

## The idea

Today every Claude tab is an xterm running the Claude Code TUI. That gives
us readline-bound input, terminal-style selection, and no escape from
1990s aesthetics. The alternative is to run Claude Code headless
(`claude -p --input-format stream-json --output-format stream-json`) and
render the conversation in React — native textarea, real text selection,
markdown, syntax highlighting, tool cards, accessibility.

## What the spike proved

### Protocol works as expected

- Stream-json emits discrete events per turn: `system/init`, `assistant`
  (text + tool_use), `user` (tool_result), `rate_limit_event`, `result`.
  Standard Anthropic message content blocks, so every tool_use/tool_result
  is renderable as a React component.
- Feeding multiple `{type: "user", message: {...}}` lines on stdin keeps
  one long-running subprocess alive across turns with full context. So
  the architecture is "one subprocess per tab", not "spawn-per-turn".
- `--resume <session-id>` across fresh processes works and reads the
  same session jsonl Harness already tails via `latestClaudeSessionId`.
  Restart/reload survives.
- MCP tools pass through as regular tool_use entries. No special-casing.
- Prototype end-to-end works: a new `'json-claude'` tab type renders
  conversations in React, typed via textarea. Alt-click the Sparkles
  button to spawn one. Build passes, sandbox-compatible (renderer uses
  only `window.api`, no Node APIs).

### The permission flow works — via a hidden flag

This was the spike's biggest find. The initial pass concluded there was
no way to handle per-tool approvals in `-p` mode, which would have
killed the whole idea. **That was wrong.** There is a flag:

```
--permission-prompt-tool <mcp-tool-name>
```

It's declared with `.hideHelp()` in the binary, so `claude --help`
doesn't show it. It exists and works today in 2.1.109.

Contract (reverse-engineered from the binary, then verified end-to-end
against a local stdio MCP server in this worktree):

1. Pass any MCP tool name: `--permission-prompt-tool mcp__<server>__<tool>`.
   The tool must be a real MCP tool with an `inputJSONSchema`.
2. When Claude wants to invoke a tool that would normally prompt, it
   calls your MCP tool synchronously via stdio with:
   ```json
   {"tool_name": "Write",
    "input": {"file_path": "...", "content": "..."},
    "tool_use_id": "toolu_..."}
   ```
3. Your tool returns a text content block whose text is a JSON
   `PermissionResult`:
   - `{"behavior": "allow", "updatedInput": {...}, "updatedPermissions": [...]}`
     — allow, optionally rewriting the input before execution, optionally
     persisting rules into Claude's tool permission context
   - `{"behavior": "deny", "message": "reason"}` — tool call returns as
     `is_error: true` to the model with your message, run continues
   - `{"behavior": "deny", "message": "...", "interrupt": true}` — aborts
     the whole turn via the session AbortController
4. The call is synchronous from Claude's POV — it blocks on the MCP
   stdio reply, just like the TUI blocks on the user's keystroke.

Confirmed two things in the spike:
- **Deny path:** a deny-all approver blocked `Write` and `Bash rm`
  cleanly; file on disk was never created; `result.permission_denials[]`
  captured both with full original `tool_input`.
- **Input mutation:** approver accepted a `Write` but returned
  `updatedInput.content = "REWRITTEN_BY_APPROVER"`. The file on disk
  contained the rewritten content, not what the model asked for. This
  is a power-user feature the TUI doesn't have.

**One caveat:** the prompt tool is only consulted for tools that would
*otherwise* require approval. Reads and safe Bash (`echo hi`) under
`--permission-mode default` are auto-approved by the built-in classifier
and never reach the approver. That's desirable (no nag spam) but means
we can't claim full visibility via this channel alone.

## Revised recommendation

Before the permission finding: sidecar-only, full replacement blocked.

After the finding: **dual-mode is viable.** Ship a second tab type
alongside the xterm one, let power users stay on classic, slowly bake
out parity features. Key unlock is that the approval flow is no longer
a blocker — we can show a real React approval card, the user clicks
Allow/Deny/Edit, and the answer rides back through the MCP bridge.

Build it in phases. Each phase is independently useful.

## Phased plan

### Phase 0 — jsonl-tail sidecar (~1 week, zero risk)

Do not touch Claude tabs. Add a read-only activity panel next to the
existing xterm, driven by tailing the session jsonl file Harness already
locates via `latestClaudeSessionId`.

- New main-side module `session-jsonl-tailer.ts`: watches the jsonl for
  the active Claude tab, parses events, dispatches a new slice
  (`sessionEvents`) with recent tool calls, cost/usage rollups,
  rate-limit state.
- Renderer panel in the right sidebar: tool timeline (Read/Edit/Bash
  icons with filenames), live cost meter, MCP server status, latest
  denials list.
- Zero subprocess cost. Zero protocol risk. Works on every existing
  Claude tab for free.
- **Deliverable:** users get structured visibility into what Claude is
  doing without leaving the xterm world.

### Phase 1 — MCP permission bridge plumbing (~1-2 weeks)

Build the approval pipe even before we use it for a full chat tab. It
also becomes the backbone of any future dual-mode work.

- Bundle a stdio MCP server inside Harness. Options:
  1. Ship as a small standalone `.mjs` file in `resources/` invoked via
     `node` (simple, adds node as runtime dep).
  2. Use Electron's `child_process.fork` against a compiled JS entrypoint
     in `out/` (no node dep, but trickier pathing in packaged app).
  3. Use `claude mcp serve` as a reference but write our own.
  - Recommendation: option 2 with a dedicated
    `src/main/permission-prompt-mcp/index.ts` entrypoint that gets
    bundled by electron-vite into `out/permission-prompt-mcp.js`.
- The MCP server exposes one tool, `approve`, with schema
  `{tool_name, input, tool_use_id}`. On invocation it talks back to
  Harness main over a Unix domain socket (generated per-session,
  passed via env var). Main routes the request to the store as a new
  `json-claude/approvalRequested` event.
- Renderer subscribes via `useJsonClaudeApprovals()`, shows an approval
  card, user clicks Allow/Deny/Allow-with-edits. Response rides back
  through the socket → MCP server → Claude Code → tool execution.
- Surface the existing TUI-side approval UI (or a new shared component)
  so both xterm-hook-driven and mcp-driven approvals render identically.
- Test harness: port `spike-mcp-approval.mjs` into the proper
  `permission-prompt-mcp/` module and run it against a real
  `JsonClaudeManager` spawn inside Harness.

### Phase 2 — minimal json-claude tab behind a feature flag (~2-3 weeks)

Turn the spike prototype into something usable. Still behind a setting;
default off.

- Replace the spike's `bypassPermissions` with `--permission-mode default`
  and `--permission-prompt-tool` pointed at the bundled MCP. Every
  approval routes through the bridge from Phase 1.
- Tool cards for the common cases: Read (syntax-highlighted preview),
  Edit (inline diff), Write (file + content preview), Bash (command +
  collapsible output), Grep (hit list), Glob (file list), TodoWrite
  (checklist). One component per tool, one switch in `JsonModeChat.tsx`.
- Real markdown: swap the spike's mini-renderer for
  `react-markdown` + `shiki` or `highlight.js` for fenced code blocks.
- Session persistence across reload: when a json-claude tab is created,
  mint a session-id, store it on the tab, pass `--session-id` at spawn.
  On restart, respawn with `--resume <session-id>`.
- Interrupt button: send SIGINT to the subprocess (or `abortController`
  equivalent via stdin — test both). Confirm it leaves the session in a
  resumable state.
- Kill on tab close, restart on "restart Claude" action.
- Hooks consent parity: the classic tab respects the hooks-consent
  banner; json-claude tabs don't need hooks at all because the MCP
  bridge replaces them. Make sure the banner + "hooks just installed"
  flow doesn't break for mixed-mode workspaces.

### Phase 3 — parity grind (~4-8 weeks)

The things the TUI has that a v1 json-claude tab won't. None individually
hard, all individually tedious. Sketch list from the spike's gap audit:

- `/slash` commands — test which work via stdin; reimplement the ones
  that don't (`/cost`, `/compact`, `/clear`, `/resume`).
- Image paste (clipboard → stream-json image content block).
- @-mention file picker with fuzzy search.
- Drag-in file attachments.
- Hook events via `--include-hook-events` for observability of the
  auto-approved path (reads, safe bash).
- Partial message streaming via `--include-partial-messages` for token-
  level streaming UX.
- Sub-agent nesting display (use `parent_tool_use_id` threads).
- Plan mode toggle.
- Model switch mid-session via process restart with `--resume`.
- Rate-limit warnings UI.
- Cost/usage live meter.
- Copy semantics (make sure code-block copy works, make sure full-message
  copy preserves markdown).
- MCP server status indicators (`system/init.mcp_servers` has
  `needs-auth` entries; surface a re-auth CTA).
- Transcript history before current session (when resuming).

At any point during Phase 3 we can pause and just ship what we have
behind the feature flag. Nothing is load-bearing; we're not deprecating
the xterm path.

### Phase 4 (maybe never) — full replacement

Only if Phase 3 reveals the dual-mode experience is strictly better for
power users too. This means removing the xterm Claude path, which means:

- Parity on everything above, plus keyboard muscle-memory migration.
- An answer for `/login` / auth expiry (currently TUI-only interactive
  OAuth flow).
- A plan for every future Claude Code feature becoming a porting task.
- Stability guarantees on the stream-json protocol and the
  `--permission-prompt-tool` flag, which Anthropic has not given.

Not recommended in the foreseeable future. Dual-mode is the resting
state.

## Risks and unknowns

- **`--permission-prompt-tool` is `.hideHelp()`.** This is the single
  biggest risk. We depend on an undocumented private flag. Anthropic
  can rename, restructure, or remove it between releases with zero
  deprecation window. Mitigations:
  1. Pin Claude Code versions that Harness is tested against and warn
     on mismatch.
  2. Feature-flag the json-claude tab type so a CLI upgrade that breaks
     the flag downgrades gracefully — user keeps xterm tabs, loses
     json-mode until Harness ships a fix.
  3. Add a smoke test to Harness's CI that runs a real `claude -p`
     invocation against the bundled MCP server and asserts the approval
     round-trip works. Run on every Claude Code bump.
- **Classifier bypasses the approver.** Safe reads and trivial bash
  don't reach the MCP tool. Fine for most use cases, but means "Harness
  sees every tool call" requires pairing with `--include-hook-events`
  for observation. Not a blocker; a documentation item.
- **Interrupt mid-turn.** `deny + interrupt: true` aborts via the
  session AbortController, so the user's "stop this tool" case is
  covered. "Stop mid-model-turn" (like TUI Ctrl+C) still means killing
  the subprocess and losing the partial turn. Acceptable.
- **`updatedPermissions` persistence scope.** Didn't test whether rules
  persist into the session jsonl or only in-memory. Follow-up spike.
- **Image and non-text content blocks on stdin.** Didn't test. Probably
  works (it's the standard Anthropic content block shape) but unknown.
- **Slash commands via stdin.** Didn't test. Worth ~15 minutes of
  probing before committing to Phase 3 reimplementation work.
- **Memory-system cross-contamination.** Running `claude` as a child
  process in the spike wrote into the user's auto-memory directory
  (`user_number_42.md`, cleaned up manually). Any real implementation
  must spawn with `--bare` or an isolated memory path, otherwise
  every json-claude tab pollutes the user's personal memory with
  artifacts from conversations they didn't have in their "real"
  Claude Code session.
- **Auth expiry.** In json-mode we can't proxy OAuth. If the user's
  Claude Code auth expires, the subprocess dies and the user has to
  drop to a real terminal to run `claude auth`. We need a UX for this
  (detect the specific exit code, show a "reauth in terminal" banner
  linking to the xterm tab).

## Files to read when picking this back up

- `spike-findings.md` — the longer-form investigation notes from the
  spike session, with the full permission-flow decompilation.
- `spike-stream.ndjson` — real captured stream-json output, useful as a
  test fixture.
- `spike-mcp-approval.mjs` — 90-line working stdio MCP permission-
  prompt server. Port this to a real Harness module in Phase 1.
- `src/main/json-claude-manager.ts` — subprocess manager spike. Good
  skeleton for the real thing; needs permission-prompt-tool plumbing,
  session-id persistence, `--resume` on restart, interrupt handling.
- `src/renderer/components/JsonModeChat.tsx` — React renderer spike.
  Good skeleton; needs real markdown/syntax highlighting, per-tool
  cards, approval card integration, image paste, @-mentions.
- `src/preload/index.ts` + `src/renderer/types.ts` — IPC surface added
  for json-claude. Extend with approval-related methods in Phase 1.
- `src/renderer/components/WorkspaceView.tsx` — where the new tab type
  renders. Add feature flag guard here.
- `src/main/pty-manager.ts` — the analog for xterm tabs. Mirror its
  lifecycle patterns in `JsonClaudeManager`.

## Decisions needed before starting

- **Feature flag location.** New slice, or a boolean in `settings`?
  Probably `settings.jsonModeClaudeTabs: boolean`, default false.
- **MCP server packaging.** Decide between the three options in Phase 1.
  Leaning option 2 (electron-vite bundles our MCP entrypoint into `out/`).
- **Approval UI reuse.** One shared approval card component for both
  xterm `/tmp/harness-status/` driven approvals and json-claude MCP
  driven approvals, or two separate components? Leaning one shared,
  since the payload shape is nearly identical.
- **Sandbox compat.** Validate the json-claude renderer under
  `sandbox: true` in the sibling worktree before Phase 2 ships.
