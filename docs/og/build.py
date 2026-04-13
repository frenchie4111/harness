#!/usr/bin/env python3
"""Regenerate docs/og-image.png from template.html.

Usage: python3 docs/og/build.py
Requires Google Chrome at the standard macOS path.
"""
import base64
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.dirname(HERE)
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def data_uri(path: str) -> str:
    with open(path, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()


def render(template_name: str, output_name: str, replacements: dict) -> None:
    with open(os.path.join(HERE, template_name)) as f:
        html = f.read()
    for key, value in replacements.items():
        html = html.replace(key, value)

    with tempfile.TemporaryDirectory() as tmp:
        rendered = os.path.join(tmp, "rendered.html")
        with open(rendered, "w") as f:
            f.write(html)
        out = os.path.join(DOCS, output_name)
        subprocess.run(
            [
                CHROME,
                "--headless",
                "--disable-gpu",
                "--hide-scrollbars",
                "--window-size=1200,630",
                f"--screenshot={out}",
                f"file://{rendered}",
            ],
            check=True,
            stderr=subprocess.DEVNULL,
        )
        print(f"wrote {out}")


def main() -> int:
    icon = data_uri(os.path.join(DOCS, "icon.png"))
    shot = data_uri(os.path.join(DOCS, "screenshot.png"))

    render("template.html", "og-image.png", {
        "ICON_DATA_URI": icon,
        "SHOT_DATA_URI": shot,
    })
    render("guide-template.html", "guide-og-image.png", {
        "ICON_DATA_URI": icon,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
