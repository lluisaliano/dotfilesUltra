"""Convert the requested Zed theme's supported colors into a Herdr theme."""

import json
import re
import sys
from pathlib import Path


def color(value):
    value = str(value).lstrip("#")
    if len(value) == 3:
        value = "".join(character * 2 for character in value)
    if not re.fullmatch("[0-9a-fA-F]{6}", value):
        raise ValueError(f"Unsupported theme color: {value}")
    return "#" + value.lower()


def convert(family):
    source = family["themes"][0]["style"]
    foreground = source.get("terminal.foreground") or source["editor.foreground"]
    accent = source.get("text.accent") or source["terminal.ansi.blue"]
    muted = source.get("text.muted") or source["syntax"]["comment"]["color"]
    background = source["terminal.background"]
    names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
    ansi = [color(source[f"terminal.ansi.{name}"]) for name in names]
    ansi += [color(source[f"terminal.ansi.bright_{name}"]) for name in names]
    panel = {
        "background": background,
        "canvas": source["background"],
        "chrome": source["status_bar.background"],
        "surface": source["surface.background"],
        "popover": source["elevated_surface.background"],
        "raised": source["element.background"],
        "hover": source["element.hover"],
        "selected": source["element.selected"],
        "border": source["border"],
        "input": source["border.focused"],
        "foreground": foreground,
        "muted": muted,
        "dim": muted,
        "accent": accent,
        "accent_foreground": background,
        "solid": accent,
        "solid_foreground": background,
        "selection": source["element.selected"],
        "working": accent,
        "blocked": source["warning"],
        "done": source["created"],
        "idle": muted,
        "unknown": muted,
    }
    return {
        "background": color(background),
        "foreground": color(foreground),
        "selection": color(source["element.selected"]),
        "cursor": color(foreground),
        "ansi": ansi,
        "colors": {key: color(value) for key, value in panel.items()},
    }


if __name__ == "__main__":
    Path(sys.argv[2]).write_text(
        json.dumps(convert(json.loads(Path(sys.argv[1]).read_text())), indent=2) + "\n"
    )
