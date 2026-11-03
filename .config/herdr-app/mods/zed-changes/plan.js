// Git panel decisions. Commit tracked never stages; that is a separate action.

export function parseStatus(text) {
  return text
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const xy = entry.slice(0, 2);
      return {
        path: entry.slice(3),
        xy,
        staged: xy[0] !== " " && xy[0] !== "?",
      };
    });
}

export function stagePlan(file) {
  if (file.xy[0] !== " " && file.xy[0] !== "?" && file.xy[1] === " ")
    return ["restore", "--staged", "--", file.path];
  return ["add", "--", file.path];
}

export function stageAllPlan() {
  return ["add", "-A"];
}

export function commitPlan(message, files) {
  const text = (message ?? "").trim();
  if (!text) return { error: "Enter a commit message." };
  if (!files.some((file) => file.staged)) return { error: "Nothing staged." };
  return { args: ["commit", "-m", text] };
}

// The file whose diff View Diff shows: the selected one if it still has changes, else the first.
export function diffTarget(selected, files) {
  if (selected && files.some((file) => file.path === selected)) return selected;
  return files[0]?.path ?? null;
}

export const MAX_CHANGES = 5000;

// What the panel calls the current branch. `symbolic` is the branch name from `symbolic-ref` (it
// works before the first commit); `hasCommits` is false for a repository with none yet.
export function branchLabel(symbolic, hasCommits) {
  if (!symbolic) return "detached";
  return hasCommits ? symbolic : `${symbolic} · no commits yet`;
}

// A folder the panel should not list: the home directory (an accidental repository there sees
// everything under it) or more changes than anyone reviews in a side panel.
export function tooManyChanges(root, home, count) {
  return (Boolean(home) && root === home) || count > MAX_CHANGES;
}

// `git for-each-ref` format for the branch picker: "<* or space>\t<full ref>\t<author>\t<age>\t<subject>".
export const BRANCH_FORMAT =
  "%(HEAD)%09%(refname)%09%(authorname)%09%(committerdate:relative)%09%(contents:subject)";

// Local branches (as git sorted them), then remote branches that have no local one yet.
export function parseBranches(text) {
  const local = [],
    remote = [];
  for (const line of String(text).split("\n")) {
    const [head, ref, author = "", age = "", ...subject] = line.split("\t");
    if (!ref) continue;
    const info = { author, age, subject: subject.join("\t") };
    if (ref.startsWith("refs/heads/"))
      local.push({
        name: ref.slice(11),
        current: head === "*",
        remote: null,
        ...info,
      });
    else if (ref.startsWith("refs/remotes/")) {
      const [name, ...rest] = ref.slice(13).split("/"),
        branch = rest.join("/");
      if (branch && branch !== "HEAD")
        remote.push({ name: branch, current: false, remote: name, ...info });
    }
  }
  const have = new Set(local.map((b) => b.name)),
    seen = new Set();
  return [
    ...local,
    ...remote.filter(
      (b) => !have.has(b.name) && !seen.has(b.name) && seen.add(b.name),
    ),
  ];
}

// A name starting with "-" must not be read as an option.
export const switchArgs = (name) =>
  name.startsWith("-") ? ["switch", "--", name] : ["switch", name];

// One click deletes, as in Zed: `-D`, so a branch git calls unmerged goes too (the note tells how to restore it).
export const deleteArgs = (name) => ["branch", "-D", "--", name];

export function deletedNote(name, stdout) {
  const hash = /\(was ([0-9a-f]+)\)/.exec(String(stdout ?? ""))?.[1];
  return hash
    ? `Deleted ${name}. To restore it: git branch ${name} ${hash}`
    : `Deleted ${name}.`;
}

// Remote branches are never deleted from here, and git refuses the current one.
export const canDelete = (branch) => !branch.current && !branch.remote;

export function filterBranches(branches, query) {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  return q
    ? branches.filter((b) =>
        `${b.remote ? `${b.remote}/` : ""}${b.name}`.toLowerCase().includes(q),
      )
    : branches;
}

// Typing a name that no branch has yet offers to create it; a name starting with "-" is not a branch.
export const canCreate = (branches, query) => {
  const name = String(query ?? "").trim();
  return (
    name !== "" &&
    !name.startsWith("-") &&
    !branches.some((b) => b.name === name)
  );
};

export const createArgs = (name) => ["switch", "-c", name.trim()];

// Commits of `name` that no remote has: deleting the branch would lose them.
export const unpushedArgs = (name) => [
  "rev-list",
  "--count",
  name,
  "--not",
  "--remotes",
];

export const parseCount = (stdout) => {
  const n = Number.parseInt(String(stdout ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const LIST_MAX = 340;

// Height of the branch list in px: a heading per section, a row per branch, one more row to create
// a branch; past LIST_MAX the list scrolls inside that height.
export function listHeight(branches, creating = false) {
  const local = branches.filter((b) => !b.remote).length,
    remote = branches.length - local;
  const px =
    (local ? 30 + local * 52 : 0) +
    (remote ? 30 + remote * 52 : 0) +
    (creating ? 40 : 0);
  return Math.min(LIST_MAX, px);
}

// Entries of the sync menu, in order; `-` is a separator.
export const SYNC_MENU = [
  ["fetch", "Fetch"],
  ["fetch-from", "Fetch From…"],
  ["pull", "Pull"],
  ["pull-rebase", "Pull (Rebase)"],
  "-",
  ["push", "Push"],
  ["push-to", "Push To…"],
  ["force-push", "Force Push"],
];

export const needsRemote = (op) => op === "fetch-from" || op === "push-to";
export const isForce = (op) => op === "force-push";

// The git arguments of a menu entry (null for anything else). `upstream`: the branch tracks one;
// without it a push publishes the branch and sets its upstream. A force push uses --force-with-lease,
// which refuses to overwrite commits someone else pushed since the last fetch.
export function syncArgs(op, { remote, upstream } = {}) {
  const publish = (remote2) => ["--set-upstream", remote2, "HEAD"];
  switch (op) {
    case "fetch":
      return ["fetch"];
    case "fetch-from":
      return ["fetch", remote];
    case "pull":
      return ["pull", "--no-edit"];
    case "pull-rebase":
      return ["pull", "--rebase"];
    case "push":
      return upstream ? ["push"] : ["push", ...publish(remote ?? "origin")];
    case "push-to":
      return upstream ? ["push", remote, "HEAD"] : ["push", ...publish(remote)];
    case "force-push":
      return upstream
        ? ["push", "--force-with-lease"]
        : ["push", "--force-with-lease", ...publish(remote ?? "origin")];
    default:
      return null;
  }
}

// `git rev-list --left-right --count @{upstream}...HEAD` prints "<behind>\t<ahead>".
export function parseAheadBehind(stdout) {
  const m = /^(\d+)\s+(\d+)$/.exec(String(stdout ?? "").trim());
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
}

// The button beside the branch name: publish a new branch, pull when behind, push when ahead, else fetch.
export function primaryAction({ remotes, upstream, ahead, behind }) {
  if (!remotes.length) return null;
  if (!upstream) return { op: "push", label: "Publish" };
  if (behind > 0) return { op: "pull", label: `Pull ↓${behind}` };
  if (ahead > 0) return { op: "push", label: `Push ↑${ahead}` };
  return { op: "fetch", label: "Fetch" };
}

// One line of what git said: it writes progress to stderr, so that comes first.
export function summarize(stdout, stderr) {
  const text = String(stderr ?? "").trim() || String(stdout ?? "").trim();
  return text
    ? text
        .split("\n")
        .slice(0, 3)
        .map((l) => l.trim())
        .join(" ")
    : "Done";
}
