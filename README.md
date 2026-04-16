<p align="center">
  <img src="docs/icon.png" alt="Harness" width="128" height="128" />
</p>

<h1 align="center">Run a team of agents.</h1>

<p align="center">
  Run ten Claudes at once without losing your mind.<br />
  Ship more, faster, with every session at your fingertips.
</p>

<p align="center">
  <a href="https://harness.mikelyons.org/">Website</a> ·
  <a href="https://github.com/frenchie4111/harness/releases/latest">Download</a> ·
  <a href="https://harness.mikelyons.org/guide.html">Guide</a>
</p>

![Harness](docs/harness-demo-poster.jpg)

## Download

Grab the latest release from the [releases page](https://github.com/frenchie4111/harness/releases/latest).

- **Apple Silicon (M1/M2/M3/M4):** [Harness-2.3.0-arm64.dmg](https://github.com/frenchie4111/harness/releases/download/v2.3.0/Harness-2.3.0-arm64.dmg)
- **Intel Mac:** [Harness-2.3.0.dmg](https://github.com/frenchie4111/harness/releases/download/v2.3.0/Harness-2.3.0.dmg)

## Installation

1. Download the `.dmg` for your Mac architecture from the links above.
2. Open the `.dmg` and drag **Harness** into your Applications folder.
3. Launch Harness from Applications. The app is signed and notarized, so it should open without any Gatekeeper warnings.
4. On first launch:
   - Pick a git repository when prompted.
   - Click the ⚙ gear icon in the sidebar and paste a [GitHub personal access token](https://github.com/settings/tokens?type=beta) (fine-grained or classic, with `repo` scope). This is optional but required for the PR status panel and checks.
   - When the hooks consent banner appears, click **Enable** so Harness can install status-tracking hooks in your worktrees. These are stored in each worktree's `.claude/settings.local.json` (gitignored by default) and are what make the sidebar status dots reliable.

### Requirements

- macOS (Apple Silicon or Intel)
- [`claude`](https://code.claude.com) CLI installed and on your login shell's `PATH`
- `git` installed (preinstalled on macOS via Xcode Command Line Tools)

## Features

- **Multi-repo** — manage multiple repos in a single window, switch between them or see everything at once
- **Status at a glance** — sidebar dots show which Claude is working, waiting, or needs approval (powered by Claude Code hooks)
- **MCP: Claude controls Harness** — a built-in MCP server lets Claude create and list worktrees on its own
- **Command center** — bird's-eye grid of every worktree with mini activity timelines
- **Activity tracking** — visual timeline of what each Claude has been doing across hours or days
- **Live PR status** — see open PRs and CI checks for every worktree, auto-sorted by urgency
- **Inline diffs** — syntax-highlighted changed-files panel next to the terminal
- **Tabs per worktree** — Claude, shells, and diff tabs scoped to each checkout
- **9 themes** — dark, dracula, nord, gruvbox, tokyo night, catppuccin, one dark, solarized dark/light
- **Configurable hotkeys** — ⌘1–⌘9 to jump between worktrees, all rebindable

## Why did I build this

Honestly I have been using [Conductor](https://www.conductor.build) for a while as a fairly happy customer, but some rough edges have really started to annoy me so on a random Thursday morning I decided to build my own version of it that works the way I want to. Oh yeah did I mention:

> This app is entirely vibe coded - I literally haven't opened the code once. Future travelers be warned

# How's it work?

This app is specifically designed to be an easy way to do the sort of ADD fueled multi-worktree development that I have been in-to these days. Along the left you can see all the worktrees you have, and each worktree has it's own claude, additional terminals and PR display.

The main benefit of this is that your worktrees stay organized, and it's very obvious when one of your many claudes needs your attention (the dot will change colors)

## Worktrees

This app assumes that you are going to want to use worktrees (otherwise what's the point)

It will create a worktree directory at `../<your repo folder>-worktree` and start making worktrees there. This directory will probably be changable at some point

# "Roadmap"

- [x] Initial functionality
- [x] Proper packaging into an app and dmg for other mac users
- [x] OTA Updates
- [x] Settings, configurability, etc
- [x] Better persistence (PTYs don't really stay if you kill the app, which can be a bit frustrating)
- [x] Multi-repo support
- [x] MCP server — Claude can create and manage worktrees itself
- [x] Command center — bird's-eye view of all worktrees
- [x] Activity tracking — visual timeline of agent status history
- [x] Syntax-highlighted diffs
- [x] 9 built-in themes
- [ ] Support other LLM CLI Tools - Honestly I currently only use Claude so this probably won't happen unless I
- [ ] Notifications when cluades are ready for you (maybe peon noises?)
- [ ] Whatever else people want - add a github issue or email me directly!

# Setup, building, and running locally

Clone the repo and install dependencies:

```sh
git clone https://github.com/frenchie4111/harness.git
cd harness
npm install --legacy-peer-deps
```

> The `--legacy-peer-deps` flag is required because `electron-vite@5` declares a peer range that npm's strict resolver rejects against the installed `vite@7`.

Common commands:

| Command | What it does |
|---|---|
| `npm run dev` | Launch the app in dev mode with hot reload |
| `npm run build` | Type-check and build main, preload, and renderer to `out/` |
| `npm run pack` | Build an unsigned `.app` for local smoke testing (fast — skips codesigning and notarization) |
| `npm run dist:mac` | Full signed + notarized macOS build (requires `.env` with Apple creds) |
| `npm run rebuild:dev` | Rebuild `node-pty` against the dev Electron version — run this if dev mode errors with `posix_spawnp failed` |
| `npm run log` | Tail the debug log at `~/Library/Application Support/harness/debug.log` |

After `npm run pack`, you can launch the unsigned build with:

```sh
open release/mac-arm64/Harness.app
```

If Gatekeeper blocks the unsigned app, strip the quarantine attribute first:

```sh
xattr -cr release/mac-arm64/Harness.app
```

# Contributing

I mean if you want? I think you probably just want to tell claude to download it and make whatever changes you want
