"""Run with: python3 -m unittest discover -s tests."""

import configparser
import importlib.util
import json
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cava_module", ROOT / "scripts/cava.py")
cava = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cava)


class CavaTests(unittest.TestCase):
    def test_gradient_and_bar_heights(self):
        frame = json.loads(cava.render_frame(list(range(8)) * 2))
        spans = list(ET.fromstring(f"<root>{frame['text']}</root>"))
        self.assertEqual(len(spans), 16)
        self.assertEqual(spans[0].attrib["foreground"], "#3d9bff")
        self.assertEqual(spans[-1].attrib["foreground"], "#be69ff")
        self.assertEqual("".join(span.text for span in spans), cava.GLYPHS * 2)
        self.assertEqual(len({span.attrib["foreground"] for span in spans}), 16)
        self.assertEqual(frame["class"], "playing")

    def test_silence_hides_the_module(self):
        frame = json.loads(cava.render_frame([0] * 16))
        self.assertEqual(frame["class"], "silent")
        self.assertEqual(frame["text"], "")

    def test_audio_resumes_after_silence(self):
        silent = json.loads(cava.render_frame([0] * 16))
        playing = json.loads(cava.render_frame([1] * 16))
        self.assertEqual(silent["text"], "")
        self.assertEqual(playing["class"], "playing")
        self.assertEqual(playing["text"].count("<span"), 16)

    def test_invalid_frames_and_clamping(self):
        with self.assertRaises(ValueError):
            cava.render_frame([1, 2])
        text = json.loads(cava.render_frame([-1, 99] * 8))["text"]
        spans = ET.fromstring(f"<root>{text}</root>")
        self.assertEqual("".join(span.text for span in spans), "▁█" * 8)

    def test_capture_config_matches_renderer(self):
        config = configparser.ConfigParser()
        config.read(ROOT / "cava.ini")
        self.assertEqual(config.getint("general", "bars"), cava.BAR_COUNT)
        self.assertEqual(
            config.getint("output", "ascii_max_range"), len(cava.GLYPHS) - 1
        )
        self.assertEqual(config.getint("output", "bar_delimiter"), ord(";"))
        self.assertEqual(config.getint("output", "frame_delimiter"), ord("\n"))


if __name__ == "__main__":
    unittest.main()
