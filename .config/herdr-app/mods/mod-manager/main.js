// Herdr app mods from one panel: what is installed, the Community index (GitHub topic herdr-mod),
// install with a review of what each mod does, update, remove, and hand a mod to an AI agent to
// change. Port of speardragon's herdr-plugin-manager (MIT) from herdr plugins to Herdr app mods.

import { View, div, uniform_list } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { exec, appHome, readTextFile, writeTextFile, shared, setShared, props, closeOverlay, notify, theme, run, knownAgents } from "herdr";
import * as core from "./core.js";

const RECORDS = "mod-manager.installed";
const PAGE = 10;
const FETCH = 50;
const ROW = 44;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HINTS = {
  list: [["↑↓", "move"], ["enter", "ask AI"], ["/", "filter"], ["u", "update"], ["x", "remove"], ["tab", "marketplace"], ["esc", "close"]],
  market: [["↑↓", "move"], ["←→", "page"], ["enter", "review"], ["/", "search"], ["s", "sort"], ["tab", "installed"], ["esc", "back"]],
  packages: [["↑↓", "choose"], ["enter", "review"], ["esc", "back"]],
  review: [["y", "install"], ["o", "open repo"], ["esc", "cancel"]],
};

const io = {
  exec: (cmd, args, opts) => exec(cmd, args, opts),
  readText: (path) => readTextFile(path),
  async writeText(path, text) {
    await writeTextFile(path, text, await readTextFile(path));
  },
};

const anonymous = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  return { status: res.status, text: await res.text() };
};

const records = () => shared(RECORDS) ?? [];
const saveRecords = (list) => setShared(RECORDS, list);
const cacheDir = () => `${appHome()}/.mod-manager-cache`;
const repoPage = (source) => (/^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}` : null);
const short = (sha) => (sha ? sha.slice(0, 7) : "?");

// WCAG 2.0 AA: text needs 4.5:1 against what it sits on. Theme colors like `dim` often fall short,
// so each text color is moved toward the theme's foreground until it passes on every background.
const rgb = (c) => {
  const m = /^#([0-9a-f]{6})/i.exec(c ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = (c) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
function readable(color, toward, backgrounds, min = 4.5) {
  const from = rgb(color);
  const to = rgb(toward);
  const bgs = backgrounds.map(rgb);
  if (!from || !to || bgs.some((b) => !b)) return color;
  for (let step = 0; step <= 10; step++) {
    const c = from.map((v, i) => v + ((to[i] - v) * step) / 10);
    if (bgs.every((b) => contrast(c, b) >= min)) return hex(c);
  }
  return toward;
}

function palette() {
  const t = theme();
  const on = [t.popover, t.selected, t.raised];
  const text = (c) => readable(c, t.foreground, on);
  return {
    bg: t.popover, card: t.raised, sel: t.selected, hover: t.hover, border: t.border, input: t.input, bar: t.accent,
    fg: t.foreground, muted: text(t.muted), dim: text(t.dim), accent: text(t.accent),
    ok: text(t.done), warn: text(t.blocked), busy: text(t.working),
    solid: t.solid, solidFg: readable(t.solid_foreground, t.background, [t.solid]),
  };
}

function aiTask(mod, request) {
  const home = appHome();
  const dir = `${home}/mods/${mod.name}`;
  const lines = [`Read ${home}/AGENTS.md, then change the Herdr mod "${mod.name}" at ${dir}: ${request}`];
  if (mod.kind === "herdr") lines.push(`It ships with Herdr and is read-only: clone it first (herdr-app do mod.clone '{"name":"${mod.name}","as":"${mod.name}-custom"}'), point the layout I use at the clone, and edit the clone.`);
  if (mod.record) lines.push(`Mod Manager installed it from ${mod.record.source}; updating it there replaces local edits, so say so if the change belongs upstream.`);
  if (mod.symlink) lines.push(`mods/${mod.name} is a symlink: the edit lands in its target folder.`);
  lines.push("Run herdr-app check on the edited mod until it passes, then tell me what changed.");
  return lines.join(" ");
}

export default class ModManager extends View {
  init(_props, cx) {
    this.mode = "list";
    this.mods = [];
    this.filter = "";
    this.at = 0;
    this.updates = {};
    this.message = null;
    this.level = "info";
    this.busy = null;
    this.confirm = null;
    this.market = { items: [], total: 0, fetchedPages: 0, page: 0, at: 0, query: "", sort: "stars", error: null, loading: false };
    this.review = null;
    this.searching = false;
    this.asking = null;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Type to filter" });
    this.input.on("change", (_e, cx) => {
      if (this.mode !== "list") return;
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => {
      this.searching = false;
      this.handle.focus();
      if (this.mode === "market") {
        this.market.query = this.input.value();
        cx.spawn(async (cx) => this.loadMarket(cx, true));
      }
      cx.notify();
    });
    this.askInput = InputState.new({ placeholder: "Describe the change, e.g. make the text bigger" });
    this.askInput.on("submit", (_e, cx) => {
      const mod = this.asking;
      const request = this.askInput.value().trim();
      this.asking = null;
      this.handle.focus();
      if (mod && request) cx.spawn(async (cx) => this.askAI(cx, mod, request));
      cx.notify();
    });
    this.handle.focus();
    cx.timer.after(100, () => this.handle.focus());
    cx.spawn(async (cx) => this.refresh(cx));
    // A panel closed while cloning can't clean up after itself; its clone goes the next time.
    exec("find", [cacheDir(), "-mindepth", "1", "-maxdepth", "1", "-mmin", "+60", "-exec", "rm", "-rf", "{}", "+"]).catch(() => {});
    if (props()?.start === "market") {
      this.mode = "market";
      cx.spawn(async (cx) => this.loadMarket(cx, true));
    }
    if (props()?.review) cx.spawn(async (cx) => { await this.refresh(cx); await this.startReview(cx, props().review); });
  }

  dismiss() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // Closing the panel mid-review leaves no clone behind.
  async close() {
    if (this.review) await exec("rm", ["-rf", this.review.fetched.dir]);
  }

  async refresh(cx) {
    try {
      this.mods = await core.listMods(io, { appHome: appHome(), records: records() });
    } catch (e) {
      this.message = `could not list the mods: ${e?.message ?? e}`;
    }
    cx.notify();
    for (const r of records()) {
      core.remoteSha(io, r.source)
        .then((sha) => { this.updates[r.source] = sha && sha !== r.sha ? sha : null; cx.notify(); })
        .catch(() => {});
    }
  }

  async loadMarket(cx, reset) {
    const m = this.market;
    if (reset) Object.assign(m, { items: [], total: 0, fetchedPages: 0, page: 0, at: 0 });
    m.loading = true;
    m.error = null;
    cx.notify();
    try {
      const r = await core.searchMarket(io, { query: m.query, sort: m.sort, page: m.fetchedPages + 1, perPage: FETCH }, anonymous);
      m.items.push(...r.items);
      m.total = r.total;
      m.fetchedPages += 1;
    } catch (e) {
      m.error = String(e?.message ?? e);
    }
    m.loading = false;
    cx.notify();
  }

  // Loads the pages the person reaches, FETCH results at a time.
  ensurePage(cx) {
    const m = this.market;
    if (!m.loading && (m.page + 1) * PAGE > m.items.length && m.items.length < m.total) {
      cx.spawn(async (cx) => this.loadMarket(cx, false));
    }
  }

  async work(cx, label, fn) {
    this.busy = label;
    this.message = null;
    this.level = "info";
    cx.notify();
    try {
      await fn();
    } catch (e) {
      this.message = String(e?.message ?? e);
      this.level = "error";
    }
    this.busy = null;
    cx.notify();
  }

  async startReview(cx, source) {
    await this.work(cx, `downloading ${source}…`, async () => {
      const fetched = await core.fetchSource(io, source, cacheDir());
      const packages = core.findPackages(fetched.files);
      if (!packages.length) {
        await exec("rm", ["-rf", fetched.dir]);
        throw new Error(`${source} has no mods/<name>/main.js folder`);
      }
      this.review = { source, fetched, packages, at: 0, plan: null, pkg: null };
      if (packages.length === 1) await this.planFor(packages[0]);
      else this.mode = "packages";
    });
  }

  async planFor(pkg) {
    const r = this.review;
    const record = records().find((x) => x.source === r.source && x.prefix === pkg.prefix) ?? null;
    const layouts = (await exec("ls", [`${appHome()}/layouts`])).stdout.split("\n").filter(Boolean);
    r.pkg = pkg;
    r.record = record;
    r.plan = await core.planInstall(io, {
      appHome: appHome(), dir: r.fetched.dir, pkg, record, existingMods: this.mods.map((m) => m.name), existingLayouts: layouts,
    });
    this.mode = "review";
  }

  async finishReview() {
    if (this.review) await exec("rm", ["-rf", this.review.fetched.dir]);
    this.review = null;
  }

  async install(cx) {
    const r = this.review;
    await this.work(cx, `installing ${r.pkg.name}…`, async () => {
      const rec = await core.applyInstall(io, {
        appHome: appHome(), plan: r.plan, source: r.source, prefix: r.pkg.prefix, sha: r.fetched.sha, record: r.record,
      });
      saveRecords([...records().filter((x) => !(x.source === rec.source && x.prefix === rec.prefix)), rec]);
      const failures = await core.checkMods(io, appHome(), rec.mods);
      const verb = r.record ? "updated" : "installed";
      this.message = failures.length
        ? `${r.pkg.name} ${verb}, but herdr-app check failed on ${failures.map((f) => f.mod).join(", ")}: ${failures[0].error.split("\n")[0]}`
        : `${r.pkg.name} ${verb} (${rec.mods.join(", ")})${rec.layouts.length ? `; layouts: ${rec.layouts.join(", ")} (switch with ctrl-shift-l)` : ""}`;
      this.level = failures.length ? "error" : "ok";
      notify({ title: `mod ${verb}`, body: this.message, level: failures.length ? "warning" : "success" });
      this.updates[rec.source] = null;
      await this.finishReview();
      this.mode = "list";
      this.mods = await core.listMods(io, { appHome: appHome(), records: records() });
    });
  }

  async remove(cx, mod) {
    await this.work(cx, `removing ${mod.name}…`, async () => {
      if (mod.record) {
        await core.uninstall(io, { appHome: appHome(), record: mod.record });
        saveRecords(records().filter((x) => x !== mod.record && !(x.source === mod.record.source && x.prefix === mod.record.prefix)));
        this.say(`Removed ${mod.record.mods.join(", ")}.`, "ok");
      } else {
        await core.removeLocal(io, { appHome: appHome(), name: mod.name, symlink: mod.symlink });
        this.say(mod.symlink ? `Removed the link ${mod.name}; its target folder stays.` : `Removed ${mod.name}.`, "ok");
      }
      this.mods = await core.listMods(io, { appHome: appHome(), records: records() });
      this.at = Math.min(this.at, Math.max(0, this.visibleMods().length - 1));
    });
  }

  // Opens a new tab with the person's most-used installed agent, briefed to edit this mod.
  async askAI(cx, mod, request) {
    await this.work(cx, `starting an agent for ${mod.name}…`, async () => {
      const agent = (await knownAgents()).find((a) => a.installed);
      if (!agent) throw new Error("no installed agent found (see programs.json `run`)");
      run("tab.new", { name: `mod: ${mod.name}`, folder: appHome(), argv: agent.run, task: aiTask(mod, request) });
      this.dismiss();
    });
  }

  // Bulk update installs without the per-package review only for packages whose plan has no
  // clash and adds no new risk; anything else is left for `u`, one at a time.
  async updateAll(cx, pending) {
    const done = [];
    const skipped = [];
    await this.work(cx, `updating ${pending.length} package(s)…`, async () => {
      for (const rec of pending) {
        const fetched = await core.fetchSource(io, rec.source, cacheDir());
        try {
          const pkg = core.findPackages(fetched.files).find((p) => p.prefix === rec.prefix);
          if (!pkg) { skipped.push(`${rec.source}: the package is gone from the repo`); continue; }
          const layouts = (await exec("ls", [`${appHome()}/layouts`])).stdout.split("\n").filter(Boolean);
          const plan = await core.planInstall(io, { appHome: appHome(), dir: fetched.dir, pkg, record: rec, existingMods: this.mods.map((m) => m.name), existingLayouts: layouts });
          const before = new Set(rec.risks ?? []);
          const fresh = plan.risks.map((x) => x.label).filter((l) => !before.has(l));
          if (plan.clashes.length || fresh.length) { skipped.push(`${pkg.name}: ${plan.clashes.length ? "name clash" : `now ${fresh.join(", ")}`}`); continue; }
          const next = await core.applyInstall(io, { appHome: appHome(), plan, source: rec.source, prefix: rec.prefix, sha: fetched.sha, record: rec });
          saveRecords([...records().filter((x) => !(x.source === rec.source && x.prefix === rec.prefix)), next]);
          this.updates[rec.source] = null;
          done.push(pkg.name);
        } finally {
          await exec("rm", ["-rf", fetched.dir]);
        }
      }
      this.mods = await core.listMods(io, { appHome: appHome(), records: records() });
      this.message = [done.length ? `updated: ${done.join(", ")}` : "", skipped.length ? `skipped (use u): ${skipped.join("; ")}` : ""].filter(Boolean).join(" · ");
    });
  }

  selectedMod() {
    return this.visibleMods()[this.at] ?? null;
  }

  visibleMods() {
    const q = this.filter.trim().toLowerCase();
    return q ? this.mods.filter((m) => m.name.toLowerCase().includes(q)) : this.mods;
  }

  updateCount() {
    return records().filter((r) => this.updates[r.source]).length;
  }

  // ---- actions shared by keys and buttons ----

  switchTab(cx, to) {
    if (this.mode !== "list" && this.mode !== "market") return;
    this.mode = to;
    this.message = null;
    this.searching = false;
    this.asking = null;
    if (to === "market" && !this.market.fetchedPages) cx.spawn(async (cx) => this.loadMarket(cx, true));
  }

  startSearch() {
    this.searching = true;
    this.input.set_value(this.mode === "market" ? this.market.query : this.filter);
    this.input.focus();
  }

  select(i) {
    const list = this.visibleMods();
    this.at = Math.max(0, Math.min(list.length - 1, i));
    this.scroll.scroll_to_item(this.at);
  }

  openUrl(url) {
    exec("xdg-open", [url]).catch(() => exec("open", [url]));
  }

  ask(mod) {
    this.asking = mod;
    this.askInput.set_value("");
    this.askInput.focus();
  }

  update(cx, mod) {
    if (mod.kind !== "installed") this.say(mod.kind === "herdr" ? "Herdr's own mods update with the app." : "Only mods installed here have a source to update from.");
    else cx.spawn(async (cx) => this.startReview(cx, mod.record.source));
  }

  updateAllAsk(cx) {
    const pending = records().filter((r) => this.updates[r.source]);
    if (!pending.length) this.say("Everything is up to date.", "ok");
    else this.confirm = { text: `Update ${pending.length} package(s): ${pending.map((r) => r.mods.join("+")).join(", ")}?`, run: (cx) => this.updateAll(cx, pending) };
  }

  removeAsk(mod) {
    if (mod.kind === "herdr") return this.say("Herdr's own mods can't be removed. Press enter to have AI edit a clone instead.");
    const what = mod.record ? `${mod.record.mods.join(", ")} and the keys it added` : mod.symlink ? `the link ${mod.name} (its target folder stays)` : `the folder mods/${mod.name}`;
    this.confirm = { text: `Remove ${what}?`, danger: true, run: (cx) => this.remove(cx, mod) };
  }

  say(text, level = "info") {
    this.message = text;
    this.level = level;
  }

  answer(cx, yes) {
    const c = this.confirm;
    this.confirm = null;
    if (yes) cx.spawn(async (cx) => c.run(cx));
    else this.say("Cancelled.");
  }

  cancelReview() {
    const back = this.review?.record ? "list" : "market";
    const done = this.finishReview();
    done.catch(() => {});
    this.mode = back;
    this.say("Cancelled.");
  }

  // ---- keys ----

  onKey(e, cx) {
    if (this.searching || this.asking) {
      if (e.key === "escape") {
        this.searching = false;
        this.asking = null;
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
      }
      return;
    }
    if (this.busy) return;
    const k = e.key;
    const ch = e.key_char ?? k;
    if (this.confirm) {
      if (k === "y" || k === "enter") this.answer(cx, true);
      else if (k === "n" || k === "escape") this.answer(cx, false);
      else return;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (this.mode === "list" || this.mode === "market") {
      if (k === "tab") { this.switchTab(cx, this.mode === "list" ? "market" : "list"); cx.stop_propagation(); cx.notify(); return; }
      if (ch === "1" || ch === "2") { this.switchTab(cx, ch === "1" ? "list" : "market"); cx.stop_propagation(); cx.notify(); return; }
      if (k === "/") { this.startSearch(); cx.stop_propagation(); cx.notify(); return; }
    }
    const handled = this[`${this.mode}Key`](k, ch, cx);
    if (handled === false) return;
    cx.stop_propagation();
    cx.notify();
  }

  listKey(k, ch, cx) {
    const mod = this.selectedMod();
    if (k === "down" || k === "j") this.select(this.at + 1);
    else if (k === "up" || k === "k") this.select(this.at - 1);
    else if (k === "home" || ch === "g") this.select(0);
    else if (k === "end" || ch === "G") this.select(this.visibleMods().length - 1);
    else if (k === "escape" || k === "q") {
      if (this.filter) { this.filter = ""; this.input.set_value(""); this.at = 0; }
      else this.dismiss();
    }
    else if (k === "m") this.switchTab(cx, "market");
    else if (ch === "r") cx.spawn(async (cx) => this.refresh(cx));
    else if (ch === "U") this.updateAllAsk(cx);
    else if (!mod) return false;
    else if (k === "enter" || ch === "a") this.ask(mod);
    else if (ch === "u") this.update(cx, mod);
    else if (ch === "x") this.removeAsk(mod);
    else if (ch === "f") this.openUrl(`${appHome()}/mods/${mod.name}`);
    else if (ch === "o") {
      const url = mod.record && repoPage(mod.record.source);
      if (url) this.openUrl(url);
      else this.say("No known repository for this mod.");
    } else return false;
  }

  marketKey(k, ch, cx) {
    const m = this.market;
    const pageItems = m.items.slice(m.page * PAGE, (m.page + 1) * PAGE);
    const item = pageItems[m.at];
    if (k === "escape" || k === "q") this.switchTab(cx, "list");
    else if (k === "down" || k === "j") {
      if (m.at < pageItems.length - 1) m.at += 1;
      else this.page(cx, 1);
    } else if (k === "up" || k === "k") {
      if (m.at > 0) m.at -= 1;
      else if (m.page > 0) { this.page(cx, -1); m.at = PAGE - 1; }
    } else if (k === "right" || k === "l" || k === "pagedown") this.page(cx, 1);
    else if (k === "left" || k === "h" || k === "pageup") this.page(cx, -1);
    else if (k === "s") this.toggleSort(cx);
    else if (k === "r") cx.spawn(async (cx) => this.loadMarket(cx, true));
    else if (!item) return false;
    else if (k === "o") this.openUrl(item.url);
    else if (k === "enter") cx.spawn(async (cx) => this.startReview(cx, item.fullName));
    else return false;
  }

  page(cx, by) {
    const m = this.market;
    const pages = Math.max(1, Math.ceil(m.total / PAGE));
    const next = m.page + by;
    if (next < 0 || next >= pages) return;
    m.page = next;
    m.at = 0;
    this.ensurePage(cx);
  }

  toggleSort(cx) {
    this.market.sort = this.market.sort === "stars" ? "updated" : "stars";
    cx.spawn(async (cx) => this.loadMarket(cx, true));
  }

  packagesKey(k, _ch, cx) {
    const r = this.review;
    if (k === "escape" || k === "q") { this.finishReview().catch(() => {}); this.mode = "market"; }
    else if (k === "down" || k === "j") r.at = Math.min(r.packages.length - 1, r.at + 1);
    else if (k === "up" || k === "k") r.at = Math.max(0, r.at - 1);
    else if (k === "enter") this.choosePackage(cx, r.at);
    else return false;
  }

  choosePackage(cx, i) {
    const r = this.review;
    r.at = i;
    cx.spawn(async (cx) => this.work(cx, "Checking the package…", () => this.planFor(r.packages[i])));
  }

  reviewKey(k, _ch, cx) {
    const r = this.review;
    if (k === "escape" || k === "n" || k === "q") this.cancelReview();
    else if (k === "o") { const url = repoPage(r.source); if (url) this.openUrl(url); }
    else if (k === "y" || k === "enter") this.confirmInstall(cx);
    else return false;
  }

  confirmInstall(cx) {
    const r = this.review;
    if (r.plan.clashes.length) this.say(`Won't install: ${r.plan.clashes.join(", ")} already exists. Remove or rename yours first.`, "error");
    else cx.spawn(async (cx) => this.install(cx));
  }

  // ---- building blocks ----

  keycap(p, key) {
    return div().px(6).h(22).flex().items_center().rounded(5).border_1().border_color(p.input).bg(p.bg)
      .text_size(13).font_semibold().text_color(p.fg).child(key);
  }

  // A clickable action. The key it also answers to is drawn as a keycap, and announced.
  button(p, id, label, key, onClick, style = "plain") {
    const fill = style === "primary" ? p.solid : p.bg;
    const color = style === "primary" ? p.solidFg : style === "danger" ? p.warn : p.fg;
    return h_flex().id(id).role("button").accessibility_label(key ? `${label}, key ${key}` : label)
      .h(38).px(14).gap(10).items_center().rounded(8).flex_none().cursor_pointer()
      .bg(fill).border_1().border_color(style === "danger" ? p.warn : style === "primary" ? p.solid : p.input)
      .hover((s) => s.opacity(0.88))
      .text_size(15).font_semibold().text_color(color)
      .on_click((_e, cx) => { this.handle.focus(); onClick(cx); cx.notify(); })
      .child(label)
      .when(Boolean(key), (el) => el.child(this.keycap(p, key)));
  }

  pill(p, text, color) {
    return div().px(10).h(26).flex().items_center().rounded(13).border_1().border_color(color)
      .text_size(13).font_semibold().text_color(color).child(text);
  }

  fact(p, label, value) {
    return h_flex().gap(12).items_start()
      .child(div().w(96).flex_none().text_size(14).text_color(p.muted).child(label))
      .child(div().flex_1().min_w(0).whitespace_normal().text_size(15).text_color(p.fg).child(value));
  }

  card(p, children) {
    return v_flex().p(18).gap(14).rounded(12).bg(p.card).border_1().border_color(p.border).children(children);
  }

  tab(p, id, label, count, active, onClick) {
    return v_flex().id(id).role("tab").aria_selected(active).cursor_pointer().gap(6).px(4)
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(h_flex().gap(8).items_center().h(30)
        .child(div().text_size(16).font_semibold().text_color(active ? p.fg : p.muted).child(label))
        .when(count != null, (el) => el.child(div().px(8).h(22).flex().items_center().rounded(11).bg(active ? p.sel : p.card)
          .text_size(13).text_color(p.fg).child(String(count)))))
      .child(div().h(3).rounded(2).bg(active ? p.bar : p.bg));
  }

  header(p) {
    const tabs = this.mode === "list" || this.mode === "market";
    const updates = this.updateCount();
    return h_flex().gap(28).items_end().pb(2).border_b_1().border_color(p.border)
      .child(v_flex().gap(2).pb(10)
        .child(div().font_family("Geist").text_size(22).font_semibold().text_color(p.fg).child("Mod Manager"))
        .child(div().text_size(14).text_color(p.muted).child(updates ? `${updates} update${updates > 1 ? "s" : ""} available` : "Everything in ~/.config/herdr-app/mods")))
      .when(tabs, (el) => el.child(h_flex().role("tab_list").gap(22)
        .child(this.tab(p, "tab-installed", "Installed", this.mods.length, this.mode === "list", (cx) => this.switchTab(cx, "list")))
        .child(this.tab(p, "tab-market", "Marketplace", this.market.total || null, this.mode === "market", (cx) => this.switchTab(cx, "market")))))
      .child(div().flex_1())
      .child(div().pb(10).child(this.button(p, "close", "Close", "esc", () => this.dismiss())));
  }

  banner(p) {
    if (this.busy) {
      return h_flex().role("status").gap(12).items_center().px(16).h(44).rounded(10).bg(p.card).border_1().border_color(p.border)
        .child(div().text_size(18).text_color(p.busy).frames(SPINNER, 80))
        .child(div().text_size(15).text_color(p.fg).child(this.busy));
    }
    if (this.confirm) {
      const c = this.confirm;
      return h_flex().role("alert").gap(12).items_center().px(16).py(8).rounded(10).bg(p.card).border_2().border_color(c.danger ? p.warn : p.bar)
        .child(div().text_size(18).font_semibold().text_color(c.danger ? p.warn : p.accent).child("?"))
        .child(div().flex_1().min_w(0).whitespace_normal().text_size(15).font_semibold().text_color(p.fg).child(c.text))
        .child(this.button(p, "confirm-yes", "Yes", "y", (cx) => this.answer(cx, true), c.danger ? "danger" : "primary"))
        .child(this.button(p, "confirm-no", "No", "n", (cx) => this.answer(cx, false)));
    }
    if (this.message) {
      const [glyph, color] = { ok: ["✓", p.ok], error: ["!", p.warn], info: ["i", p.accent] }[this.level] ?? ["i", p.accent];
      return h_flex().role(this.level === "error" ? "alert" : "status").gap(12).items_center().px(16).py(10).rounded(10).bg(p.card)
        .border_1().border_color(color)
        .child(div().w(22).h(22).flex_none().flex().items_center().justify_center().rounded(11).border_1().border_color(color)
          .text_size(13).font_semibold().text_color(color).child(glyph))
        .child(div().flex_1().min_w(0).whitespace_normal().text_size(15).text_color(p.fg).child(this.message))
        .child(h_flex().id("dismiss-message").role("button").accessibility_label("Dismiss message").cursor_pointer().px(8).h(28).items_center()
          .rounded(6).hover((s) => s.bg(p.hover)).text_size(14).text_color(p.muted).child("Dismiss")
          .on_click((_e, cx) => { this.message = null; cx.notify(); }));
    }
    return null;
  }

  searchBox(p) {
    const market = this.mode === "market";
    if (this.asking) {
      return h_flex().h(46).px(14).gap(12).items_center().rounded(10).border_2().border_color(p.bar).bg(p.bg)
        .child(div().flex_none().text_size(15).font_semibold().text_color(p.accent).child(`Ask AI to change ${this.asking.name}:`))
        .child(Input.new(this.askInput).flex_1().h_full().text_size(15).text_color(p.fg))
        .child(this.keycap(p, "enter")).child(this.keycap(p, "esc"));
    }
    if (!this.searching && !(market ? this.market.query : this.filter)) return div();
    return h_flex().id("search").h(46).px(14).gap(12).items_center().rounded(10).border_1()
      .border_color(this.searching ? p.bar : p.input).bg(p.bg).cursor_pointer()
      .on_click((_e, cx) => { if (!this.searching) { this.startSearch(); cx.notify(); } })
      .child(div().text_size(15).text_color(p.muted).child(market ? "Search" : "Filter"))
      .child(this.searching
        ? Input.new(this.input).flex_1().h_full().text_size(15).text_color(p.fg)
        : div().flex_1().text_size(15).text_color(p.fg).child(market ? this.market.query : this.filter))
      .child(this.keycap(p, this.searching ? "enter" : "/"));
  }

  footer(p) {
    return h_flex().gap(18).items_center().flex_wrap().pt(10).border_t_1().border_color(p.border).children(
      HINTS[this.mode].map(([key, what]) => h_flex().gap(6).items_center()
        .child(this.keycap(p, key)).child(div().text_size(14).text_color(p.muted).child(what))));
  }

  // ---- screens ----

  listView(p) {
    const mods = this.visibleMods();
    const kinds = { installed: "Installed", local: "Local", herdr: "Built-in" };
    const rows = uniform_list("mods", mods.length, (i) => mods[i].name, (range) => {
      const out = [];
      for (let i = range.start; i < range.end; i++) {
        const m = mods[i];
        const sel = i === this.at;
        const update = m.record && this.updates[m.record.source];
        const [glyph, color] = update ? ["↑", p.warn] : m.kind === "installed" ? ["●", p.ok] : m.kind === "local" ? ["○", p.muted] : ["◇", p.muted];
        out.push(h_flex().id(`mod-${m.name}`).role("list_box_option").aria_selected(sel).h(ROW).pr(14).gap(12).items_center()
          .rounded(8).cursor_pointer().when(sel, (el) => el.bg(p.sel)).hover((s) => s.bg(sel ? p.sel : p.hover))
          .child(div().w(4).h(24).rounded(2).bg(sel ? p.bar : p.bg).when(!sel, (el) => el.opacity(0)))
          .child(div().w(18).flex_none().text_size(15).text_color(color).child(glyph))
          .child(div().flex_1().min_w(0).truncate().text_size(16).font_weight(sel ? 600 : 400).text_color(p.fg).child(m.name))
          .child(div().flex_none().text_size(14).text_color(update ? p.warn : m.kind === "installed" ? p.accent : p.muted)
            .child(update ? "Update available" : `${kinds[m.kind]}${m.symlink ? " · link" : ""}`)));
      }
      return out;
    }).track_scroll(this.scroll).size_full()
      .on_item_click((key, cx) => { this.at = Math.max(0, mods.findIndex((m) => m.name === key)); this.handle.focus(); cx.notify(); });
    const listPane = v_flex().role("list_box").accessibility_label("Mods").flex_1().min_w(0).min_h(0).gap(8)
      .child(this.searchBox(p))
      .child(mods.length
        ? v_flex().relative().flex_1().min_h(0).child(rows).child(Scrollbar.vertical("mods").absolute().inset_0())
        : div().p(16).text_size(15).text_color(p.muted).child(this.filter ? `No mod matches "${this.filter}".` : "Loading your mods…"));
    return h_flex().flex_1().min_h(0).gap(20).items_start()
      .child(listPane.h_full())
      .child(this.modInspector(p, this.selectedMod()));
  }

  modInspector(p, mod) {
    const box = v_flex().w(360).flex_none().h_full().gap(16).overflow_y_scrollbar();
    if (!mod) return box;
    const r = mod.record;
    const update = r && this.updates[r.source];
    const [status, color] = update ? ["Update available", p.warn] : mod.kind === "installed" ? ["Installed from GitHub", p.ok] : mod.kind === "local" ? ["Local mod", p.accent] : ["Built into Herdr", p.muted];
    const facts = r
      ? [["Source", `${r.source}${r.prefix ? ` (${r.prefix})` : ""}`], ["Commit", `${short(r.sha)}${update ? ` → ${short(update)}` : ""}`],
        ["Installed", r.at?.slice(0, 10) ?? "?"], ["Mods", r.mods.join(", ")],
        r.layouts?.length ? ["Layouts", r.layouts.join(", ")] : null,
        r.keys?.length ? ["Keys", r.keys.map((k) => `${k.key} → ${k.action}`).join(", ")] : null].filter(Boolean)
      : [["Folder", `mods/${mod.name}${mod.symlink ? " (symlink)" : ""}`],
        ["Source", mod.kind === "herdr" ? "Ships with Herdr, read-only" : "No recorded source"]];
    const note = mod.kind === "herdr" ? "Ask AI makes an editable clone, so Herdr's copy stays untouched."
      : r ? "Ask AI edits this copy. Updating from GitHub later replaces those edits." : "Ask AI edits this folder in place.";
    const actions = [
      this.button(p, "act-ai", "Ask AI to edit", "enter", () => this.ask(mod), "primary"),
      update ? this.button(p, "act-update", "Update", "u", (cx) => this.update(cx, mod)) : null,
      r && repoPage(r.source) ? this.button(p, "act-repo", "Open repo", "o", () => this.openUrl(repoPage(r.source))) : null,
      this.button(p, "act-folder", "Open folder", "f", () => this.openUrl(`${appHome()}/mods/${mod.name}`)),
      mod.kind !== "herdr" ? this.button(p, "act-remove", "Remove", "x", () => this.removeAsk(mod), "danger") : null,
    ].filter(Boolean);
    return box.child(this.card(p, [
      v_flex().gap(10)
        .child(div().font_family("Geist").text_size(20).font_semibold().text_color(p.fg).whitespace_normal().child(mod.name))
        .child(h_flex().child(this.pill(p, status, color))),
      v_flex().gap(8).children(facts.map(([l, v]) => this.fact(p, l, v))),
      div().text_size(14).text_color(p.muted).whitespace_normal().child(note),
      h_flex().gap(10).flex_wrap().children(actions),
    ]));
  }

  marketView(p) {
    const m = this.market;
    const installed = new Set(records().map((r) => r.source));
    const pageItems = m.items.slice(m.page * PAGE, (m.page + 1) * PAGE);
    const pages = Math.max(1, Math.ceil(m.total / PAGE));
    const rows = pageItems.map((it, i) => {
      const sel = i === m.at;
      const has = installed.has(it.fullName);
      return h_flex().id(`market-${it.fullName}`).role("list_box_option").aria_selected(sel).h(ROW).pr(14).gap(12).items_center().flex_none()
        .rounded(8).cursor_pointer().when(sel, (el) => el.bg(p.sel)).hover((s) => s.bg(sel ? p.sel : p.hover))
        .on_click((_e, cx) => { m.at = i; this.handle.focus(); cx.notify(); })
        .child(div().w(4).h(24).rounded(2).bg(p.bar).when(!sel, (el) => el.opacity(0)))
        .child(div().w(18).flex_none().text_size(15).text_color(p.ok).child(has ? "✓" : ""))
        .child(div().w(280).flex_none().truncate().text_size(16).font_weight(sel ? 600 : 400).text_color(p.fg).child(it.fullName))
        .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(p.muted).child(it.description))
        .child(div().flex_none().text_size(14).text_color(p.fg).child(`★ ${it.stars}`));
    });
    const status = m.loading && !pageItems.length ? "Loading Community mods…" : m.error ? m.error : !m.total ? "No mods found." : null;
    const controls = h_flex().gap(10).items_center()
      .child(this.button(p, "sort", `Sort: ${m.sort === "stars" ? "Most stars" : "Recently updated"}`, "s", (cx) => this.toggleSort(cx)))
      .child(div().flex_1())
      .child(this.button(p, "prev", "‹ Prev", null, (cx) => this.page(cx, -1)))
      .child(div().text_size(14).text_color(p.fg).child(`Page ${m.page + 1} of ${pages}${m.loading ? " · loading…" : ""}`))
      .child(this.button(p, "next", "Next ›", null, (cx) => this.page(cx, 1)));
    const listPane = v_flex().role("list_box").accessibility_label("Community mods").flex_1().min_w(0).h_full().gap(10)
      .child(this.searchBox(p))
      .child(controls)
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(status
        ? [div().p(16).whitespace_normal().text_size(15).text_color(m.error ? p.warn : p.muted).child(status)]
        : rows));
    return h_flex().flex_1().min_h(0).gap(20).items_start()
      .child(listPane)
      .child(this.marketInspector(p, pageItems[m.at], installed));
  }

  marketInspector(p, it, installed) {
    const box = v_flex().w(360).flex_none().h_full().gap(16).overflow_y_scrollbar();
    if (!it) return box;
    const has = installed.has(it.fullName);
    return box.child(this.card(p, [
      v_flex().gap(10)
        .child(div().font_family("Geist").text_size(20).font_semibold().text_color(p.fg).whitespace_normal().child(it.fullName))
        .child(h_flex().gap(8).child(this.pill(p, has ? "Installed" : "Not installed", has ? p.ok : p.muted)).child(this.pill(p, `★ ${it.stars}`, p.fg))),
      div().text_size(15).text_color(p.fg).whitespace_normal().child(it.description || "No description."),
      this.fact(p, "Updated", it.pushedAt?.slice(0, 10) ?? "?"),
      div().text_size(14).text_color(p.muted).whitespace_normal().child("Install opens a review first: what it adds, whether it runs programs, reaches the network or touches files."),
      h_flex().gap(10).flex_wrap()
        .child(this.button(p, "act-review", has ? "Review update" : "Review & install", "enter", (cx) => cx.spawn(async (cx) => this.startReview(cx, it.fullName)), "primary"))
        .child(this.button(p, "act-open", "Open repo", "o", () => this.openUrl(it.url))),
    ]));
  }

  packagesView(p) {
    const r = this.review;
    return v_flex().flex_1().min_h(0).gap(14)
      .child(div().font_family("Geist").text_size(20).font_semibold().text_color(p.fg).child(`${r.source} has ${r.packages.length} packages`))
      .child(div().text_size(14).text_color(p.muted).child(`Commit ${short(r.fetched.sha)}. Pick one to review.`))
      .child(v_flex().role("list_box").flex_1().min_h(0).overflow_y_scrollbar().children(r.packages.map((pkg, i) => {
        const sel = i === r.at;
        return h_flex().id(`pkg-${pkg.prefix}`).role("list_box_option").aria_selected(sel).h(ROW).pr(14).gap(12).items_center().flex_none()
          .rounded(8).cursor_pointer().when(sel, (el) => el.bg(p.sel)).hover((s) => s.bg(sel ? p.sel : p.hover))
          .on_click((_e, cx) => { this.choosePackage(cx, i); cx.notify(); })
          .child(div().w(4).h(24).rounded(2).bg(p.bar).when(!sel, (el) => el.opacity(0)))
          .child(div().w(240).flex_none().truncate().text_size(16).text_color(p.fg).child(pkg.prefix || "(root)"))
          .child(div().flex_1().min_w(0).truncate().text_size(14).text_color(p.muted)
            .child(`mods: ${pkg.mods.join(", ")}${pkg.layouts.length ? ` · layouts: ${pkg.layouts.length}` : ""}${pkg.recipe ? "" : " · no RECIPE.md"}`));
      })));
  }

  reviewView(p) {
    const { plan, pkg, source, fetched, record } = this.review;
    const line = (text, color, glyph) => h_flex().gap(10).items_start()
      .child(div().w(16).flex_none().text_size(15).font_semibold().text_color(color ?? p.muted).child(glyph ?? "·"))
      .child(div().flex_1().min_w(0).whitespace_normal().text_size(15).text_color(color === p.warn ? p.fg : (color ?? p.fg)).child(text));
    const section = (title, lines, accent) => v_flex().gap(10).p(18).rounded(12).bg(p.card).border_1().border_color(accent ?? p.border)
      .child(div().text_size(16).font_semibold().text_color(accent ? readable(accent, p.fg, [p.card]) : p.fg).child(title)).children(lines);
    const blocks = [
      section("What it adds", [
        line(`Mods: ${plan.mods.map((m) => `mods/${m}`).join(", ")}`),
        plan.layouts.length ? line(`Layouts: ${plan.layouts.join(", ")} (your layout is not switched)`) : null,
        line(`${pkg.files.length} file(s) · commit ${short(fetched.sha)}${record ? ` (installed: ${short(record.sha)})` : ""}${pkg.recipe ? "" : " · no RECIPE.md"}`),
      ].filter(Boolean)),
      section("What the code does", plan.risks.length
        ? plan.risks.map((r) => line(`${r.label}: ${r.paths.map((x) => x.split("/").slice(-2).join("/")).join(", ")}`, p.warn, "!"))
        : [line("Runs no programs, reaches no network, reads and writes no files.", p.ok, "✓")], plan.risks.length ? p.warn : null),
      section("Keys", [
        ...plan.keyAdds.map((k) => line(`${k.key} → ${k.action} (${k.section})`, p.ok, "+")),
        ...plan.keyConflicts.map((k) => line(`${k.key} stays ${k.current}; the mod wanted ${k.action}`, p.warn, "=")),
        ...(plan.keyAdds.length || plan.keyConflicts.length ? [] : [line("None.")]),
      ]),
    ];
    if (plan.clashes.length) blocks.unshift(section("Blocked", [line(`${plan.clashes.join(", ")} already exists and was not installed here. Nothing is overwritten.`, p.warn, "!")], p.warn));
    return v_flex().flex_1().min_h(0).gap(14)
      .child(h_flex().gap(14).items_center()
        .child(v_flex().flex_1().min_w(0).gap(4)
          .child(div().font_family("Geist").text_size(20).font_semibold().text_color(p.fg).child(`${record ? "Update" : "Install"} ${pkg.name}`))
          .child(div().text_size(14).text_color(p.muted).child(source)))
        .when(!plan.clashes.length, (el) => el.child(this.button(p, "rev-install", record ? "Update" : "Install", "y", (cx) => this.confirmInstall(cx), "primary")))
        .when(Boolean(repoPage(source)), (el) => el.child(this.button(p, "rev-open", "Open repo", "o", () => this.openUrl(repoPage(source)))))
        .child(this.button(p, "rev-cancel", "Cancel", "esc", () => this.cancelReview())))
      .child(div().text_size(14).text_color(p.muted).whitespace_normal()
        .child("Herdr does not review mods. Check the repository before installing one that runs programs or reaches the network."))
      .child(v_flex().flex_1().min_h(0).gap(12).overflow_y_scrollbar().children(blocks));
  }

  render(_cx) {
    const p = palette();
    return v_flex().id("root").role("dialog").accessibility_label("Mod Manager").track_focus(this.handle).size_full()
      .px(24).py(20).gap(16).bg(p.bg).text_size(15).text_color(p.fg)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(p))
      .child(this.banner(p) ?? div())
      .child(this[`${this.mode}View`](p))
      .child(this.footer(p));
  }
}
