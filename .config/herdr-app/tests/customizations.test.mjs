import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const dataSource = await readFile(
  new URL("mods/github-issues/data.js", root),
  "utf8",
);
const helpers = await import(
  `data:text/javascript;base64,${Buffer.from(dataSource).toString("base64")}`
);
const quietHelpers = await import(
  `data:text/javascript;base64,${Buffer.from(await readFile(new URL("mods/lluis-status/quiet.js", root), "utf8")).toString("base64")}`
);
let moduleId = 0;

function findLayoutNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children || []) {
    const found = findLayoutNode(child, id);
    if (found) return found;
  }
  return null;
}

function element() {
  const target = { nodes: [], handlers: {}, label: "", tooltips: [] };
  const proxy = new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key];
      if (key === "then") return undefined;
      return (...args) => {
        if (key === "child") object.nodes.push(args[0]);
        if (key === "children") object.nodes.push(...args[0]);
        if (key === "id") object.label = args[0];
        if (key === "tooltip") object.tooltips.push(args[0]);
        if (key.startsWith("on_")) object.handlers[key] = args[0];
        if (key === "when" && args[0]) args[1](proxy);
        return proxy;
      };
    },
  });
  return proxy;
}

function find(node, id) {
  if (node?.label === id) return node;
  for (const child of node?.nodes || []) {
    const found = find(child, id);
    if (found) return found;
  }
}

function text(node) {
  return typeof node === "string"
    ? node
    : (node?.nodes || []).map(text).join(" ");
}

async function setup(name, overrides = {}) {
  const tasks = [];
  const calls = [];
  const storage = new Map();
  const input = {
    value: () => input.text || "",
    focus() {},
    on(event, fn) {
      if (event === "focus" || event === "blur") input[`${event}Handler`] = fn;
      else input[event] = fn;
    },
  };
  const cx = {
    notify() {},
    stop_propagation() {},
    open_url(url) {
      calls.push(["open_url", url]);
    },
    focus_handle: () => ({ focus() {} }),
    spawn(fn) {
      tasks.push(fn(cx));
    },
    timer: {
      after() {},
      every(_ms, fn) {
        cx.tick = fn;
      },
    },
  };
  const environment = {
    View: class {},
    div: element,
    svg: element,
    image: element,
    h_flex: element,
    v_flex: element,
    InputState: { new: () => input },
    Input: { new: element },
    theme: () => ({}),
    window: () => ({ platform: "linux" }),
    win: () => ({ platform: "linux" }),
    settings: () => ({ zoom: 1 }),
    layouts: () => [],
    agents: () => [],
    focused: () => null,
    home: () => "/home/test",
    terminals: () => [],
    setAgentOrder: () => {},
    appHome: () => "/test/herdr",
    panes: () => [],
    keys: () => [],
    shared: () => ["files", "changes"],
    setShared: (...args) => calls.push(["shared", ...args]),
    layout: () => ({}),
    commands: () => [],
    nextCommand: () => new Promise(() => {}),
    spaces: () => [{ active: true, id: "space-test", machine: null }],
    knownAgents: async () =>
      ["codex", "claude"].map((key) => ({
        key,
        name: key,
        installed: true,
        run: [key],
      })),
    props: () => ({ overlay: "launcher-test" }),
    run: (...args) => calls.push(args),
    openOverlay: (...args) => calls.push(["open", ...args]),
    closeOverlay: (...args) => calls.push(["close", ...args]),
    exec: async () => ({ code: 0, stdout: "[]", stderr: "" }),
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    ...helpers,
    ...quietHelpers,
    ...overrides,
  };
  globalThis.__herdrTestEnvironment = environment;
  let source = await readFile(new URL(`mods/${name}/main.js`, root), "utf8");
  source = source.replace(/^import[\s\S]*?from\s+"[^"]+";\n/gm, "");
  source = `const {${Object.keys(environment).join(",")}} = globalThis.__herdrTestEnvironment;\n${source}\n// ${++moduleId}`;
  const { default: Mod } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const mod = new Mod();
  mod.init?.({}, cx);
  const drain = async () => {
    while (tasks.length) await Promise.all(tasks.splice(0));
  };
  return { mod, cx, calls, input, storage, drain };
}

const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

test("GitHub queries validate repository names and handle failed/malformed responses", () => {
  assert.equal(helpers.validRepo("acme/sample-repo"), true);
  for (const value of [
    "",
    "--help",
    "a/b/c",
    "https://github.com/a/b",
    "a/b;rm",
    null,
  ]) {
    assert.equal(helpers.validRepo(value), false);
    assert.throws(() => helpers.issueArgs(value));
  }
  assert.ok(helpers.repoArgs(2)[1].includes("page=2"));
  assert.deepEqual(helpers.issueArgs("a/b").slice(0, 5), [
    "issue",
    "list",
    "--repo",
    "a/b",
    "--state",
  ]);
  assert.throws(
    () => helpers.parseResult({ code: 1, stderr: "Authentication failed" }),
    /Authentication failed/,
  );
  assert.throws(
    () => helpers.parseResult(ok({ message: "wrong shape" })),
    /unexpected/,
  );
  assert.throws(() => helpers.parseResult({ code: 0, stdout: "broken" }));
  assert.deepEqual(helpers.filterRepos([{ full_name: "Org/Repo" }], " ORG/ "), [
    { full_name: "Org/Repo" },
  ]);
});

test("agent chooser launches each installed agent in the originating space and blocks unavailable agents", async () => {
  const { mod, drain, calls } = await setup("agent-launcher");
  await drain();
  mod.launch(0);
  mod.launch(1);
  assert.deepEqual(
    calls.filter(([command]) => command === "tab.new"),
    [
      ["tab.new", { name: "codex", space: "space-test", argv: ["codex"] }],
      ["tab.new", { name: "claude", space: "space-test", argv: ["claude"] }],
    ],
  );
  mod.agents[1].installed = false;
  const count = calls.length;
  mod.launch(1);
  assert.equal(calls.length, count);
});

test("agent chooser keyboard selection launches Claude with 2", async () => {
  const { mod, drain, calls, cx } = await setup("agent-launcher");
  await drain();
  mod.render().handlers.on_key_down({ key: "2", modifiers: {} }, cx);
  assert.equal(calls[0][1].argv[0], "claude");
});

test("agent chooser Ctrl+N lowers and Ctrl+P raises, without J/K navigation", async () => {
  const { mod, drain, calls, cx } = await setup("agent-launcher");
  await drain();
  const press = (key, modifiers = {}) =>
    mod.render().handlers.on_key_down({ key, modifiers }, cx);
  press("p", { control: true });
  assert.equal(mod.selected, 0);
  press("n", { control: true });
  assert.equal(mod.selected, 1);
  press("n", { control: true });
  assert.equal(mod.selected, 1);
  press("k");
  assert.equal(mod.selected, 1);
  press("p", { control: true });
  assert.equal(mod.selected, 0);
  press("j");
  assert.equal(mod.selected, 0);
  press("down");
  assert.equal(mod.selected, 1);
  press("up");
  assert.equal(mod.selected, 0);
  press("n", { control: true });
  press("enter");
  assert.equal(calls[0][1].argv[0], "claude");
  assert.match(text(mod.render()), /Ctrl\+N \/ Ctrl\+P/);
});

test("repository picker filters, accepts owner/repo, persists selection and renders clickable issues", async () => {
  const queries = [];
  const { mod, drain, cx, input, storage, calls } = await setup(
    "github-issues",
    {
      exec: async (_command, args) => {
        queries.push(args);
        return args[0] === "api"
          ? ok([{ id: 7, full_name: "Org/Repo", private: true }])
          : ok([
              {
                number: 42,
                title: "Fix login",
                url: "https://github.com/Org/Repo/issues/42",
                labels: [{ name: "bug" }],
              },
            ]);
      },
    },
  );
  await drain();
  assert.ok(find(mod.render(), "repo-7"));
  input.text = "Org/Repo";
  input.change({}, cx);
  input.submit({}, cx);
  await drain();
  assert.equal(storage.get("repository"), "Org/Repo");
  assert.equal(mod.choosing, false);
  assert.ok(queries.some((args) => args.includes("Org/Repo")));
  const row = find(mod.render(), "issue-42");
  assert.match(text(row), /Fix login/);
  row.handlers.on_click({}, cx);
  assert.deepEqual(calls[0], [
    "open_url",
    "https://github.com/Org/Repo/issues/42",
  ]);
});

test("switching repositories ignores an older request completing last", async () => {
  const pending = {};
  const { mod, drain, cx } = await setup("github-issues", {
    exec: async (_command, args) =>
      args[0] === "api"
        ? ok([])
        : new Promise((resolve) => {
            pending[args[3]] = resolve;
          }),
  });
  await drain();
  mod.selectRepo("Org/Old", cx);
  mod.selectRepo("Org/New", cx);
  pending["Org/New"](ok([{ number: 2 }]));
  await Promise.resolve();
  pending["Org/Old"](ok([{ number: 1 }]));
  await drain();
  assert.equal(mod.repo, "Org/New");
  assert.deepEqual(mod.issues, [{ number: 2 }]);
  assert.equal(mod.loading, false);
});

test("GitHub errors have recovery controls and a successful refresh clears the error", async () => {
  let fail = true;
  const { mod, drain, cx } = await setup("github-issues", {
    exec: async (_command, args) =>
      args[0] === "api"
        ? ok([])
        : fail
          ? { code: 1, stdout: "", stderr: "Issues are disabled" }
          : ok([]),
  });
  await drain();
  mod.selectRepo("Org/Repo", cx);
  await drain();
  assert.match(text(mod.render()), /Issues are disabled/);
  fail = false;
  find(mod.render(), "github-refresh").handlers.on_click({}, cx);
  await drain();
  assert.equal(mod.error, "");
  assert.match(text(mod.render()), /No open issues/);
});

test("all requested shortcuts are installed and the personal layout retains Files and Changes", async () => {
  const keys = JSON.parse(await readFile(new URL("keys.json", root), "utf8"));
  const expected = {
    "alt-1": "tab.select:1",
    "alt-2": "tab.select:2",
    "alt-3": "tab.select:3",
    "alt-t": "tab.new",
    "alt-f": "mod.open:picker",
    "alt-r": "tab.rename",
    "alt-a": "mod.open:agent-launcher",
    "alt-n": "mod.open:lluis-worktree",
    "alt-shift-n": "space.new",
    "alt-i": "space.next",
    "alt-o": "space.prev",
    "alt-shift-i": "agent.next",
    "alt-shift-o": "agent.prev",
    "alt-v": "pane.split:right",
    "alt-s": "pane.split:down",
    "alt-k": "pane.go:up",
    "alt-j": "pane.go:down",
    "alt-h": "pane.go:left",
    "alt-l": "pane.go:right",
    "alt-w": "pane.close",
    "alt-;": "mod.open:lluis-palette",
  };
  for (const [key, action] of Object.entries(expected)) {
    assert.equal(keys.global[key], action);
    assert.equal(keys.terminal[key], undefined);
  }
  assert.equal(keys.global["alt-:"], undefined);
  assert.equal(keys.global["ctrl-shift-k"], undefined);
  assert.equal(keys.global["alt-shift-:"], undefined);
  const layout = JSON.parse(
    await readFile(new URL("layouts/lluis-workspace.json", root), "utf8"),
  );
  const ids = [];
  const visit = (node) => {
    ids.push(node.id);
    (node.children || []).forEach(visit);
  };
  visit(layout);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["github-issues", "panel", "files", "changes"])
    assert.ok(ids.includes(id));
  assert.equal(ids.includes("issues-sidebar"), false);
  const work = layout.children.find((node) => node.id === "work");
  const body = work.children.find((node) => node.id === "work-body");
  const panel = body.children.find((node) => node.id === "panel");
  assert.ok(
    panel.children[0].children.some((node) => node.id === "github-issues"),
  );
  assert.equal(
    work.children.find((node) => node.id === "tabs").content.mod,
    "lluis-tabs",
  );
  assert.equal(
    work.children.find((node) => node.id === "status").content.mod,
    "lluis-status",
  );
  assert.equal(layout.cloned_from.name, "main");
});

test("GitHub toolbar button opens and closes the same panel as Files and Changes", async () => {
  const body = { id: "panel-body", active: "files", children: [] };
  const panel = { id: "panel", hidden: true, children: [body] };
  const { mod, calls } = await setup("lluis-tabs", {
    layout: () => ({ children: [panel] }),
    spaces: () => [{ active: true, id: "space-test", tabs: [] }],
  });
  let tree = mod.render();
  assert.ok(find(tree, "panel-files"));
  assert.ok(find(tree, "panel-changes"));
  find(tree, "panel-github-issues").handlers.on_click();
  assert.deepEqual(calls.slice(-2), [
    ["layout.select", { stack: "panel-body", child: "github-issues" }],
    ["layout.show", { id: "panel" }],
  ]);
  panel.hidden = false;
  body.active = "github-issues";
  tree = mod.render();
  find(tree, "panel-github-issues").handlers.on_click();
  assert.deepEqual(calls.at(-1), ["layout.hide", { id: "panel" }]);
});

test("palette lists terminal, agent and GitHub actions with the new shortcuts", async () => {
  const config = JSON.parse(await readFile(new URL("keys.json", root), "utf8"));
  const bound = Object.entries(config.global).map(([keys, action]) => ({
    section: "global",
    keys,
    action,
  }));
  const { mod, calls } = await setup("lluis-palette", {
    keys: () => bound,
    commands: () =>
      [
        "tab.new",
        "tab.rename",
        "mod.open",
        "layout.select",
        "pane.split",
        "pane.go",
      ].map((name) => ({
        name,
        args: [],
      })),
  });
  mod.query = "New terminal tab";
  assert.match(text(mod.render()), /alt t/);
  mod.go(mod.rows()[0].e);
  assert.deepEqual(calls.at(-1), ["tab.new", {}]);
  mod.query = "Rename tab";
  assert.match(text(mod.render()), /alt r/);
  mod.go(mod.rows()[0].e);
  assert.deepEqual(calls.at(-1), ["tab.rename", {}]);
  mod.query = "New agent";
  assert.match(text(mod.render()), /alt a/);
  mod.go(mod.rows()[0].e);
  assert.deepEqual(calls.at(-1), ["mod.open", { name: "agent-launcher" }]);
  mod.query = "Go to space or tab";
  assert.match(text(mod.render()), /alt f/);
  mod.go(mod.rows()[0].e);
  assert.deepEqual(calls.at(-1), ["mod.open", { name: "picker" }]);
  mod.query = "Split down";
  assert.match(text(mod.render()), /alt s/);
  mod.go(mod.rows()[0].e);
  assert.deepEqual(calls.at(-1), ["pane.split", { direction: "down" }]);
  for (const [direction, key] of [
    ["up", "k"],
    ["down", "j"],
    ["left", "h"],
    ["right", "l"],
  ]) {
    mod.query = `Focus pane ${direction}`;
    assert.ok(text(mod.render()).includes(`alt ${key}`));
    mod.go(mod.rows()[0].e);
    assert.deepEqual(calls.at(-1), ["pane.go", { direction }]);
  }
  mod.query = "GitHub Issues";
  mod.go(mod.rows()[0].e);
  assert.deepEqual(calls.slice(-2), [
    ["layout.select", { stack: "panel-body", child: "github-issues" }],
    ["layout.show", { id: "panel" }],
  ]);
});

test("commands footer displays Alt+; and opens the same personal palette", async () => {
  const config = JSON.parse(await readFile(new URL("keys.json", root), "utf8"));
  const { mod, calls } = await setup("lluis-status", {
    keys: () =>
      Object.entries(config.global).map(([keys, action]) => ({
        section: "global",
        keys,
        action,
      })),
  });
  const button = find(mod.render(), "palette");
  assert.match(text(button), /Alt\+;/);
  button.handlers.on_click();
  assert.deepEqual(calls.at(-1), ["mod.open", { name: "lluis-palette" }]);
});

test("palette Ctrl+N moves down and Ctrl+P moves up without changing its query", async () => {
  const { mod, input, cx } = await setup("lluis-palette", {
    commands: () =>
      ["tab.new", "tab.rename", "tab.close", "mod.open"].map((name) => ({
        name,
        args: [],
      })),
  });
  input.text = "tab";
  input.change({}, cx);
  const press = (key) =>
    mod
      .render()
      .handlers.on_key_down({ key, modifiers: { control: true } }, cx);
  press("n");
  assert.equal(mod.at, 1);
  press("p");
  assert.equal(mod.at, 0);
  press("p");
  assert.equal(mod.at, 0);
  assert.equal(mod.query, "tab");
  assert.equal(input.text, "tab");
});

test("palette navigation bindings work while its search input holds focus", async () => {
  const bindings = JSON.parse(
    await readFile(new URL("keys.json", root), "utf8"),
  );
  assert.equal(bindings["mod:lluis-palette"]["ctrl-p"], "lluis-palette.up");
  assert.equal(bindings["mod:lluis-palette"]["ctrl-n"], "lluis-palette.down");
  let deliver;
  const { mod } = await setup("lluis-palette", {
    nextCommand: () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
    commands: () =>
      ["tab.new", "tab.rename", "tab.close"].map((name) => ({
        name,
        args: [],
      })),
  });
  deliver("down");
  await Promise.resolve();
  assert.equal(mod.at, 1);
  deliver("up");
  await Promise.resolve();
  assert.equal(mod.at, 0);
});

test("requested plugins are integrated in luxor-layout and quotas follow the agent count", async () => {
  const layout = JSON.parse(
    await readFile(new URL("layouts/luxor-layout.json", root), "utf8"),
  );
  assert.equal(findLayoutNode(layout, "zed-titlebar").content.mod, "zed-title");
  assert.equal(findLayoutNode(layout, "files").content.mod, "zed-file-icons");
  assert.equal(findLayoutNode(layout, "changes").content.mod, "zed-changes");
  const footer = findLayoutNode(layout, "status");
  assert.equal(footer.children[0].content.props.role, "summary");
  assert.equal(footer.children[1].content.mod, "zed-quota");
  assert.equal(footer.children[1].content.props.remaining, true);
  assert.equal(footer.children[1].content.props.kinds.weekly, true);
  assert.equal(footer.children[1].content.props.kinds.session, true);
  for (const name of [
    "zed-quota",
    "zed-title",
    "zed-changes",
    "zed-file-icons",
    "zed-file",
    "zed-settings",
  ])
    assert.ok(
      (await readFile(new URL(`mods/${name}/main.js`, root), "utf8")).length >
        0,
    );
});

test("quota strip has no hover popovers and still opens details on click", async () => {
  const source = await readFile(
    new URL("mods/zed-quota/quota-windows.js", root),
    "utf8",
  );
  const windowHelpers = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const data = {
    at: Date.now(),
    providers: [
      {
        id: "codex",
        label: "Codex",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "5 hours",
            percentUsed: 20,
          },
        ],
      },
    ],
  };
  const { mod, calls, cx } = await setup("zed-quota", {
    ...windowHelpers,
    setShared() {},
    shared: (key) => (key.startsWith("zed-quota.data:") ? data : undefined),
    runQuotaCommand: async () => ({ code: 0, stdout: '{"providers":[]}' }),
  });
  const tree = mod.render(cx);
  function check(node) {
    if (!node || typeof node !== "object") return;
    assert.equal(node.tooltips.length, 0);
    node.nodes.forEach(check);
  }
  check(tree);
  tree.handlers.on_click();
  assert.equal(calls.at(-1)[0], "open");
  assert.equal(calls.at(-1)[1].mod, "zed-quota");
  assert.equal(calls.at(-1)[1].props.menu, true);
});

test("new worktree shortcut uses the active space and focused terminal folder", async () => {
  const { mod, drain } = await setup("lluis-worktree", {
    spaces: () => [
      { id: "active", active: true, machine: null, folder: "/other", tabs: [] },
    ],
    panes: () => [{ focused: true, cwd: "/repo/current" }],
    exec: async () => ({ code: 1, stdout: "", stderr: "not a repository" }),
  });
  await drain();
  assert.equal(mod.space().id, "active");
  assert.equal(mod.folder, "/repo/current");
});

test("palette displays navigation and pane resizing shortcuts", async () => {
  const config = JSON.parse(await readFile(new URL("keys.json", root), "utf8"));
  const { mod } = await setup("lluis-palette", {
    keys: () =>
      Object.entries(config.global).map(([keys, action]) => ({
        section: "global",
        keys,
        action,
      })),
    commands: () =>
      [
        "mod.open",
        "space.new",
        "space.next",
        "space.prev",
        "agent.next",
        "agent.prev",
      ].map((name) => ({ name, args: [] })),
  });
  for (const [query, shortcut] of [
    ["New worktree", "alt n"],
    ["New space", "alt shift n"],
    ["Next space", "alt i"],
    ["Previous space", "alt o"],
    ["Next agent", "alt shift i"],
    ["Previous agent", "alt shift o"],
    ["Decrease pane width", "ctrl alt h"],
    ["Increase pane width", "ctrl alt l"],
    ["Decrease pane height", "ctrl alt k"],
    ["Increase pane height", "ctrl alt j"],
  ]) {
    mod.query = query;
    assert.ok(text(mod.render()).includes(shortcut), `${query}: ${shortcut}`);
  }
});

test("navigation shortcuts fail silently while dialog actions remain native", async () => {
  const config = JSON.parse(await readFile(new URL("keys.json", root), "utf8"));
  const bindings = Object.entries(config.global).map(([keys, action]) => ({
    section: "global",
    keys,
    action,
  }));
  for (const section of ["layout:luxor-layout", "layout:lluis-workspace"]) {
    for (const [key, command] of Object.entries(config[section])) {
      assert.equal(
        quietHelpers.quietAction(
          command.replace("lluis-status.", ""),
          bindings,
        ),
        config.global[key],
      );
    }
    assert.equal(config[section]["alt-r"], undefined);
    assert.equal(config[section]["alt-w"], undefined);
  }
  assert.equal(quietHelpers.quietCommand("tab.rename"), null);
  assert.equal(quietHelpers.quietCommand("pane.close"), null);
  const calls = [];
  await quietHelpers.runQuiet(async (...args) => {
    calls.push(args);
    return { code: 1 };
  }, "pane.go:left");
  assert.deepEqual(calls, [["herdr-app", ["do", "pane.go:left"]]]);
  await assert.doesNotReject(
    quietHelpers.runQuiet(async () => {
      throw new Error("cannot start");
    }, "agent.next"),
  );
});

test("quota settings have only quota and providers, even when searching for editor", async () => {
  const source = await readFile(
    new URL("mods/zed-settings/options.js", root),
    "utf8",
  );
  const options = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const { CATEGORIES, ...quotaFields } = options;
  const { mod, input } = await setup("zed-settings", {
    ...quotaFields,
    ALL_CATEGORIES: CATEGORIES,
    shared: () => undefined,
  });
  assert.equal(mod.category, "quota");
  let tree = mod.render();
  assert.ok(find(tree, "cat-quota"));
  assert.ok(find(tree, "cat-providers"));
  assert.equal(find(tree, "cat-editor"), undefined);
  assert.equal(find(tree, "row-wrap"), undefined);
  input.text = "editor";
  tree = mod.render();
  assert.equal(find(tree, "row-editor"), undefined);
  assert.match(text(tree), /No settings match/);
});

test("top-left brand is Luxor and title-bar window controls are absent", async () => {
  const brand = await setup("lluis-brand");
  assert.match(text(brand.mod.render()), /Luxor/);
  const title = await setup("zed-title", {
    window: () => ({ platform: "linux", buttons: true }),
  });
  const tree = title.mod.render();
  for (const id of ["zed-min", "zed-max", "zed-close"])
    assert.equal(find(tree, id), undefined);
  assert.ok(find(tree, "zed-sidebar"));
  const layout = JSON.parse(
    await readFile(new URL("layouts/luxor-layout.json", root), "utf8"),
  );
  assert.equal(findLayoutNode(layout, "brand").content.mod, "lluis-brand");
});

test("resize shortcuts reach the active pane once and tolerate missing splits", async () => {
  const queue = ["resize_left", "resize_down", "resize_up", "resize_right"];
  const calls = [];
  await setup("lluis-status", {
    props: () => ({ role: "summary" }),
    focused: () => ({ pane: "pane-a", tab: "tab-a", space: "space-test" }),
    nextCommand: () =>
      queue.length ? Promise.resolve(queue.shift()) : new Promise(() => {}),
    exec: async (...args) => {
      calls.push(args);
      throw new Error("unavailable split");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => call[1]),
    ["left", "down", "up", "right"].map((direction) => [
      "/test/herdr/tools/resize-pane.py",
      direction,
      "pane-a",
      "tab-a",
      "",
    ]),
  );
  for (const role of ["spacer", "commands"]) {
    await setup("lluis-status", {
      props: () => ({ role }),
      nextCommand: () => {
        throw new Error("passive footer must not listen");
      },
    });
  }
});

test("remaining community mods are installed and integrated without replacing Changes", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("community-mods-20261102.json", root), "utf8"),
  );
  assert.equal(manifest.length, 4);
  for (const item of manifest) {
    assert.match(item.commit, /^[a-f0-9]{40}$/);
    await readFile(new URL(`mods/${item.name}/main.js`, root), "utf8");
  }
  const layout = JSON.parse(
    await readFile(new URL("layouts/luxor-layout.json", root), "utf8"),
  );
  const find = (node, id) =>
    node.id === id
      ? node
      : (node.children ?? []).map((child) => find(child, id)).find(Boolean);
  assert.equal(find(layout, "changes").content.mod, "zed-changes");
  assert.equal(find(layout, "graph").content.mod, "git-graph");
  assert.equal(find(layout, "review"), undefined);
  assert.ok(!JSON.stringify(layout).includes('"reviewer"'));
  assert.ok(!JSON.stringify(layout).includes('"herdr-pets"'));
});

test("Tools opens remaining services without removed mods", async () => {
  const { mod, calls } = await setup("lluis-tools");
  for (const name of ["mod-manager"]) {
    find(mod.render(), name).handlers.on_click();
    assert.deepEqual(calls.splice(0), [
      ["close", "launcher-test"],
      ["mod.open", { name }],
    ]);
  }
  assert.equal(find(mod.render(), "pets"), undefined);
  assert.equal(find(mod.render(), "github"), undefined);
  find(mod.render(), "linear").handlers.on_click();
  assert.deepEqual(calls.splice(0), [
    ["close", "launcher-test"],
    ["layout.select", { stack: "panel-body", child: "linear" }],
    ["layout.show", { id: "panel" }],
  ]);
});

test("palette provides all newly installed tools", async () => {
  const { mod } = await setup("lluis-palette", {
    commands: () => [{ name: "mod.open", args: [] }],
  });
  for (const title of [
    "Git Graph",
    "Review changes",
    "Linear",
    "Mod Manager",
    "Tools menu",
  ]) {
    mod.query = title;
    assert.ok(
      mod.rows().some((row) => row.e.title === title),
      title,
    );
  }
});

test("Graph and Linear palette actions select and show the shared panel", async () => {
  const queue = ["panel_graph", "panel_linear"];
  const calls = [];
  await setup("lluis-status", {
    props: () => ({ role: "summary" }),
    nextCommand: () =>
      queue.length ? Promise.resolve(queue.shift()) : new Promise(() => {}),
    exec: async (...args) => {
      calls.push(args);
      return { code: 0 };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls.map((call) => call[1]),
    ["graph", "linear"].flatMap((child) => [
      ["do", "layout.select", JSON.stringify({ stack: "panel-body", child })],
      ["do", "layout.show", JSON.stringify({ id: "panel" })],
    ]),
  );
});

test("removed Herdr mods have no installed folders, shortcuts or palette actions", async () => {
  const { access } = await import("node:fs/promises");
  for (const name of ["github", "herdr-pets"]) {
    await assert.rejects(access(new URL(`mods/${name}`, root)), {
      code: "ENOENT",
    });
  }
  const bindings = JSON.parse(
    await readFile(new URL("keys.json", root), "utf8"),
  );
  assert.equal(bindings["mod:github"], undefined);
  assert.ok(!JSON.stringify(bindings).includes("mod.open:github"));
  const { mod } = await setup("lluis-palette", {
    commands: () => [{ name: "mod.open", args: [] }],
  });
  mod.query = "GitHub pull requests";
  assert.ok(!mod.rows().some((row) => row.e.args?.name === "github"));
});
