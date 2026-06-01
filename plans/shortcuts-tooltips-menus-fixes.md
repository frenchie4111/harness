# Plan: Shortcuts / Menu / Tooltip Priority Fixes

Five independent workstreams, ordered by effort-to-impact. Each can ship as its
own commit. Line numbers are references gathered during inventory and should be
re-confirmed at edit time.

## Status (2026-05-30)

**Fixes 1–4 shipped** on branch `shortcuts-tooltips-menus` (pushed to origin).
Full vitest suite green (1351 passed), typecheck + build clean. Commits:

| Fix | Status | Commit |
|---|---|---|
| 1 — right-sidebar copy | ✅ shipped | `eb5aa07` |
| 2 — ⌘N / ⌘⇧R collisions | ✅ shipped | `a72a190` |
| 3 + 4-display — cheatsheet entries + modifier order | ✅ shipped | `dfd0412` |
| 4-hints — Settings tooltip ⌘, | ✅ shipped | `277130e` |
| 5 — menu-bar expansion | ⛔ deferred | — |

Per-fix details below are kept as the as-built record; deltas from the original
plan are called out inline.

---

## Fix 1 — Correct wrong tooltip text  ·  ✅ SHIPPED (`eb5aa07`)

**Severity:** low risk, clearly-wrong-today · **Effort:** ~10 min

The right-hand panel is now called the **right sidebar**; use that name in all
copy (not "right column"). Two buttons describe themselves as "the sidebar"
when they actually control the right sidebar — they also collide with the left
sidebar's identical labels.

| File | Location | Current | Change to |
|---|---|---|---|
| `src/renderer/components/RightColumnToolbar.tsx` | ~line 140 (collapse button) | tooltip `"Collapse sidebar"` | `"Collapse right sidebar"` (also update `aria-label` to match) |
| `src/renderer/components/CollapsedRightPanel.tsx` | ~line 299 (expand button) | tooltip `"Expand sidebar"` | `"Expand right sidebar"` (also update `aria-label` to match) |

> The collapsed-sidebar Settings button is **not** broken — `CollapsedSidebar.tsx:186`
> already wires `onClick: onOpenSettings` (bottom actions are data-driven). The
> only gap there is the missing ⌘, hint, which Fix 4 covers.

**As built:** both the `Tooltip` label and the `aria-label` updated to "Collapse
right sidebar" / "Expand right sidebar" in `RightColumnToolbar.tsx` and
`CollapsedRightPanel.tsx`. Typecheck + build clean.

---

## Fix 2 — Resolve ⌘N and ⌘⇧R menu/hotkey collisions  ·  ✅ SHIPPED (`a72a190`)

**Severity:** functional bug (renderer actions are shadowed) · **Effort:** ~30 min

The Electron menu accelerator is consumed at the menu layer, so the renderer
hotkey for the same chord never fires. Both decisions are settled below.

### 2a. ⌘N collision — **decided: ⌘N = New Worktree, New Project = no shortcut**
- **Menu** `File → New Project…` = `CmdOrCtrl+N` (`src/main/desktop-shell.ts`)
- **Renderer** `newWorktree` = ⌘N (`hotkeys.ts:92`)
- Result today: ⌘N opens New Project; the "new worktree" hotkey is dead.

**Change:** remove the menu item's accelerator entirely so it no longer captures
⌘N. The renderer `newWorktree` ⌘N hotkey then fires as intended. No
`DEFAULT_HOTKEYS` change needed; a New Worktree menu item is deferred with the
rest of Fix 5.
- Note: the original fix repointed the accelerator to `Ctrl+N`, but ⌃N never
  triggered New Project reliably, so it was dropped. New Project is now
  menu/button-only with no shortcut hint.

### 2b. ⌘⇧R collision — **decided: drop Force Reload's accelerator**
- **Menu** `View → Force Reload` (role `forceReload`, default ⌘⇧R)
- **Renderer** `refreshWorktrees` = ⌘⇧R (`hotkeys.ts:93`)
- Result today: ⌘⇧R reloads the whole renderer instead of refreshing worktrees.

**Change:** Force Reload is a dev-only escape hatch → remove its accelerator
(keep the menu item clickable) so `refreshWorktrees` ⌘⇧R works.

**As built:** New Project…'s accelerator was removed entirely (`5b1b5f4`) — an
interim `Ctrl+N` accelerator (`a72a190`) never reliably triggered New Project, so
it and the `hotkey="Ctrl+N"` tooltip hints in the expanded + collapsed sidebars
were dropped. `View → Force Reload` swapped from `role: 'forceReload'` to a
custom item that calls
`BrowserWindow.getFocusedWindow()?.webContents.reloadIgnoringCache()` with no
accelerator. Both in `src/main/desktop-shell.ts`. Still needs a manual smoke
test in a packaged/dev launch to confirm ⌘N (New Worktree) and ⌘⇧R (Refresh
Worktrees) route correctly (not covered by unit tests).

---

## Fix 3 — Surface `renameTab` and `toggleSingleScreen` in the cheatsheet  ·  ✅ SHIPPED (`dfd0412`)

**Severity:** discoverability gap · **Effort:** ~10 min

Both are in `DEFAULT_HOTKEYS` but absent from `ACTION_CATEGORIES`
(`hotkeys.ts:260‑311`), so the in-app Keyboard Shortcuts overlay never shows them.

| Action | Add to category | Where |
|---|---|---|
| `renameTab` (⌘L) | `tabs` ("Tabs & panes") | `hotkeys.ts:289` actions array |
| `toggleSingleScreen` (F12) | `layout` ("Window layout") | `hotkeys.ts:294` actions array |

Also add a guard test (agreed): assert `ACTION_CATEGORIES` (flattened, including
`families`) covers every key of `DEFAULT_HOTKEYS`, so this class of omission
can't reappear.

**As built:** `renameTab` added to `tabs`, `toggleSingleScreen` added to
`layout`. Guard test in `src/renderer/hotkeys.test.ts` asserts the flattened
`ACTION_CATEGORIES` (including `families`) covers every `DEFAULT_HOTKEYS` key
with no duplicates. The modifier-order half of Fix 4 (`formatBindingGlyphs` +
backends summary) shipped in this same commit — see below.

> Footgun encountered: `hotkeys.ts` stores glyphs as `\uXXXX` escapes, so an
> Edit using literal glyph chars in `old_string` silently fails to match.
> Edit the surrounding glyph-free lines, or match the `\u` escapes exactly.

---

## Fix 4 — Show shortcut hints in tooltips where a hotkey exists  ·  ✅ SHIPPED (`dfd0412` + `277130e`)

**Severity:** polish, broad surface · **Effort estimated ~1–2 hr; actual ~15 min**
— most candidate buttons already passed `action`, so the only missing hints were
the two Settings buttons. The bulk of the work was the modifier-order fix.

The `Tooltip` component already supports a shortcut hint (used well by the New
Agent/Chat tab button, `TerminalPanel.tsx:511`); most other buttons just don't
pass it.

**Modifier order (applies everywhere shortcuts are shown):** use the macOS HIG
order ⌃ ⌥ ⇧ ⌘ — i.e. **Shift before Cmd** (`⇧⌘E`, not `⌘⇧E`). `bindingToString`
(`hotkeys.ts:179`) already emits Ctrl→Alt→Shift→Cmd, but `formatBindingGlyphs`
(`hotkeys.ts:157`) renders tokens in input order and the hardcoded family
summaries (`hotkeys.ts:267,277`) show `⌘ ⇧ …`. Fix both: have
`formatBindingGlyphs` reorder to canonical order, and rewrite the summaries to
`⇧⌘ 1 … ⇧⌘ 9`.

**Approach:**
1. Confirm the `Tooltip` API for the shortcut hint (prop vs. composed glyph
   string). Reuse `formatBindingGlyphs` (with the ordering fix above) so display
   is consistent (`⇧⌘E` style) and respects user rebinds via `resolveHotkeys`.
2. Thread the resolved binding into each button's tooltip. Candidate buttons:

| Button (file) | Action | Chord |
|---|---|---|
| New shell tab (`TerminalPanel.tsx`) | `newShellTab` | ⌘T |
| Close tab (`TerminalPanel.tsx`) | `closeTab` | ⌘W |
| Find file (`CollapsedRightPanel.tsx:435`) | `fileQuickOpen` | ⌘P |
| Review changes (`ChangedFilesPanel.tsx:66`, `CollapsedRightPanel.tsx:355`) | `openReview` | ⌥⌘R |
| Open in editor (`AllFilesPanel.tsx:117`, `CollapsedRightPanel.tsx:414`) | `openInEditor` | ⇧⌘E |
| Refresh worktrees (`Sidebar.tsx:308`) | `refreshWorktrees` | ⇧⌘R |
| Command Center (`Sidebar.tsx:512`, `CollapsedSidebar.tsx:161`) | `toggleCommandCenter` | ⇧⌘K |
| Keyboard shortcuts (`Sidebar.tsx:552`) | `hotkeyCheatsheet` | ⇧⌘/ |
| Settings (`Sidebar.tsx:568`, `CollapsedSidebar.tsx:217`) | `openSettings` | ⌘, |
| Collapse/expand left & right sidebar | `toggleSidebar` / `toggleRightColumn` | ⌘B / ⇧⌘B |

**As built:**
- **Modifier order (`dfd0412`):** `formatBindingGlyphs` now collects the mapped
  glyphs and emits modifiers in canonical order `⌃⌥⇧⌘` before the key, so hints
  read `⇧⌘E`. Backends family summary corrected `⌘ ⇧ → ⇧ ⌘`. Covered by new
  ordering tests.
- **Hints (`277130e`):** only the two Settings tooltips were missing `action`;
  added `action="openSettings"` to `Sidebar.tsx` and `CollapsedSidebar.tsx`.
  Audit confirmed every other button in the candidate table already carried its
  `action` prop, so no further edits were needed.

---

## Fix 5 — Flesh out the menu bar  ·  ⛔ DEFERRED — do not start yet

**Status:** parked per review. The notes below are retained for when we pick it
up; no work on this until explicitly unblocked.

**Severity:** discoverability (hotkey-only actions have no menu home) · **Effort:** ~1–2 hr

Wire new `Menu` items to the **existing** renderer signals (same
`transport.sendSignal` → `build-backend.ts` handler pattern). Accelerators
already exist as hotkeys; reuse them so menu and keyboard stay in lockstep. All
edits in `src/main/desktop-shell.ts` (template) + `src/renderer/build-backend.ts`
(handlers) where a signal doesn't exist yet.

**Proposed additions:**
- **File** — tab creation (currently buttons-only): New Chat/Agent Tab · New
  Shell Tab ⌘T · New Browser Tab. *(Resolve ⌘N first — Fix 2.)*
- **View** — layout toggles with no menu presence: Toggle Sidebar ⌘B · Toggle
  Right Sidebar ⇧⌘B · Cycle Worktree Detail ⌘I.
- **Window** — tab cycling next to existing split items: Next Tab ⌃Tab ·
  Previous Tab ⌃⇧Tab · Rename Tab ⌘L.
- **New "Go" menu** (navigation): Next/Previous Worktree ⌘↓/⌘↑ · Switch to
  Worktree 1–9 · Switch to Backend 1–9 ⌘⇧1–9 · Focus Terminal ⌘`.
- **New "Find" menu** (or under Edit): Command Palette ⌘K · Open File… ⌘P ·
  Command Center ⌘⇧K · Review Changes ⌘⌥R.
- **Worktree actions** (new menu or File submenu): New Worktree ⌘N · Refresh
  Worktrees ⌘⇧R · Open PR in Browser ⌘⇧G · Open in Editor ⌘⇧E · Clean Up Old
  Worktrees…
- **Help** — add ⌘⇧/ accelerator to the existing "Keyboard Shortcuts" item.

**Caveats:**
- Each new signal needs a handler in `build-backend.ts` bound to the **local**
  transport (menus only exist in the Electron shell — follow the existing
  comment there).
- Some actions (worktree switch 1–9) are awkward as static menu items; decide
  whether they belong in the menu at all or just in the cheatsheet.

**Verify:** `npm run typecheck` + `npx electron-vite build` + launch (`npm run dev`),
click through each new item, confirm it fires the right action and the
accelerator shows correctly in the menu.

---

## What's left

- **Fix 5** — menu-bar expansion, still deferred (see its section).
- **Manual smoke test for Fix 2** — confirm in a real launch that ⌘N opens New
  Worktree and ⌘⇧R refreshes worktrees (no unit coverage for menu-accelerator
  routing). New Project has no shortcut.

## Sequencing (as executed)

1. **Fix 1** + **Fix 3** → `eb5aa07`, `dfd0412`.
2. **Fix 2** → `a72a190`.
3. **Fix 4** (modifier order + Settings hints) → folded into `dfd0412` + `277130e`.
4. **Fix 5** — deferred; not in scope until unblocked.

## Decisions (settled)
- **Fix 2a:** ⌘N = New Worktree; New Project has no shortcut (interim ⌃N dropped — it never fired).
- **Fix 2b:** drop Force Reload's accelerator so ⇧⌘R = Refresh worktrees.
- **Modifier display order:** macOS HIG ⌃⌥⇧⌘ (Shift before Cmd) everywhere.
- **Right panel naming:** "right sidebar" in all copy.
- **Fix 5:** parked.
