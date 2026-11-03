export const DEFAULT_TEMPLATE = "Review PR {pr_number}";
export const SETTINGS_KEY = "pr-review-assist.settings";
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
export const FILTERS = [["all", "All"], ["mine", "Mine"], ["review", "To review"]];
export const SEARCH = { all: "sort:updated-desc", mine: "author:@me sort:updated-desc", review: "review-requested:@me sort:updated-desc" };
export const FIELDS = "number,title,author,isDraft,url,headRefName,baseRefName,updatedAt,state,reviewDecision,statusCheckRollup";
export function templateError(value) {
  if (!value.trim()) return "Enter a review message.";
  if (!value.includes("{pr_number}")) return "Include {pr_number} so the agent knows which PR to review.";
  return null;
}
export function reviewMessage(template, number) {
  const error = templateError(template);
  if (error) throw new Error(error);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid PR number.");
  return template.replaceAll("{pr_number}", String(number));
}
export function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}
export function contextKey(loc) { return JSON.stringify([loc?.space ?? null, loc?.cwd ?? null, loc?.on ?? null]); }
export function location(spaces, panes, focus, last) {
  const space = spaces.find(s => s.active), pane = panes.find(p => p.pane === focus?.pane);
  if (pane && !pane.terminal && last?.space === space?.id) return last;
  const sibling = pane && !pane.terminal ? panes.find(p => p.tab === pane.tab && p.terminal && p.cwd) : null;
  return { space: space?.id ?? null, cwd: pane?.cwd || sibling?.cwd || focus?.cwd || space?.folder || null, on: space?.machine ?? null };
}
export function availableAgents(list, space) { return list.filter(a => a.space === space); }
export function ready(agent) { return agent?.status === "idle" || agent?.status === "done"; }
export function failure(result, fallback) { return (result.stderr || result.stdout || fallback).trim().slice(0, 600); }

// gh rollups contain both CheckRun (status/conclusion) and legacy StatusContext (state).
// Skipped/neutral results are not passing checks; unknown conclusions never imply success.
export function checkSummary(rollup) {
  const counts = { passing: 0, failing: 0, pending: 0, skipped: 0, unknown: 0 };
  const checks = Array.isArray(rollup) ? rollup : [];
  for (const check of checks) {
    const result = String(check?.conclusion || check?.state || "").toUpperCase();
    const status = String(check?.status || "").toUpperCase();
    if ((status && status !== "COMPLETED") || ["PENDING", "EXPECTED"].includes(result)) counts.pending++;
    else if (result === "SUCCESS") counts.passing++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "CANCELLED", "STALE"].includes(result)) counts.failing++;
    else if (["SKIPPED", "NEUTRAL"].includes(result)) counts.skipped++;
    else counts.unknown++;
  }
  const kind = !checks.length ? "none" : counts.failing ? "fail" : counts.pending ? "pending" : counts.unknown ? "unknown" : counts.passing ? "pass" : "skipped";
  const label = !checks.length ? "No CI checks" : [
    `${counts.failing} failing`, `${counts.passing} passing`,
    ...(counts.pending ? [`${counts.pending} pending`] : []),
    ...(counts.skipped ? [`${counts.skipped} skipped`] : []),
    ...(counts.unknown ? [`${counts.unknown} unknown`] : []),
  ].join(" · ");
  return { ...counts, kind, label };
}
export function prStatus(pr) {
  const state = String(pr.state ?? "OPEN").toUpperCase();
  if (state === "MERGED") return { label: "Merged", color: "accent" };
  if (state === "CLOSED") return { label: "Closed", color: "ansi1" };
  return pr.isDraft ? { label: "Draft", color: "muted" } : { label: "Open", color: "ansi2" };
}
export function reviewStatus(pr) {
  return { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", REVIEW_REQUIRED: "Review required" }[pr.reviewDecision] ?? null;
}
