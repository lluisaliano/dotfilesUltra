import assert from "node:assert/strict";
import { test } from "node:test";
import { newTabId, findOpenTab, rememberTab, pruneTabs } from "./open-tab-logic.js";

test("newTabId finds the one tab that appeared", () => {
  assert.equal(newTabId(["t1", "t2"], ["t1", "t2", "t3"]), "t3");
  assert.equal(newTabId(["t1"], ["t1"]), null);
  assert.equal(newTabId([], []), null);
});

test("findOpenTab returns the file's tab only while that tab still exists", () => {
  const map = { t1: { file: "/a/x.md", icon: "i" }, t2: { file: "/a/y.md", icon: "i" } };
  assert.equal(findOpenTab(map, "/a/y.md", ["t1", "t2"]), "t2");
  assert.equal(findOpenTab(map, "/a/y.md", ["t1"]), null);
  assert.equal(findOpenTab(map, "/a/z.md", ["t1", "t2"]), null);
  assert.equal(findOpenTab(undefined, "/a/z.md", []), null);
});

test("rememberTab and pruneTabs never mutate and drop closed tabs", () => {
  const map = { t1: { file: "/a/x.md", icon: "i" } };
  const next = rememberTab(map, "t2", { file: "/a/y.md", icon: "j" });
  assert.deepEqual(next, { t1: { file: "/a/x.md", icon: "i" }, t2: { file: "/a/y.md", icon: "j" } });
  assert.deepEqual(map, { t1: { file: "/a/x.md", icon: "i" } });
  assert.deepEqual(pruneTabs(next, ["t2"]), { t2: { file: "/a/y.md", icon: "j" } });
  assert.deepEqual(pruneTabs(undefined, ["t1"]), {});
});
