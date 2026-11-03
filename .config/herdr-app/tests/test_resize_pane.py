import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "resize_pane", Path(__file__).resolve().parents[1] / "tools/resize-pane.py"
)
resize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resize)


class ResizeTests(unittest.TestCase):
    def setUp(self):
        self.root = {
            "type": "row",
            "id": "tab",
            "children": [
                {"id": "left", "size": {"weight": 0.5}},
                {
                    "type": "column",
                    "id": "right",
                    "size": {"weight": 0.5},
                    "children": [{"id": "top"}, {"id": "bottom"}],
                },
            ],
        }

    def test_width_finds_outer_split(self):
        self.assertEqual(
            resize.resize_target(self.root, "top", "right"),
            {"id": "right", "weight": 0.6},
        )
        self.assertLess(resize.resize_target(self.root, "top", "left")["weight"], 0.5)

    def test_height_uses_nearest_split(self):
        self.assertEqual(
            resize.resize_target(self.root, "top", "down"), {"id": "top", "weight": 1.2}
        )
        self.assertLess(resize.resize_target(self.root, "bottom", "up")["weight"], 1)

    def test_missing_axis_or_focus_is_noop(self):
        self.assertIsNone(resize.resize_target(self.root, "left", "up"))
        self.assertIsNone(resize.resize_target(self.root, "absent", "right"))
        self.root["children"][1]["hidden"] = True
        self.assertIsNone(resize.resize_target(self.root, "left", "right"))

    def test_fixed_size_and_minimum(self):
        self.root["children"][0]["size"] = {"px": 50}
        self.assertEqual(
            resize.resize_target(self.root, "left", "left"), {"id": "left", "px": 40}
        )
        self.assertEqual(resize.resize_target(self.root, "left", "right")["px"], 90)


if __name__ == "__main__":
    unittest.main()
