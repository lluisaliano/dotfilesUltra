// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known, and by hand into foldable
// groups inside each machine. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder or into another group; drag a
// group's header to reorder the groups or put one inside another.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, nextCommand, notify, props, appHome } from "herdr";
import { MOD, load, groupOf, childrenOf, tree, within, assign, toggle, unfold, reorder, prune } from "./groups.js";
import { parseRemote, realHost, pictureFor } from "./remote.js";

// Owner pictures (from balcsida/herdr-profile-pictures): downloaded here, in a hidden
// folder so writing one doesn't hot-reload the mod.
const CACHE = `mods/${MOD}/.cache`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Sidebar {
  init(_props, cx) {
    // Key commands (keys.json: "space-groups.move_space"): move the active space to a group.
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "move_space") this.moveActive();
        // keys.json "space-groups.move_space_up" / "_down": swap the active space with its neighbor.
        else if (command === "move_space_up") this.shiftActive(-1);
        else if (command === "move_space_down") this.shiftActive(1);
        // keys.json "space-groups.move_tab_left" / "_right": swap the active tab with its neighbor.
        else if (command === "move_tab_left") this.shiftTab(-1);
        else if (command === "move_tab_right") this.shiftTab(1);
        // keys.json "space-groups.new_space": the + menu, centered as a dialog.
        else if (command === "new_space") openOverlay({ mod: MOD, kind: "dialog", width: 260, props: { role: "menu", add: true, dialog: true, space: spaces().find((s) => s.active)?.id } });
      }
    });
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    this.upstream = props()?.upstream !== false; // a fork shows its upstream's picture
    this.pics = {}; // repo -> picture path under the home, null: none
    this.got = {}; // picture path -> its download (an owner's repos share one)
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.dragged = null;
    this.over = null;
    this.zone = null;
    this.machines = [];
    this.shownSpace = spaces().find((s) => s.active)?.id ?? null;
    this.arrived = null;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
      if (!(info.repo in this.pics)) this.picture(info.repo, cwd, on, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  // Once per repo: its origin's owner picture, downloaded here (image() reads local files).
  async picture(repo, cwd, on, cx) {
    this.pics[repo] = null;
    try {
      const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on });
      const remote = r.code === 0 ? parseRemote(r.stdout) : null;
      if (!remote) return;
      // An ssh remote can name a Host alias from ~/.ssh/config (a work account's key).
      if (!/^https?:/i.test(r.stdout.trim())) {
        const ssh = await exec("ssh", ["-G", remote.host], { on }).catch(() => null);
        remote.host = realHost(remote.host, ssh?.stdout);
      }
      const pic = await pictureFor(remote, this.upstream, exec);
      if (!pic) return;
      const file = `${CACHE}/${pic.id.replace(/[^\w.-]+/g, "_")}.png`;
      if (!(await (this.got[file] ??= this.download(pic.sources, `${appHome()}/${file}`)))) return;
      this.pics[repo] = file;
      cx.notify();
    } catch {
      // No network, no curl: the letter stays.
    }
  }

  // The first source that gives an image. `file` judges the bytes, not the server's label: a
  // private server's login page is HTML. A gh source keeps the token inside gh; sh writes the
  // bytes, as exec's output is text.
  async download(sources, out) {
    for (const s of sources) {
      // URLs come from API answers: only web addresses reach curl, and gh only https.
      if (!(s.gh ? /^https:\/\//i : /^https?:\/\//i).test(s.url)) continue;
      const get = s.gh ? 'mkdir -p "$(dirname "$2")" && gh api "$1" > "$2"' : 'curl -fsSL --max-time 15 --create-dirs -o "$2" "$1"';
      const r = await exec("sh", ["-c", `${get} && file -b --mime-type "$2"`, "sh", s.url, out]).catch(() => null);
      if (r?.code === 0 && r.stdout.startsWith("image/")) return true;
    }
    // A login page would stay in .cache/, which is never pruned.
    await exec("sh", ["-c", `rm -f "$1"`, "sh", out]).catch(() => null);
    return false;
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(props) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: MOD, kind: "popup", width: 200, height: 360, props: { role: "menu", ...props } });
  }

  // The same "Move to group…" dialog as the space menu, for the active space.
  // Worktree spaces nested under their repo follow it, as in the menu.
  moveActive() {
    const active = spaces().find((s) => s.active);
    if (!active) return;
    if (this.ordered().find((r) => r.w.id === active.id)?.tree) {
      notify({ title: "Worktree spaces stay under their repo", body: "Move the repo's space instead.", level: "info", timeout: 3000 });
      return;
    }
    openOverlay({ mod: MOD, kind: "dialog", width: 380, props: { role: "move", space: active.id } });
  }

  // Swaps the active space with the one above (by -1) or below (by 1) among the
  // spaces of its machine and group, as the sidebar lists them.
  shiftActive(by) {
    const all = spaces();
    const at = all.findIndex((s) => s.active);
    if (at < 0) return;
    const active = all[at];
    const state = load();
    const group = (s) => groupOf(state, s)?.id ?? null;
    const peer = (s) => (s.machine ?? null) === (active.machine ?? null) && group(s) === group(active);
    let to = at + by;
    while (to >= 0 && to < all.length && !peer(all[to])) to += by;
    if (to < 0 || to >= all.length) return;
    run("space.move", { id: active.id, index: to + 1 });
  }

  // Swaps the active space's active tab with the one left (by -1) or right (by 1) of it.
  shiftTab(by) {
    const tabs = spaces().find((s) => s.active)?.tabs ?? [];
    const at = tabs.findIndex((c) => c.active);
    const to = at + by;
    if (at < 0 || to < 0 || to >= tabs.length) return;
    run("tab.move", { id: tabs[at].id, index: to + 1 });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      out.at(-1).kids = kids.length; // a repo row with worktrees under it names its branch
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : this.section(rows, null, t, collapsed);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      return [head, ...(folded ? [] : mine.length ? this.section(mine, m, t, collapsed) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // A machine's rows: its groups first, each a header and, unless folded, the groups
  // inside it and then its spaces (a worktree stays under its checkout's row, in that
  // row's group), then the spaces in no group.
  section(rows, machine, t, collapsed) {
    const state = load();
    const blocks = [];
    for (const r of rows) r.tree && blocks.length ? blocks.at(-1).push(r) : blocks.push([r]);
    const draw = (r, group, depth) => (collapsed ? this.compact(r, t) : this.row(r, t, group, depth));
    const inside = (g) => blocks.filter((b) => (groupOf(state, b[0].w)?.id ?? null) === (g?.id ?? null)).flat();
    const deep = (g) => [...within(state, g.id)].flatMap((id) => inside(state.groups.find((o) => o.id === id)));
    for (const { g } of tree(state, machine)) {
      if (g.folded && deep(g).some((r) => r.w.id === this.arrived)) {
        unfold(g.id);
        g.folded = false;
      }
    }
    const level = (parent, depth) => childrenOf(state, machine, parent).flatMap((g) => [
      this.groupHead(g, deep(g), t, collapsed, depth),
      ...(g.folded ? [] : [...level(g.id, depth + 1), ...inside(g).map((r) => draw(r, g, depth + 1))]),
    ]);
    return [...level(null, 0), ...inside(null).map((r) => draw(r, null, 0))];
  }

  // Where a dragged header lands on this one: its top and bottom edges put it beside
  // as a sibling, the middle puts it inside.
  zoneAt(e) {
    const y = e?.local_position?.y;
    const h = e?.bounds?.height ?? 26;
    return y == null ? "into" : y < h / 4 ? "above" : y > (h * 3) / 4 ? "below" : "into";
  }

  groupHead(g, members, t, collapsed, depth) {
    const key = `group:${g.id}`;
    const target = this.pressed !== null && this.over === key;
    // Folded over the shown space: the header stands in for its row.
    const holds = g.folded && members.some((r) => r.w.active);
    const fits = () => {
      const state = load();
      const d = state.groups.find((o) => o.id === this.dragged);
      return Boolean(d) && d.machine === g.machine && !within(state, d.id).has(g.id);
    };
    const landing = this.dragged !== null && this.dragged !== g.id && this.over === key;
    return h_flex()
      .relative()
      .id(`group-${g.id}`)
      .h(26)
      .flex_none()
      .px(collapsed ? 0 : 8)
      .when(!collapsed && depth > 0, (el) => el.ml(12 * depth))
      .gap(7)
      .items_center()
      .when(collapsed, (el) => el.justify_center())
      .rounded(7)
      .text_size(12)
      .text_color(t.muted)
      .cursor_pointer()
      .when(target || holds || (landing && this.zone === "into"), (el) => el.bg(t.selected))
      .when(!target && !holds && !landing, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.dragged === g.id && this.over !== key, (el) => el.opacity(0.5))
      .when(landing && this.zone !== "into", (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.zone === "above", (line) => line.top(0))
          .when(this.zone === "below", (line) => line.bottom(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = null;
        this.dragged = g.id;
        this.over = key;
        this.zone = null;
      })
      .on_mouse_down("right", () => this.menu({ group: g.id }))
      .on_mouse_move((e, cx) => {
        if (this.dragged !== null) {
          const over = this.dragged === g.id || fits() ? key : null;
          const zone = over && this.dragged !== g.id ? this.zoneAt(e) : null;
          if (this.over !== over || this.zone !== zone) {
            this.over = over;
            this.zone = zone;
            cx.notify();
          }
          return;
        }
        const source = spaces()[this.pressed];
        const over = source && !this.pressedTree && (source.machine ?? null) === g.machine ? key : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (e, cx) => {
        const dragged = this.dragged;
        const zone = this.zone ?? this.zoneAt(e);
        this.dragged = null;
        this.zone = null;
        if (this.over !== key) return;
        const source = spaces()[this.pressed];
        if (dragged === g.id) toggle(g.id);
        else if (dragged !== null) {
          reorder(dragged, g.id, zone);
          if (zone === "into") unfold(g.id);
        }
        else if (source) assign(source.id, g.id);
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none().text_color(t.dim))
      .when(!collapsed, (el) => el
        .child(div().flex_1().truncate().child(g.name))
        .child(svg(`mods/workspace-chrome/chevron-${g.folded ? "right" : "down"}.svg`).size(11).flex_none().text_color(t.dim)));
  }

  // Onto a row: the dragged space joins that row's group and takes its place there.
  // A worktree under its checkout only moves: it follows its checkout's group.
  drop(from, to, group) {
    const source = spaces()[from];
    if (!this.pressedTree && (load().spaces[source.id] ?? null) !== (group?.id ?? null)) assign(source.id, group?.id ?? null);
    run("space.move", { id: source.id, index: to + 1 });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t, kids = 0) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    // With worktrees under it, the repo row always says its branch (main too), so it's
    // clear which checkout is which.
    const branch = same(raw) || (!kids && (raw === "master" || raw === "main")) ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree, kids }, t, group, depth) {
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(depth > 0, (el) => el.ml(12 * depth))
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.dragged = null;
        this.pressed = i;
        this.pressedTree = Boolean(tree);
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        if (this.dragged !== null && this.over !== null) {
          this.over = null;
          cx.notify();
        }
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) this.drop(from, i, group);
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu({ space: w.id, nested: Boolean(tree) }))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          // Worktree: a nested arrow under its repo's row, then the branch icon.
          .when(Boolean(tree), el => el.pl(6).gap(5)
            .child(div().flex_none().text_size(13).text_color(t.muted).child("↳"))
            .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.accent)))
          .when(!tree && Boolean(this.pics[g?.repo]), el => el.child(image(this.pics[g.repo]).size(18).flex_none().rounded(5)))
          .when(!tree && !this.pics[g?.repo], el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t, kids) : div().flex_1()),
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    prune();
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const active = sp.find((s) => s.active)?.id ?? null;
    this.arrived = active !== this.shownSpace ? active : null;
    this.shownSpace = active;
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          // Asks: a new space (and on which machine) or a new worktree of the active space's repo.
          .on_click(() => this.menu({ add: true, space: spaces().find((s) => s.active)?.id })).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.dragged = null; this.zone = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
