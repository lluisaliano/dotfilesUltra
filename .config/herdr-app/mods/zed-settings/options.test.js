import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaOptions, toggleHidden, fileOptions, QUOTA_DEFAULTS } from "./options.js";

test("quotaOptions: defaults, then layout props, then saved choices", () => {
  assert.deepEqual(quotaOptions(null, null), QUOTA_DEFAULTS);
  const o = quotaOptions({ hidden: ["cursor"], kinds: { model: true } }, { remaining: true, kinds: { weekly: false } });
  assert.deepEqual(o.hidden, ["cursor"]);
  assert.equal(o.remaining, true);
  assert.deepEqual(o.kinds, { session: true, weekly: false, monthly: true, model: true });
});

test("toggleHidden adds and removes without mutating", () => {
  const h = ["a"];
  assert.deepEqual(toggleHidden(h, "b"), ["a", "b"]);
  assert.deepEqual(toggleHidden(h, "a"), []);
  assert.deepEqual(h, ["a"]);
});

test("fileOptions defaults wrap off", () => {
  assert.deepEqual(fileOptions(null), { wrap: false, editor: "Zed" });
  assert.deepEqual(fileOptions({ wrap: true }), { wrap: true, editor: "Zed" });
});

import { CATEGORIES, staticItems, providerItems, matches, visible, editorItem } from "./options.js";

test("every static item has a category, label and description", () => {
  const ids = CATEGORIES.map(c => c.id);
  for (const item of staticItems()) {
    assert.ok(ids.includes(item.category), item.id);
    assert.ok(item.label && item.description, item.id);
  }
});

test("items read and patch their own store", () => {
  const by = id => staticItems().find(i => i.id === id);
  assert.equal(by("wrap").store, "file");
  assert.deepEqual(by("wrap").patch({ wrap: false }, true), { wrap: true });
  const q = quotaOptions(null, null);
  assert.equal(by("remaining").get(q), false);
  assert.deepEqual(by("remaining").patch(q, true), { remaining: true });
  assert.equal(by("kind-model").get(q), false);
  assert.deepEqual(by("kind-model").patch(q, true).kinds, { session: true, weekly: true, monthly: true, model: true });
});

test("provider items follow `hidden`", () => {
  const [claude] = providerItems([{ id: "claude", label: "Claude" }]);
  const q = quotaOptions(null, { hidden: ["claude"] });
  assert.equal(claude.get(q), false);
  assert.deepEqual(claude.patch(q, true), { hidden: [] });
  assert.deepEqual(claude.patch(quotaOptions(null, null), false), { hidden: ["claude"] });
});

test("antigravity item treats an unset flag as on", () => {
  const items = providerItems([{ id: "agy", label: "Antigravity" }]);
  const agy = items.find(i => i.id === "agy-claude-gpt");
  assert.equal(agy.get(quotaOptions(null, null)), true);
  assert.deepEqual(agy.patch(quotaOptions(null, null), false), { agyClaudeGpt: false });
});

test("matches and visible filter by label and description, across categories", () => {
  const items = [...staticItems(), ...providerItems([{ id: "claude", label: "Claude" }])];
  assert.equal(matches(items[0], ""), true);
  assert.ok(visible(items, "editor", "").every(i => i.category === "editor"));
  const hit = visible(items, "editor", "weekly");
  assert.ok(hit.length > 0 && hit.every(i => /weekly/i.test(i.label + i.description)));
  assert.equal(visible(items, "editor", "zzz").length, 0);
});

test("editorItem is a choice among the installed editors, Zed by default", () => {
  assert.equal(editorItem([]), null);
  const item = editorItem([{ cmd: "code", label: "VS Code" }, { cmd: "zed", label: "Zed" }]);
  assert.equal(item.kind, "choice");
  assert.equal(item.category, "editor");
  assert.deepEqual(item.options, ["VS Code", "Zed"]);
  assert.equal(item.get(fileOptions(null)), "Zed");
  assert.deepEqual(item.patch(fileOptions(null), "VS Code"), { editor: "VS Code" });
});
