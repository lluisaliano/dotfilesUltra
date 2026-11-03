import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("mods/zed-tabs/zed.js", root), "utf8");
let id = 0;

async function load(overrides = {}) {
  const calls = [];
  const notices = [];
  globalThis.__zedTest = {
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (overrides.exec) return overrides.exec(command, args, options);
      return { code: 0, stdout: "/work/repository\n", stderr: "" };
    },
    hc:
      overrides.hc ||
      (async () => ({ code: 0, stdout: '{"machines":[]}', stderr: "" })),
    panes:
      overrides.panes ||
      (() => [{ focused: true, terminal: "t1", cwd: "/work/repository/src" }]),
    notify: (notice) => notices.push(notice),
  };
  const code =
    source.replace(
      /^import .* from "herdr";$/m,
      "const { exec, hc, panes, notify } = globalThis.__zedTest;",
    ) + `\n// test module ${++id}`;
  const api = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  return { ...api, calls, notices };
}

test("Zed resolves a local repository from the focused terminal", async () => {
  const api = await load();
  assert.equal(
    await api.zedTarget({ folder: "/other", machine: null }),
    "/work/repository",
  );
  assert.deepEqual(api.calls[0], {
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    options: { cwd: "/work/repository/src", on: null },
  });
});

test("Zed falls back to a folder with spaces outside a repository", async () => {
  const api = await load({
    panes: () => [{ focused: true, terminal: "t1", cwd: "/work/my folder" }],
    exec: async () => {
      throw new Error("git unavailable");
    },
  });
  assert.equal(await api.zedTarget({ machine: null }), "/work/my folder");
});

test("Zed falls back to the machine home when no folder is available", async () => {
  const api = await load({
    panes: () => [],
    exec: async (command) =>
      command === "git"
        ? { code: 1, stdout: "" }
        : { code: 0, stdout: "/home/test\n" },
  });
  assert.equal(await api.zedTarget({ machine: null }), "/home/test");
});

test("Zed builds SSH targets using the Herdr machine host", async () => {
  const api = await load({
    hc: async () => ({
      code: 0,
      stdout: JSON.stringify({
        machines: [{ name: "server", target: "ssh-alias" }],
      }),
    }),
  });
  assert.equal(
    await api.zedTarget({ machine: "server" }),
    "ssh://ssh-alias/work/repository",
  );
  assert.equal(api.calls[0].options.on, "server");
});

test("Zed refuses a remote machine using a custom transport", async () => {
  const api = await load({
    hc: async () => ({
      code: 0,
      stdout: JSON.stringify({
        machines: [{ name: "server", via: "custom transport" }],
      }),
    }),
  });
  await assert.rejects(api.zedTarget({ machine: "server" }), /not ssh/);
});

test("Zed uses the installed zeditor fallback and reports success", async () => {
  const api = await load({
    exec: async (command) => {
      if (command === "git") return { code: 0, stdout: "/work/repository\n" };
      if (command === "zed") throw new Error("not installed");
      if (command === "zeditor") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`Unexpected program: ${command}`);
    },
  });
  await api.openInZed({ machine: null });
  assert.deepEqual(api.calls.find((call) => call.command === "zeditor").args, [
    "/work/repository",
  ]);
  assert.equal(api.notices[0].level, "success");
});

test("Zed launch failures produce an error notification", async () => {
  const api = await load({
    exec: async (command) => {
      if (command === "git") return { code: 0, stdout: "/work/repository" };
      throw new Error("not installed");
    },
  });
  await api.openInZed({ machine: null });
  assert.equal(api.notices[0].level, "error");
});

test("luxor-layout uses its own tab mod and every installed asset exists", async () => {
  const layout = JSON.parse(
    await readFile(new URL("layouts/luxor-layout.json", root), "utf8"),
  );
  function findNode(node, id) {
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  const work = findNode(layout, "work");
  assert.equal(
    work.children.find((node) => node.id === "tabs").content.mod,
    "zed-tabs",
  );
  const main = await readFile(new URL("mods/zed-tabs/main.js", root), "utf8");
  assert.match(main, /id\("open-zed"\)/);
  for (const asset of [
    "zed.svg",
    "win-min.svg",
    "win-max.svg",
    "win-close.svg",
    "win-restore.svg",
  ])
    assert.ok(
      (
        await readFile(new URL(`mods/zed-tabs/${asset}`, root), "utf8")
      ).includes("<svg"),
    );
});
