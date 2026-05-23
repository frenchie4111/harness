---
name: harness-shell
description: Use Harness shell tabs (create_shell, read_shell_output, kill_shell) instead of Bash for long-running processes — dev servers, watchers, `tail -f`, REPL-style tools, long builds. Use when the user asks to start a dev server, tail logs, run a watcher, or anything that wouldn't naturally exit within a few seconds.
---

# Shell tabs in Harness

For processes that wouldn't naturally exit within a few seconds — dev servers, watchers, `tail -f`, REPL-style tools, long builds — use the harness-control shell tools instead of Bash.

## Why not Bash?

- Bash either **blocks** until the process exits, or **loses the output stream** when backgrounded.
- Harness shell tabs keep streaming, stay readable via `read_shell_output` after the fact, and are visible to the user in the Harness UI.

## Tools

- `create_shell` — spawn a shell tab, optionally with a command (`zsh -ilc <command>`). Returns an id; keep it for later reads.
- `list_shells` — enumerate existing shell tabs. **Check here before spawning** — don't start a second `npm run dev` if one is already running.
- `read_shell_output` — read a shell's output (ANSI stripped). Use `match` + `context` to scan long logs for errors/warnings without pulling back megabytes.
- `kill_shell` — terminate the process AND close the tab. For natural exits the tab stays open for inspection; `kill_shell` is explicit cleanup.

## Short one-shots stay on Bash

`npm test`, `tsc --noEmit`, `git status`, `npm install` — anything that exits in a few seconds belongs on Bash. The streaming + visibility benefits of a shell tab aren't worth the tab clutter for those.

## Reading busy logs efficiently

`read_shell_output` accepts a `match` regex (case-insensitive) with a `context` line count. For a 10MB build log, pulling the whole thing wastes context — scan for `error|warn|fail` with `context: 3` instead.
