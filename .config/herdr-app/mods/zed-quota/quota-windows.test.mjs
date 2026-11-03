import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWindows } from "./quota-windows.js";

const windows = ["gemini_5h", "gemini_weekly", "claude_gpt_5h", "claude_gpt_weekly"]
  .map(id => ({ id, kind: id.endsWith("weekly") ? "weekly" : "session" }));
const provider = { id: "agy", windows };

test("existing settings and enabled option preserve all windows", () => {
  assert.deepEqual(visibleWindows(provider, {}), windows);
  assert.deepEqual(visibleWindows(provider, { agyClaudeGpt: true }), windows);
});

test("disabled option hides only Claude/GPT without changing cached data", () => {
  assert.deepEqual(visibleWindows(provider, { agyClaudeGpt: false }).map(w => w.id),
    ["gemini_5h", "gemini_weekly"]);
  assert.equal(provider.windows.length, 4);
  assert.deepEqual(visibleWindows(provider, { agyClaudeGpt: true }), windows);
});

test("other providers and unrelated future windows are unaffected", () => {
  assert.deepEqual(visibleWindows({ id: "claude", windows }, { agyClaudeGpt: false }), windows);
  const future = { id: "agy", windows: [{ id: "new_model" }, { kind: "weekly" }] };
  assert.deepEqual(visibleWindows(future, { agyClaudeGpt: false }), future.windows);
});

test("category filters still apply independently after the provider filter", () => {
  assert.deepEqual(visibleWindows(provider, { agyClaudeGpt: false })
    .filter(w => w.kind === "weekly").map(w => w.id), ["gemini_weekly"]);
});

import { stripWindows } from "./quota-windows.js";

const grok = { id: "grok", windows: ["credits", "product:grok_build", "product:chat"].map(id => ({ id, kind: "weekly" })) };

test("strip keeps every window when no allowlist is set for the provider", () => {
  assert.deepEqual(stripWindows(grok, {}), grok.windows);
  assert.deepEqual(stripWindows(grok, { windows: {} }), grok.windows);
  assert.deepEqual(stripWindows(grok, { windows: { claude: ["five_hour"] } }), grok.windows);
});

test("strip shows only the allowlisted windows of that provider", () => {
  assert.deepEqual(stripWindows(grok, { windows: { grok: ["credits"] } }).map(w => w.id), ["credits"]);
  assert.deepEqual(stripWindows(grok, { windows: { grok: ["product:chat", "credits"] } }).map(w => w.id),
    ["credits", "product:chat"]);
});

test("an empty or unmatched allowlist is ignored instead of hiding the provider", () => {
  assert.deepEqual(stripWindows(grok, { windows: { grok: [] } }), grok.windows);
  assert.deepEqual(stripWindows(grok, { windows: { grok: ["nope"] } }), grok.windows);
});

test("the strip filter does not change the popup list or cached data", () => {
  const options = { windows: { grok: ["credits"] } };
  assert.equal(visibleWindows(grok, options).length, 3);
  stripWindows(grok, options);
  assert.equal(grok.windows.length, 3);
});

test("the strip filter still applies the provider filter first", () => {
  const agy = { id: "agy", windows: [{ id: "gemini_5h" }, { id: "claude_gpt_5h" }] };
  assert.deepEqual(stripWindows(agy, { agyClaudeGpt: false, windows: { agy: ["gemini_5h", "claude_gpt_5h"] } }).map(w => w.id), ["gemini_5h"]);
});
