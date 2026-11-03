// Opens a Herdr space in Zed on this computer. Used by the tab bar's Zed button.
//
// Local space:  zed <repo root>
// Remote space: zed ssh://<ssh target><repo root>   (a Zed remote project)
//
// The folder is the focused terminal's git repo root, else its folder,
// else the home folder of the space's machine.

import { exec, hc, panes, notify } from "herdr";

// Locally adapted for Linux: distro packages can name the CLI zeditor.
const ZED_CLIS = ["zed", "zeditor", "/Applications/Zed.app/Contents/MacOS/cli"];

async function run(command, args, options) {
  const r = await exec(command, args, options);
  return r.code === 0 ? r.stdout.trim() : "";
}

async function tryRun(command, args, options) {
  try {
    return await run(command, args, options);
  } catch {
    return "";
  }
}

/** The absolute folder to open, on the space's machine. */
async function workspaceFolder(space) {
  const on = space?.machine ?? null;
  const pane = panes().find((p) => p.focused && p.terminal);
  const cwd = pane?.cwd || space?.folder || undefined;

  const root = await tryRun("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    on,
  });
  if (root) return root;
  if (cwd?.startsWith("/")) return cwd;

  const home = await run("pwd", [], { on });
  if (!home) throw new Error("Could not find a folder to open.");
  return home;
}

/** The ssh host Zed must connect to for a Herdr machine. */
async function sshTarget(machine) {
  const r = await hc(["machine", "ls", "--json"]);
  const found = (JSON.parse(r.stdout).machines ?? []).find(
    (m) => m.name === machine,
  );
  if (found?.via) {
    throw new Error(
      `${machine} connects through a custom command, not ssh. Zed needs an ssh host.`,
    );
  }
  return found?.target ?? machine;
}

/** What to pass to the Zed CLI for this space. */
export async function zedTarget(space) {
  const folder = await workspaceFolder(space);
  if (!space?.machine) return folder;
  return `ssh://${await sshTarget(space.machine)}${folder}`;
}

async function launchZed(target) {
  let lastError = "Zed is not installed.";
  for (const cli of ZED_CLIS) {
    try {
      const r = await exec(cli, [target]);
      if (r.code === 0) return;
      lastError =
        (r.stderr || r.stdout).trim() || `${cli} exited with code ${r.code}.`;
    } catch {
      // This CLI is not available. Try the next one.
    }
  }
  throw new Error(lastError);
}

/** Opens the space in Zed and reports the result as a notification. */
export async function openInZed(space) {
  try {
    const target = await zedTarget(space);
    await launchZed(target);
    notify({
      title: "Opened in Zed",
      body: target,
      level: "success",
      timeout: 3000,
    });
  } catch (e) {
    notify({
      title: "Could not open in Zed",
      body: String(e?.message ?? e),
      level: "error",
    });
  }
}
