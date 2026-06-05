---
name: harness-browser
description: Drive Harness's embedded browser tabs to verify UI changes, debug a rendered page, click through a flow, or inspect a dev server. Use when the user mentions a browser, a URL, the rendered UI, clicking/typing in a page, taking a screenshot, or verifying a web change works.
---

# Browser tabs in Harness

Harness embeds browser tabs alongside your terminal. They're scoped to the current worktree and driven by the `harness-control` MCP tools. Prefer these over blind `curl`/`fetch` or shelling out to `open <url>` — `curl` can't render JS or inspect DOM state, and `open` launches the user's default browser outside Harness where you can't see what happened.

## Click targeting workflow

**Prefer `get_tab_clickables` → match by role + name → call `click_tab(cx, cy)`** for anything you want to click. It's far cheaper than a screenshot + vision pass and far more reliable for real DOM targets.

The clickables snapshot is:
- In-viewport only — if the target isn't there, `scroll_tab` first then re-snapshot
- Capped at 500 items
- Includes elements inside open shadow roots
- Returns `{role, name, cx, cy, w, h}` with the click center already computed

Reserve `screenshot_tab` for:
- Confirming a click had the visual effect you wanted
- Targets without accessible names (canvas/SVG/images) where clickables can't help

Default screenshot format is JPEG quality 70 (context-efficient). Ask for `format: 'png'` only when lossless matters. Screenshot dimensions match the CSS viewport, so any coords you read off a screenshot can be passed straight to `click_tab`.

## Typing into fields

`click_tab` on the field first to focus it, then `type_tab`. `type_tab` also accepts a `key` arg (`Enter`, `Tab`, `Backspace`, `ArrowDown`, …) for submitting forms or navigating menus.

## Tools at a glance

- `create_browser_tab` — open a new tab in this worktree (optionally navigating to a URL)
- `list_browser_tabs`, `get_tab_url`, `get_tab_dom`, `get_tab_console_logs` — inspect
- `navigate_tab`, `back_tab`, `forward_tab`, `reload_tab` — drive
- `get_tab_clickables`, `click_tab`, `type_tab`, `scroll_tab`, `show_cursor` — interact
- `screenshot_tab` — visual verification
