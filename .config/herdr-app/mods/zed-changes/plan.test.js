import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatus, stagePlan, stageAllPlan, commitPlan, diffTarget, branchLabel, tooManyChanges, MAX_CHANGES, parseBranches, switchArgs, BRANCH_FORMAT, deleteArgs, canDelete, deletedNote, filterBranches, canCreate, createArgs, unpushedArgs, parseCount, listHeight, LIST_MAX, syncArgs, needsRemote, isForce, parseAheadBehind, primaryAction, summarize } from "./plan.js";

test("status lines split the index from the work tree", () => {
  assert.deepEqual(parseStatus(" M src/a.js\0?? src/b.js\0M  src/c.js\0"), [
    { path: "src/a.js", xy: " M", staged: false },
    { path: "src/b.js", xy: "??", staged: false },
    { path: "src/c.js", xy: "M ", staged: true },
  ]);
});

test("stage all adds everything, and a staged file is unstaged", () => {
  assert.deepEqual(stageAllPlan(), ["add", "-A"]);
  assert.deepEqual(stagePlan({ path: "src/a.js", xy: " M" }), ["add", "--", "src/a.js"]);
  assert.deepEqual(stagePlan({ path: "src/c.js", xy: "M " }), ["restore", "--staged", "--", "src/c.js"]);
});

test("commit tracked needs a message and something staged", () => {
  const files = [{ path: "src/a.js", xy: " M", staged: false }];
  assert.deepEqual(commitPlan("  ", files), { error: "Enter a commit message." });
  assert.deepEqual(commitPlan("fix tabs", files), { error: "Nothing staged." });
  assert.deepEqual(commitPlan(" fix tabs ", [{ path: "src/c.js", xy: "M ", staged: true }]), {
    args: ["commit", "-m", "fix tabs"],
  });
});

test("diffTarget keeps a valid selection, else falls back to the first file", () => {
  const files = [{ path: "a.js" }, { path: "b.js" }];
  assert.equal(diffTarget("b.js", files), "b.js");
  assert.equal(diffTarget(null, files), "a.js");
  assert.equal(diffTarget("gone.js", files), "a.js");
  assert.equal(diffTarget(null, []), null);
});

test("branchLabel names an unborn branch instead of calling it detached", () => {
  assert.equal(branchLabel("main", true), "main");
  assert.equal(branchLabel("master", false), "master · no commits yet");
  assert.equal(branchLabel("", true), "detached");
  assert.equal(branchLabel(null, false), "detached");
});

test("tooManyChanges flags the home folder and very large change sets", () => {
  assert.equal(tooManyChanges("/home/u", "/home/u", 3), true);
  assert.equal(tooManyChanges("/home/u/proj", "/home/u", 3), false);
  assert.equal(tooManyChanges("/home/u/proj", "/home/u", MAX_CHANGES), false);
  assert.equal(tooManyChanges("/home/u/proj", "/home/u", MAX_CHANGES + 1), true);
  assert.equal(tooManyChanges("/srv/x", null, 0), false);
});

test("parseBranches lists local branches, then remote-only ones, with author, age and subject", () => {
  const out = [
    " \trefs/heads/feat/x\tAna\t3 months ago\tchore: guitar",
    "*\trefs/heads/main\tBob\t2 days ago\tfeat(social): add reel",
    " \trefs/remotes/origin/HEAD\tBob\t2 days ago\tx", " \trefs/remotes/origin/main\tBob\t2 days ago\tx",
    " \trefs/remotes/origin/hotfix\tCy\t1 hour ago\tfix: a\tb", " \trefs/remotes/upstream/feat/x\tA\t1 day ago\ty", " \trefs/tags/v1\tA\t1 day ago\ty",
  ].join("\n");
  assert.deepEqual(parseBranches(out), [
    { name: "feat/x", current: false, remote: null, author: "Ana", age: "3 months ago", subject: "chore: guitar" },
    { name: "main", current: true, remote: null, author: "Bob", age: "2 days ago", subject: "feat(social): add reel" },
    { name: "hotfix", current: false, remote: "origin", author: "Cy", age: "1 hour ago", subject: "fix: a\tb" },
  ]);
  assert.deepEqual(parseBranches(""), []);
});

test("switchArgs switches by name and BRANCH_FORMAT asks for HEAD and the full ref", () => {
  assert.deepEqual(switchArgs("feat/x"), ["switch", "feat/x"]);
  assert.deepEqual(switchArgs("-weird"), ["switch", "--", "-weird"]);
  assert.match(BRANCH_FORMAT, /%\(HEAD\)/);
  assert.match(BRANCH_FORMAT, /%\(refname\)/);
});

test("deleteArgs deletes without asking git to refuse unmerged branches", () => {
  assert.deepEqual(deleteArgs("wip"), ["branch", "-D", "--", "wip"]);
  assert.deepEqual(deleteArgs("-x"), ["branch", "-D", "--", "-x"]);
});

test("deletedNote tells how to get the branch back", () => {
  assert.equal(deletedNote("wip", "Deleted branch wip (was 8e8bcb7).\n"), "Deleted wip. To restore it: git branch wip 8e8bcb7");
  assert.equal(deletedNote("wip", ""), "Deleted wip.");
});

test("filterBranches matches names and remotes, ignoring case", () => {
  const list = [{ name: "main", remote: null }, { name: "Feat/Wait", remote: null }, { name: "hotfix", remote: "origin" }];
  assert.equal(filterBranches(list, "").length, 3);
  assert.deepEqual(filterBranches(list, "feat").map(b => b.name), ["Feat/Wait"]);
  assert.deepEqual(filterBranches(list, "origin/hot").map(b => b.name), ["hotfix"]);
});

test("canCreate needs a new, option-free name; createArgs switches to it", () => {
  const list = [{ name: "main", remote: null }, { name: "hotfix", remote: "origin" }];
  assert.equal(canCreate(list, "new-thing"), true);
  assert.equal(canCreate(list, "  "), false);
  assert.equal(canCreate(list, "main"), false);
  assert.equal(canCreate(list, "-x"), false);
  assert.equal(canCreate(list, "hotfix"), false); // already there on the remote: switch to it instead
  assert.deepEqual(createArgs("new-thing"), ["switch", "-c", "new-thing"]);
});

test("only local branches other than the current one can be deleted", () => {
  assert.equal(canDelete({ name: "a", current: false, remote: null }), true);
  assert.equal(canDelete({ name: "a", current: true, remote: null }), false);
  assert.equal(canDelete({ name: "a", current: false, remote: "origin" }), false);
});

test("unpushedArgs counts the commits of a branch that no remote has; parseCount reads it", () => {
  assert.deepEqual(unpushedArgs("wip"), ["rev-list", "--count", "wip", "--not", "--remotes"]);
  assert.equal(parseCount("3\n"), 3);
  assert.equal(parseCount("0\n"), 0);
  assert.equal(parseCount(""), 0);
  assert.equal(parseCount("junk"), 0);
});

test("listHeight sizes the scrolling list: headings plus rows, capped", () => {
  const l = { remote: null }, r = { remote: "origin" };
  assert.equal(listHeight([]), 0);
  assert.equal(listHeight([l]), 30 + 52);
  assert.equal(listHeight([l, r]), 30 + 52 + 30 + 52);
  assert.equal(listHeight(Array(20).fill(l)), LIST_MAX);
  assert.equal(listHeight([l], true), 30 + 52 + 40); // + the "Create branch" row
});

test("syncArgs builds the git command for each menu entry", () => {
  assert.deepEqual(syncArgs("fetch", {}), ["fetch"]);
  assert.deepEqual(syncArgs("fetch-from", { remote: "up" }), ["fetch", "up"]);
  assert.deepEqual(syncArgs("pull", {}), ["pull", "--no-edit"]);
  assert.deepEqual(syncArgs("pull-rebase", {}), ["pull", "--rebase"]);
  assert.deepEqual(syncArgs("push", { upstream: true }), ["push"]);
  assert.deepEqual(syncArgs("push", { upstream: false }), ["push", "--set-upstream", "origin", "HEAD"]);
  assert.deepEqual(syncArgs("push", { upstream: false, remote: "up" }), ["push", "--set-upstream", "up", "HEAD"]);
  assert.deepEqual(syncArgs("push-to", { upstream: true, remote: "up" }), ["push", "up", "HEAD"]);
  assert.deepEqual(syncArgs("push-to", { upstream: false, remote: "up" }), ["push", "--set-upstream", "up", "HEAD"]);
  assert.deepEqual(syncArgs("force-push", { upstream: true }), ["push", "--force-with-lease"]);
  assert.deepEqual(syncArgs("force-push", { upstream: false }), ["push", "--force-with-lease", "--set-upstream", "origin", "HEAD"]);
  assert.equal(syncArgs("rm -rf", {}), null);
});

test("only Fetch From and Push To ask for a remote; only Force Push is a force", () => {
  assert.deepEqual(["fetch", "fetch-from", "pull", "push", "push-to", "force-push"].map(needsRemote), [false, true, false, false, true, false]);
  assert.deepEqual(["push", "force-push"].map(isForce), [false, true]);
});

test("parseAheadBehind reads `rev-list --left-right --count @{upstream}...HEAD`", () => {
  assert.deepEqual(parseAheadBehind("2\t5\n"), { behind: 2, ahead: 5 });
  assert.deepEqual(parseAheadBehind("0\t0"), { behind: 0, ahead: 0 });
  assert.equal(parseAheadBehind(""), null);
  assert.equal(parseAheadBehind("junk"), null);
});

test("primaryAction picks the button next to the branch name", () => {
  const base = { remotes: ["origin"], upstream: true, ahead: 0, behind: 0 };
  assert.equal(primaryAction({ ...base, remotes: [] }), null);
  assert.deepEqual(primaryAction({ ...base, upstream: false }), { op: "push", label: "Publish" });
  assert.deepEqual(primaryAction({ ...base, behind: 2, ahead: 1 }), { op: "pull", label: "Pull ↓2" });
  assert.deepEqual(primaryAction({ ...base, ahead: 3 }), { op: "push", label: "Push ↑3" });
  assert.deepEqual(primaryAction(base), { op: "fetch", label: "Fetch" });
});

test("summarize keeps git's first lines, preferring stderr (where git writes progress)", () => {
  assert.equal(summarize("", ""), "Done");
  assert.equal(summarize("Already up to date.\n", ""), "Already up to date.");
  assert.equal(summarize("x", "To github.com:a/b\n   1a2b..3c4d  main -> main\n"), "To github.com:a/b 1a2b..3c4d  main -> main");
  assert.equal(summarize("", "a\nb\nc\nd\ne"), "a b c");
});
