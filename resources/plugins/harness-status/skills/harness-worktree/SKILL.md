---
name: harness-worktree
description: Spin off an isolated Harness worktree (own git branch, own Claude session) for a new task, fix, investigation, or anything that would benefit from working in parallel. Use when the user describes a task that could be delegated, when work needs isolation from the current branch, or when the user mentions "new worktree", "split this off", "work on this in parallel", or "delegate".
---

# Worktrees in Harness

Each worktree is an independent git branch with its own terminal and Claude session. Suggest spawning one when the user wants to start something that would benefit from isolation, parallelization, or a fresh context.

## Tools

- `mcp__harness-control__create_worktree` — create a new worktree with its own Claude session. **Always provide a detailed `initialPrompt`** so the new session has full context; it won't see your conversation.
- `mcp__harness-control__list_worktrees` — list active worktrees.

## Writing a good `initialPrompt`

Brief the new session like a smart colleague who just walked into the room — they haven't seen this conversation, don't know what you've tried, don't understand why this task matters.

- **Explain what you're trying to accomplish and why.**
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that they can make judgment calls, not just follow narrow instructions.
- Include file paths, line numbers, and specifics — proof you understood the task.
- If you need a short response, say so explicitly.

Terse command-style prompts produce shallow, generic work.

## When NOT to spin off a worktree

- Tiny edits, single-file fixes, anything that takes less context to do than to brief.
- Tasks that genuinely need the current conversation's running state (open browser tabs, terminal output you'd lose, in-progress reasoning).
- The user said "do it here." Don't second-guess explicit scope.
