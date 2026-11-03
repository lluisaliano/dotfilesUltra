// Pure helpers for the file tabs (no Herdr imports, so they test outside the app).

export const MAX_CHARS = 400000;

// Extensions the editor has no grammar for, mapped to one it has (as the Files preview does).
const LANG = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
};

const baseName = (path) =>
  String(path ?? "")
    .split(/[\\/]/)
    .pop();

export function languageFor(path) {
  const name = baseName(path),
    dot = name.lastIndexOf(".");
  if (dot < 1) return "txt";
  const ext = name.slice(dot + 1).toLowerCase();
  return LANG[ext] ?? ext;
}

// What to show for the text readTextFile returned (null = gone or unreadable).
export function prepare(text) {
  if (text === null || text === undefined) return { kind: "missing", text: "" };
  if (text.includes("\0")) return { kind: "binary", text: "" };
  if (text.length > MAX_CHARS)
    return { kind: "ok", text: text.slice(0, MAX_CHARS), truncated: true };
  return { kind: "ok", text, truncated: false };
}

export function shortPath(path, home) {
  if (home && path === home) return "~";
  return home && path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
}

// Editors with a command line launcher that can open a file. Terminal editors are left out:
// they need a terminal, not a window of their own.
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

// `sh` arguments that start `cmd` on `file` in the background, so exec returns at once. The path
// is an argument, never part of the script, so quotes and spaces in it are safe.
export const launchArgs = (cmd, file) => [
  "-c",
  'nohup "$0" "$@" >/dev/null 2>&1 &',
  cmd,
  file,
];

// Icons for a few editors: Material Icon Theme's, plus Zed's own app icon. `cursor.svg` is the light grey one for dark themes.
export function editorIcon(cmd, dark) {
  if (cmd === "zed" || cmd === "zeditor") return "mods/zed-file/icons/zed.png";
  const name = cmd.startsWith("code")
    ? "vscode"
    : cmd === "cursor"
      ? dark
        ? "cursor"
        : "cursor_light"
      : cmd === "subl"
        ? "sublime"
        : null;
  return name && `mods/zed-file/icons/${name}.svg`;
}

// The editor the header button opens: the saved choice (by label), else Zed, else the first found.
export function preferredEditor(found, saved) {
  return (
    found.find((e) => e.label === (saved ?? "Zed")) ??
    found.find((e) => e.label === "Zed") ??
    found[0] ??
    null
  );
}
