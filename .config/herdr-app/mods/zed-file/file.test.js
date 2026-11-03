import assert from "node:assert/strict";
import { test } from "node:test";
import { languageFor, prepare, shortPath, MAX_CHARS } from "./file.js";

test("languageFor maps extensions to the editor's languages", () => {
  assert.equal(languageFor("a/b/app.ts"), "js");
  assert.equal(languageFor("x.tsx"), "js");
  assert.equal(languageFor("Cargo.toml"), "yaml");
  assert.equal(languageFor("README.md"), "md");
  assert.equal(languageFor("main.rs"), "rs");
  assert.equal(languageFor("Makefile"), "txt");
  assert.equal(languageFor(".gitignore"), "txt");
});

test("prepare reports missing, binary, empty and truncated files", () => {
  assert.deepEqual(prepare(null), { kind: "missing", text: "" });
  assert.deepEqual(prepare("a\0b"), { kind: "binary", text: "" });
  assert.deepEqual(prepare(""), { kind: "ok", text: "", truncated: false });
  assert.deepEqual(prepare("hello\n"), { kind: "ok", text: "hello\n", truncated: false });
  const big = prepare("x".repeat(MAX_CHARS + 10));
  assert.equal(big.kind, "ok");
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, MAX_CHARS);
});

test("shortPath shows the home folder as ~", () => {
  assert.equal(shortPath("/home/me/dev/a.md", "/home/me"), "~/dev/a.md");
  assert.equal(shortPath("/etc/hosts", "/home/me"), "/etc/hosts");
  assert.equal(shortPath("/home/men/a.md", "/home/me"), "/home/men/a.md");
  assert.equal(shortPath("/home/me", "/home/me"), "~");
});

import { EDITORS, detectScript, parseFound, launchArgs } from "./file.js";

test("parseFound keeps the editors whose command was found, in list order", () => {
  const found = parseFound("/usr/bin/zed\n/usr/bin/code\nnot-a-path\n");
  assert.deepEqual(found.map(e => e.cmd), ["code", "zed"]);
  assert.equal(found[0].label, "VS Code");
  assert.deepEqual(parseFound(""), []);
});

test("detectScript checks every known editor command once", () => {
  for (const e of EDITORS) assert.ok(detectScript().includes(e.cmd), e.cmd);
});

test("launchArgs detaches the editor and passes the path untouched", () => {
  const args = launchArgs("code", "/a b/it's.js");
  assert.equal(args[0], "-c");
  assert.deepEqual(args.slice(2), ["code", "/a b/it's.js"]);
  assert.match(args[1], /nohup "\$0" "\$@"/);
});

import { editorIcon, preferredEditor } from "./file.js";

test("editorIcon picks the Material icon by theme, or null", () => {
  assert.equal(editorIcon("code", true), "mods/zed-file/icons/vscode.svg");
  assert.equal(editorIcon("code-insiders", false), "mods/zed-file/icons/vscode.svg");
  assert.equal(editorIcon("cursor", true), "mods/zed-file/icons/cursor.svg");
  assert.equal(editorIcon("cursor", false), "mods/zed-file/icons/cursor_light.svg");
  assert.equal(editorIcon("zed", true), "mods/zed-file/icons/zed.png");
  assert.equal(editorIcon("zeditor", false), "mods/zed-file/icons/zed.png");
  assert.equal(editorIcon("kate", true), null);
});

test("preferredEditor honours the saved choice, defaults to Zed, then falls back", () => {
  const found = [{ cmd: "code", label: "VS Code" }, { cmd: "zeditor", label: "Zed" }];
  assert.equal(preferredEditor(found, undefined).cmd, "zeditor");
  assert.equal(preferredEditor(found, "VS Code").cmd, "code");
  assert.equal(preferredEditor(found, "Cursor").cmd, "zeditor");
  assert.equal(preferredEditor([{ cmd: "kate", label: "Kate" }], "Zed").cmd, "kate");
  assert.equal(preferredEditor([], "Zed"), null);
});
