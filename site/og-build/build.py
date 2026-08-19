#!/usr/bin/env python3
"""Regenerate site/public/og-image.png + guide-og-image.png from the templates.

Usage: python3 site/og-build/build.py

Renders with Google Chrome if it is installed, otherwise falls back to the
Electron in node_modules (same Chromium, and it is already a dependency).
Set OG_CHROME to point at any other Chrome-like binary.
"""
import base64
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.abspath(os.path.join(HERE, os.pardir))
REPO = os.path.abspath(os.path.join(SITE, os.pardir))
PUBLIC = os.path.join(SITE, "public")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WIDTH, HEIGHT = 1200, 630


def data_uri(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in (".jpg", ".jpeg"):
        mime = "image/jpeg"
    elif ext == ".webp":
        mime = "image/webp"
    else:
        mime = "image/png"
    with open(path, "rb") as f:
        return f"data:{mime};base64," + base64.b64encode(f.read()).decode()


def inline_svg(path: str) -> str:
    """The mark, comment stripped, for embedding straight into the template."""
    with open(path) as f:
        return re.sub(r"<!--.*?-->", "", f.read(), flags=re.S).strip()


def resolve_renderer():
    """Return (kind, binary). kind is 'chrome' or 'electron'."""
    explicit = os.environ.get("OG_CHROME")
    if explicit:
        return "chrome", explicit
    if os.path.exists(CHROME):
        return "chrome", CHROME

    # Git worktrees have no node_modules of their own, so fall back to the
    # main checkout that owns the shared .git directory.
    roots = [REPO]
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=REPO, check=True, capture_output=True, text=True,
        ).stdout.strip()
        roots.append(os.path.dirname(common))
    except (subprocess.CalledProcessError, OSError):
        pass

    for root in roots:
        electron = os.path.join(
            root, "node_modules", "electron", "dist", "Electron.app",
            "Contents", "MacOS", "Electron",
        )
        if os.path.exists(electron):
            return "electron", electron

    sys.exit(
        "No renderer found. Install Google Chrome, run `npm install` at the repo\n"
        "root so node_modules/electron exists, or set OG_CHROME to a Chromium binary."
    )


def screenshot(kind: str, binary: str, page: str, out: str) -> None:
    if kind == "chrome":
        cmd = [
            binary, "--headless", "--disable-gpu", "--hide-scrollbars",
            f"--window-size={WIDTH},{HEIGHT}", f"--screenshot={out}", f"file://{page}",
        ]
    else:
        cmd = [
            binary, os.path.join(HERE, "render.js"),
            page, out, str(WIDTH), str(HEIGHT),
        ]
    env = {**os.environ, "ELECTRON_RUN_AS_NODE": ""}
    env.pop("ELECTRON_RUN_AS_NODE")
    subprocess.run(cmd, check=True, stderr=subprocess.DEVNULL, env=env)


def render(renderer, template_name: str, output_name: str, replacements: dict) -> None:
    with open(os.path.join(HERE, template_name)) as f:
        html = f.read()
    for key, value in replacements.items():
        html = html.replace(key, value)

    with tempfile.TemporaryDirectory() as tmp:
        page = os.path.join(tmp, "rendered.html")
        with open(page, "w") as f:
            f.write(html)
        out = os.path.join(PUBLIC, output_name)
        screenshot(renderer[0], renderer[1], page, out)
        print(f"wrote {out}")


def main() -> int:
    renderer = resolve_renderer()
    print(f"rendering with {renderer[0]}: {renderer[1]}")

    mark = inline_svg(os.path.join(PUBLIC, "mark.svg"))
    shot = data_uri(os.path.join(PUBLIC, "announcements/img/chat-mode.webp"))

    render(renderer, "template.html", "og-image.png", {
        "MARK_SVG": mark,
        "SHOT_DATA_URI": shot,
    })
    render(renderer, "guide-template.html", "guide-og-image.png", {
        "MARK_SVG": mark,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
