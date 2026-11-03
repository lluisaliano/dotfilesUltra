import importlib.util
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "convert_theme", ROOT / "tools/convert-zed-theme.py"
)
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class ThemeConversionTest(unittest.TestCase):
    def setUp(self):
        self.source = json.loads(
            (ROOT / "themes/sources/warp-one-dark/zed-theme.json").read_text()
        )
        self.theme = json.loads((ROOT / "themes/warp-one-dark.json").read_text())

    def test_terminal_palette_preserves_the_original(self):
        source = self.source["themes"][0]["style"]
        self.assertEqual(self.theme["background"], "#000000")
        self.assertEqual(self.theme["foreground"], source["editor.foreground"])
        self.assertEqual(self.theme["ansi"][1], source["terminal.ansi.red"])
        self.assertEqual(self.theme["ansi"][12], source["terminal.ansi.bright_blue"])
        self.assertEqual(len(self.theme["ansi"]), 16)

    def test_all_herdr_colors_have_a_valid_format(self):
        values = [
            self.theme[key]
            for key in ["background", "foreground", "selection", "cursor"]
        ]
        values += self.theme["ansi"] + list(self.theme["colors"].values())
        self.assertTrue(all(re.fullmatch(r"#[0-9a-f]{6}", value) for value in values))

    def test_conversion_is_reproducible(self):
        self.assertEqual(converter.convert(self.source), self.theme)

    def test_short_hex_colors_are_expanded_and_invalid_colors_are_refused(self):
        self.assertEqual(converter.color("#222"), "#222222")
        self.assertEqual(converter.color("#AbC"), "#aabbcc")
        with self.assertRaises(ValueError):
            converter.color("invalid")


if __name__ == "__main__":
    unittest.main()
