"""Resize a focused pane through Herdr commands; core documents are read only."""

import json
import subprocess
import sys


def resize_target(root, pane, direction):
    """Find the closest split on the requested axis, including nested splits."""
    axis = "row" if direction in ("left", "right") else "column"
    grow = direction in ("right", "down")

    def visit(node):
        if node.get("id") == pane:
            return True, None
        children = [c for c in node.get("children", []) if not c.get("hidden")]
        for child in children:
            found, target = visit(child)
            if not found:
                continue
            if target is not None:
                return True, target
            if node.get("type") == axis and len(children) > 1:
                size = child.get("size", {})
                if "px" in size:
                    value = max(40, size["px"] + (40 if grow else -40))
                    return True, {"id": child["id"], "px": value}
                value = size.get("weight", 1) * (1.2 if grow else 1 / 1.2)
                return True, {"id": child["id"], "weight": max(0.05, min(20, value))}
            return True, None
        return False, None

    return visit(root)[1]


def main(args):
    direction, pane, tab, machine = args
    params = {"name": "herdr-app"}
    if machine:
        params["on"] = machine
    request = {"jsonrpc": "2.0", "id": 1, "method": "doc.get", "params": params}
    result = subprocess.run(
        ["hc", "connect"],
        input=json.dumps(request) + "\n",
        text=True,
        capture_output=True,
        timeout=3,
        check=True,
    )
    document = json.loads(result.stdout)["result"]["value"]
    prefix = machine + "/" if machine else ""
    local_pane = pane.removeprefix(prefix) if prefix else pane
    local_tab = tab.removeprefix(prefix) if prefix else tab
    for space in document.get("spaces", []):
        for item in space.get("tabs", []):
            if item["id"] != local_tab:
                continue
            target = resize_target(item["root"], local_pane, direction)
            if target:
                target["id"] = prefix + target["id"]
                subprocess.run(
                    ["herdr-app", "do", "layout.resize", json.dumps(target)],
                    capture_output=True,
                    timeout=3,
                    check=True,
                )
            return


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # Unavailable machines and missing splits are quiet shortcut no-ops.
        pass
