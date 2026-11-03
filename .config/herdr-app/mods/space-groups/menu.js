// The menus of a space and of a group. Opened as a popup with props
// { space, nested } or { group }. ↑/↓ move, Enter runs, Esc closes. An item is
// [label, command, args, disabled]; "worktree", "group.*" and "item" act here instead of running.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, spaces, panes, exec, shared, machines } from "herdr";
import { MOD, load, groupOf, childrenOf, assign, remove, shift } from "./groups.js";

// Other mods add to a space's menu through shared "space-groups.menu":
// { <their name>: [{ label, icon?, spaces?, except?, overlay }] }. `spaces` / `except`
// limit an item to, or keep it from, those space ids; `overlay` is opened as given,
// with the space's id added to its props as `space`.
function extra(space) {
  const all = Object.values(shared("space-groups.menu") ?? {}).flat();
  return all.filter((it) => typeof it?.label === "string" && it.overlay?.mod
    && (!Array.isArray(it.spaces) || it.spaces.includes(space))
    && !(Array.isArray(it.except) && it.except.includes(space)));
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// The machines a new space can go to: this computer first, then the others that answer.
function targets() {
  const others = machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name).sort();
  return [null, ...others];
}

function items(p, git) {
  p = p ?? {};
  // The sidebar's + button: { add: true, space: <active> }, then { add: true, pick: true }.
  if (p.pick) return targets().map((m) => [m ?? "This computer", "space.new", m ? { machine: m } : {}]);
  if (p.add) return [
    ["New space…", "add.machine", {}],
    ["New worktree", "add.worktree", { space: p.space, action: "new" }, !git],
  ];
  if (p.group) {
    const state = load();
    const g = state.groups.find((g) => g.id === p.group);
    const mine = g ? childrenOf(state, g.machine, g.parent) : [];
    return [
      ["Rename group", "group.rename", { group: p.group }],
      ["Add Sub Group…", "group.new", { parent: p.group }],
      ["Move to group…", "group.move", { group: p.group }],
      ["Move up", "group.shift", { group: p.group, by: -1 }, mine[0] === g],
      ["Move down", "group.shift", { group: p.group, by: 1 }, mine.at(-1) === g],
      ["Delete group", "group.delete", { group: p.group }],
    ];
  }
  const space = spaces().find((s) => s.id === p.space);
  const grouped = space && groupOf(load(), space);
  return [
    ["Rename", "space.rename", { id: p.space }],
    ...extra(p.space).map((it) => [it.label, "item", it]),
    ...(git ? [["New worktree", "worktree", { space: p.space, action: "new" }], ["Open worktree", "worktree", { space: p.space, action: "open" }]] : []),
    ...(git === "linked" ? [["Remove worktree", "worktree", { space: p.space, action: "remove" }]] : []),
    ...(p.nested ? [] : [["Move to group…", "group.move", { space: p.space }], ...(grouped ? [["Remove from group", "group.leave", { space: p.space }]] : [])]),
    ["Close", "space.close", { id: p.space }],
  ];
}

function menuIcon([, command, args]) {
  if (command === "item" && typeof args.icon === "string") return args.icon;
  if (command === "group.shift") return `mods/${MOD}/arrow-${args.by < 0 ? "up" : "down"}.svg`;
  if (command === "space.new") return `mods/workspace-chrome/${args.machine ? "server" : "monitor"}.svg`;
  if (command === "add.machine") return "mods/workspace-chrome/plus.svg";
  if (command === "add.worktree") return "mods/workspace-chrome/git-branch.svg";
  const name = command.endsWith(".close") || command === "group.delete" ? "x" : command.endsWith(".rename") ? "square-pen" : command === "worktree" ? "git-branch" : command === "group.move" ? "folder" : command === "group.leave" ? "minus" : command === "item" || command === "group.new" ? "folder-plus" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

const separated = (command) => command.endsWith(".close") || command === "group.delete" || command === "group.move";

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.space && spaces().find((s) => s.id === p.space);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  choose(i, cx) {
    const it = items(props(), this.git)[i];
    if (!it || it[3]) return;
    closeOverlay(props()?.overlay);
    const [, command, args] = it;
    // Only one machine: no need to ask where.
    if (command === "add.machine") {
      if (targets().length === 1) run("space.new", {});
      // Opened from a key (a dialog): the next step is a dialog too, not a popup at the pointer.
      else openOverlay({ mod: MOD, kind: props()?.dialog ? "dialog" : "popup", width: props()?.dialog ? 260 : 200, height: 360, props: { role: "menu", add: true, pick: true, dialog: props()?.dialog } });
    }
    // The person's own worktree dialog (the one alt-n opened before).
    else if (command === "add.worktree") openOverlay({ mod: "lluis-worktree", kind: "dialog", width: 460, height: 280, props: args });
    else if (command === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(args.action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: args });
    else if (command === "item") openOverlay({ ...args.overlay, props: { ...args.overlay.props, space: props().space } });
    else if (command === "group.move") openOverlay({ mod: MOD, kind: "dialog", width: 380, props: { role: "move", ...args } });
    else if (command === "group.leave") assign(args.space, null);
    else if (command === "group.rename") openOverlay({ mod: MOD, kind: "dialog", width: 380, props: { role: "name", group: args.group } });
    else if (command === "group.new") openOverlay({ mod: MOD, kind: "dialog", width: 380, props: { role: "name", parent: args.parent } });
    else if (command === "group.shift") shift(args.group, args.by);
    else if (command === "group.delete") remove(args.group);
    else run(command, args);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        // ctrl-n / ctrl-p as well as the arrows, as in the palette.
        if (e.key === "down" || e.keystroke === "ctrl-n") this.at = (this.at + 1) % list.length;
        else if (e.key === "up" || e.keystroke === "ctrl-p") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && separated(it[1]), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(it[3] ? t.dim : t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .when(!it[3], (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it)).size(14).flex_none().text_color(it[3] ? t.dim : t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
