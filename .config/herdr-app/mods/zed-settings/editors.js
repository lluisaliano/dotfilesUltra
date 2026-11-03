// Editor detection, a copy of the one in mods/zed-file/file.js (mods cannot import each other): keep both in step.

export const EDITORS = [
  { cmd: "code", label: "VS Code" },
  { cmd: "code-insiders", label: "VS Code Insiders" },
  { cmd: "cursor", label: "Cursor" },
  { cmd: "windsurf", label: "Windsurf" },
  { cmd: "zed", label: "Zed" },
  { cmd: "zeditor", label: "Zed" },
  { cmd: "subl", label: "Sublime Text" },
  { cmd: "idea", label: "IntelliJ IDEA" },
  { cmd: "webstorm", label: "WebStorm" },
  { cmd: "pycharm", label: "PyCharm" },
  { cmd: "goland", label: "GoLand" },
  { cmd: "rustrover", label: "RustRover" },
  { cmd: "kate", label: "Kate" },
  { cmd: "gedit", label: "gedit" },
  { cmd: "xed", label: "Xed" },
  { cmd: "mousepad", label: "Mousepad" },
];

// A `sh -c` script that prints the path of each editor found, in list order.
export const detectScript = () =>
  EDITORS.map((e) => `command -v ${e.cmd}`).join("; ");

// Turns the script's output into the installed editors; two commands for one editor list it once.
export function parseFound(stdout) {
  const found = new Set(
    String(stdout)
      .split("\n")
      .filter((line) => line.startsWith("/"))
      .map((line) => line.split("/").pop()),
  );
  const seen = new Set();
  return EDITORS.filter(
    (e) => found.has(e.cmd) && !seen.has(e.label) && seen.add(e.label),
  );
}
