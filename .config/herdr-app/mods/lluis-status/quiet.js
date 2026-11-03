// Navigation failures are ordinary no-ops. The CLI returns their error to its
// caller, unlike Herdr's interactive run(), which posts a toast automatically.
const QUIET = new Set([
  "pane.go",
  "pane.swap",
  "pane.zoom",
  "pane.split",
  "space.next",
  "space.prev",
  "space.select",
  "tab.next",
  "tab.prev",
  "tab.select",
  "agent.next",
  "agent.prev",
  "layout.toggle",
  "layout.switch",
]);

export function quietCommand(action) {
  if (typeof action !== "string" || !QUIET.has(action.split(":")[0]))
    return null;
  return `quiet_${action.replace(/[.:-]/g, "_")}`;
}

export function quietAction(command, bindings) {
  return (
    bindings.find(
      (binding) =>
        binding.section === "global" &&
        quietCommand(binding.action) === command,
    )?.action || null
  );
}

export async function runQuiet(exec, action) {
  try {
    await exec("herdr-app", ["do", action]);
  } catch {
    /* No toast for a shortcut that cannot act here. */
  }
}
