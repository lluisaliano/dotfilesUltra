"""Stream Cava's spectrum to Waybar with a blue-to-purple Pango gradient."""

import json
import signal
import subprocess
from pathlib import Path

BAR_COUNT = 16
GLYPHS = "▁▂▃▄▅▆▇█"
BLUE = (61, 155, 255)
PURPLE = (190, 105, 255)
CONFIG = Path(__file__).resolve().parents[1] / "cava.ini"


def bar_color(index):
    ratio = index / (BAR_COUNT - 1)
    channels = [
        round(start + (end - start) * ratio) for start, end in zip(BLUE, PURPLE)
    ]
    return "#" + "".join(f"{channel:02x}" for channel in channels)


def render_frame(values):
    if len(values) != BAR_COUNT:
        raise ValueError(f"Expected {BAR_COUNT} bars, received {len(values)}")
    if not any(value > 0 for value in values):
        return json.dumps({"text": "", "class": "silent"})
    text = "".join(
        f'<span foreground="{bar_color(index)}">{GLYPHS[max(0, min(7, value))]}</span>'
        for index, value in enumerate(values)
    )
    return json.dumps({"text": text, "class": "playing" if any(values) else "silent"})


def stop(_signum, _frame):
    raise SystemExit(0)


def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(render_frame([0] * BAR_COUNT), flush=True)
    process = subprocess.Popen(
        ["cava", "-p", str(CONFIG)], stdout=subprocess.PIPE, text=True
    )
    try:
        for line in process.stdout:
            try:
                values = [int(value) for value in line.strip().rstrip(";").split(";")]
                output = render_frame(values)
            except ValueError:
                continue
            print(output, flush=True)
        return process.wait() or 1
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        pass
