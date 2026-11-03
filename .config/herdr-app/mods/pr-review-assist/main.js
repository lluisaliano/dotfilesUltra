import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { agents, spaces, panes, focused, layout, theme, exec, hc, run, shared, setShared, knownAgents, nextCommand, notify } from "herdr";
import { DEFAULT_TEMPLATE, SETTINGS_KEY, READ, FILTERS, SEARCH, FIELDS, templateError, reviewMessage, find, contextKey, location, availableAgents, ready, failure, checkSummary, prStatus, reviewStatus } from "./model.js";

export default class PrReviewAssist extends View {
  init(_props, cx) {
    this.prs = []; this.filter = "all"; this.limit = 20; this.generation = 0;
    this.handle = cx.focus_handle();
    this.template = shared(SETTINGS_KEY)?.template ?? DEFAULT_TEMPLATE;
    this.input = TextareaState.new({ value: this.template, rows: 3 });
    this.input.set_auto_grow(3, 6);
    this.input.on("change", (_e, cx) => { this.draft = this.input.value(); this.settingsSaved = false; cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.inputFocus = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocus = false; cx.notify(); });
    this.draft = this.template;
    cx.timer.every(60000, (cx) => { if (this.shown()) this.refresh(cx); });
    cx.spawn(async (cx) => { for (;;) {
      const command = String(await nextCommand()).replace(/^pr-review-assist[.:]/, "");
      if (command === "refresh") this.refresh(cx);
      const review = /^review-(\d+)$/.exec(command);
      if (review) { const pr = this.prs.find(p => p.number === Number(review[1])); if (pr) this.choose(pr, cx); }
      if (command === "settings") { this.settingsOpen = !this.settingsOpen; cx.notify(); }
    } });
  }

  shown() { return !find(layout(), "panel")?.hidden && find(layout(), "panel-body")?.active === "pr-review-assist"; }
  loc() { return location(spaces(), panes(), focused(), this.last); }
  sync(cx) {
    const loc = this.loc(), key = contextKey(loc);
    if (key === this.key) return;
    this.key = key; this.last = loc; this.generation++;
    this.prs = []; this.root = null; this.error = null; this.loading = false; this.more = false;
    this.selected = null; this.sendError = null; this.success = null; this.limit = 20;
    if (this.shown()) this.refresh(cx);
  }

  refresh(cx) {
    if (this.loading) return;
    const loc = this.loc(), key = contextKey(loc), filter = this.filter, limit = this.limit;
    if (!loc.cwd) { this.error = "Focus a terminal in a GitHub repository to see its pull requests."; return; }
    const generation = ++this.generation;
    const current = () => generation === this.generation && key === contextKey(this.loc());
    this.loading = true; this.error = null;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd: loc.cwd, on: loc.on });
        if (!current()) return;
        if (top.code !== 0) throw new Error("This folder is not a Git repository. Focus a terminal in the repository you want to review.");
        const root = top.stdout.trim();
        const result = await exec("gh", ["pr", "list", "--state", "open", "--limit", String(limit), "--search", SEARCH[filter], "--json", FIELDS], { cwd: root, on: loc.on });
        if (!current()) return;
        if (result.code !== 0) throw new Error(failure(result, "Could not load pull requests. Check gh auth status and the repository's GitHub remote."));
        const prs = JSON.parse(result.stdout);
        if (!Array.isArray(prs)) throw new Error("GitHub returned an invalid pull request list.");
        this.root = root; this.prs = prs; this.more = prs.length >= limit;
        this.loadedKey = key;
      } catch (error) {
        if (current()) this.error = String(error.message ?? error);
      } finally {
        if (generation === this.generation) { this.loading = false; cx.notify(); }
      }
    });
  }

  pick(filter, cx) {
    if (this.filter === filter) return;
    this.filter = filter; this.limit = 20; this.prs = []; this.more = false;
    this.selected = null; this.generation++; this.loading = false; this.refresh(cx);
  }

  choose(pr, cx) {
    if (this.sending) return;
    this.selected = this.selected?.number === pr.number ? null : pr;
    this.sendError = null; this.success = null; this.destination = null;
    this.choices = []; this.choicesError = null;
    const selection = this.selected, key = this.key;
    if (selection) {
      this.choicesLoading = true;
      cx.spawn(async (cx) => {
        try {
          const choices = await knownAgents({ on: this.last.on });
          if (this.selected === selection && this.key === key) this.choices = choices.filter(a => a.installed);
        } catch (e) { if (this.selected === selection && this.key === key) this.choicesError = String(e.message ?? e); }
        finally { if (this.selected === selection && this.key === key) { this.choicesLoading = false; cx.notify(); } }
      });
    }
    this.handle.focus(); cx.notify();
  }

  saveSettings(cx) {
    const error = templateError(this.draft);
    if (error) return;
    this.template = this.draft;
    setShared(SETTINGS_KEY, { template: this.template });
    this.settingsSaved = true; cx.notify();
  }

  send(cx) {
    if (this.sending || !this.selected || !this.destination) return;
    const pr = this.selected, loc = { ...this.last }, key = this.key, root = this.root;
    const destination = { ...this.destination };
    if (key !== contextKey(this.loc()) || this.loadedKey !== key || !root) return;
    let message;
    try { message = reviewMessage(shared(SETTINGS_KEY)?.template ?? DEFAULT_TEMPLATE, pr.number); }
    catch (e) { this.sendError = e.message; cx.notify(); return; }
    this.sendError = null;
    if (destination.kind === "new") {
      const program = this.choices.find(a => a.key === destination.key);
      if (!program) return;
      // The app owns agent startup/readiness and supplies the initial task.
      run("tab.new", { space: loc.space, folder: root, name: `Review PR #${pr.number}`, argv: program.run, task: message });
      this.selected = null; cx.notify(); return;
    }
    const agent = availableAgents(agents(), loc.space).find(a => a.address === destination.address);
    if (!ready(agent)) { this.sendError = "This agent is no longer ready. Choose an idle agent or start a new one."; cx.notify(); return; }
    this.sending = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        // The core rechecks status atomically. Never type into a working/blocked agent.
        const result = await hc(["send", agent.address, message, "--if", "idle", "--json"]);
        if (result.code !== 0) throw new Error(failure(result, "The review message could not be sent."));
        notify({ title: `Review PR #${pr.number} sent`, body: `${agent.program?.name ?? agent.app} · ${agent.tab_name}`, level: "info", timeout: 4 });
        if (this.key === key) { this.selected = null; this.success = `Sent review for #${pr.number} to ${agent.program?.name ?? agent.app}.`; }
      } catch (e) { if (this.key === key) this.sendError = String(e.message ?? e); }
      finally { this.sending = false; cx.notify(); }
    });
  }

  button(id, label, action, t, active = false, enabled = true) {
    return div().id(id).h(28).px(9).flex_none().flex().items_center().rounded(6).cursor_pointer()
      .text_size(12).border_1().border_color(active ? t.accent : t.border)
      .bg(active ? t.selected : t.background).text_color(enabled ? (active ? t.foreground : t.muted) : t.dim)
      .when(enabled, e => e.hover(s => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (enabled) action(cx); }).child(label);
  }

  settingsView(t) {
    const error = templateError(this.draft);
    return v_flex().flex_none().p(12).gap(8).border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Review message"))
      .child(div().text_size(12).text_color(t.muted).child("Use {pr_number} for the pull request number."))
      .child(Textarea.new(this.input).w_full().min_h(72).p(8).rounded(6).border_1().border_color(this.inputFocus ? t.accent : t.input).bg(t.chrome).text_size(12).text_color(t.foreground))
      .when(Boolean(error), e => e.child(div().text_size(12).text_color(t.ansi1).child(error)))
      .child(h_flex().gap(6).items_center()
        .child(this.button("save-template", "Save", cx => this.saveSettings(cx), t, true, !error))
        .child(this.button("reset-template", "Use default", cx => { this.draft = DEFAULT_TEMPLATE; this.input.set_value(this.draft); this.saveSettings(cx); }, t))
        .when(Boolean(this.settingsSaved), e => e.child(div().text_size(11).text_color(t.muted).child("Saved"))));
  }

  choice(id, title, detail, destination, enabled, t) {
    const active = JSON.stringify(this.destination) === JSON.stringify(destination);
    return h_flex().id(id).flex_none().min_h(42).px(8).py(6).gap(8).items_center().rounded(6).cursor_pointer()
      .bg(active ? t.selected : t.background).when(enabled, e => e.hover(s => s.bg(t.hover)))
      .on_click((_e, cx) => { cx.stop_propagation(); if (enabled && !this.sending) { this.destination = destination; this.sendError = null; cx.notify(); } })
      .child(div().text_color(active ? t.accent : t.dim).child(active ? "●" : "○"))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(12).text_color(enabled ? t.foreground : t.dim).child(title))
        .child(div().truncate().text_size(11).text_color(t.dim).child(detail)));
  }

  reviewView(t) {
    const pr = this.selected, list = availableAgents(agents(), this.last?.space);
    const template = shared(SETTINGS_KEY)?.template ?? DEFAULT_TEMPLATE;
    const message = templateError(template) ? "Save a valid message in Settings." : reviewMessage(template, pr.number);
    return v_flex().flex_none().mx(6).mb(8).p(10).gap(8).border_1().border_color(t.border).rounded(7)
      .child(h_flex().items_center().justify_between()
        .child(div().font_semibold().child(`Review PR #${pr.number}`))
        .child(this.button("review-cancel", "Cancel", cx => { if (!this.sending) { this.selected = null; cx.notify(); } }, t, false, !this.sending)))
      .child(div().text_size(11).text_color(t.dim).child("Message"))
      .child(div().p(8).rounded(5).bg(t.chrome).text_size(12).child(message))
      .child(div().text_size(11).text_color(t.dim).child("Existing agent in this space"))
      .children(list.map(a => this.choice(`agent-${a.address}`, `${a.program?.name ?? a.app} · ${a.tab_name}`, `${a.status} · ${a.address}${ready(a) ? "" : " · unavailable"}`, { kind: "existing", address: a.address }, ready(a), t)))
      .when(!list.length, e => e.child(div().text_size(12).text_color(t.muted).child("No agents in this space. Start one below.")))
      .child(div().pt(4).text_size(11).text_color(t.dim).child("Start a new agent"))
      .children(this.choices.map(a => this.choice(`new-${a.key}`, a.name, "New tab in this repository", { kind: "new", key: a.key }, true, t)))
      .when(this.choicesLoading, e => e.child(div().text_size(12).text_color(t.muted).child("Checking installed agents…")))
      .when(!this.choicesLoading && !this.choices.length, e => e.child(div().text_size(12).text_color(t.muted).child(this.choicesError || "No installed agents found. Check Herdr's agent configuration.")))
      .when(Boolean(this.sendError), e => e.child(div().text_size(12).text_color(t.ansi1).child(this.sendError)))
      .child(this.button("send-review", this.sending ? "Sending…" : this.destination?.kind === "new" ? "Start review" : "Send review", cx => this.send(cx), t, true, Boolean(this.destination) && !this.sending && !templateError(template)));
  }

  row(pr, t) {
    const expanded = this.selected?.number === pr.number;
    const state = prStatus(pr), review = reviewStatus(pr), checks = checkSummary(pr.statusCheckRollup);
    const checkColor = checks.kind === "fail" ? t.ansi1 : checks.kind === "pass" ? t.ansi2 : checks.kind === "pending" ? t.ansi3 : t.dim;
    const checkIcon = ["fail", "pass", "pending"].includes(checks.kind) ? checks.kind : "none";
    return v_flex().flex_none()
      .child(v_flex().id(`pr-${pr.number}`).flex_none().px(10).py(10).gap(6).rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(`${pr.headRefName} → ${pr.baseRefName} · Open on GitHub`)
        .on_click((_e, cx) => cx.open_url(pr.url))
        .child(h_flex().gap(8).items_start().min_w(0)
          .child(svg("mods/pr-review-assist/pr.svg").size(14).mt(2).flex_none().text_color(t[state.color]))
          .child(div().flex_1().min_w(0).text_color(t.foreground).child(pr.title)))
        .child(h_flex().pl(22).gap(6).items_center().min_w(0)
          .child(div().text_size(11).text_color(t.muted).child(`#${pr.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(pr.author?.login ?? ""))
          .child(this.button(`review-${pr.number}`, "Review", cx => this.choose(pr, cx), t, expanded, !this.sending)))
        .child(h_flex().pl(22).gap(6).items_center().min_w(0).text_size(11)
          .child(div().flex_none().text_color(t[state.color]).child(state.label))
          .when(Boolean(review), e => e.child(div().min_w(0).text_color(pr.reviewDecision === "CHANGES_REQUESTED" ? t.ansi1 : t.muted).child(`· ${review}`))))
        .child(h_flex().id(`pr-checks-${pr.number}`).pl(22).gap(6).items_start().min_w(0).text_size(11)
          .tooltip(checks.kind === "none" ? "GitHub reports no CI checks for this PR." : `CI: ${checks.label}`)
          .child(svg(`mods/pr-review-assist/check-${checkIcon}.svg`).size(13).mt(1).flex_none().text_color(checkColor))
          .child(div().flex_1().min_w(0).text_color(checkColor).child(checks.label))))
      .when(expanded, e => e.child(this.reviewView(t)));
  }

  render(cx) {
    this.sync(cx);
    if (this.shown() && this.loadedKey !== this.key && !this.loading && !this.error) this.refresh(cx);
    const t = theme();
    return v_flex().id("pr-review-assist").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape" && !this.sending) { this.selected = null; cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().child("PR Review Assist"))
        .child(this.button("prs-settings", "Settings", cx => { this.settingsOpen = !this.settingsOpen; cx.notify(); }, t, this.settingsOpen))
        .child(this.button("prs-refresh", "↻", cx => this.refresh(cx), t, false, !this.loading)))
      .child(div().flex_none().px(12).py(8).text_size(11).text_color(t.dim).truncate().tooltip(this.root ?? this.last?.cwd ?? "")
        .child(this.root?.split(/[\\/]/).filter(Boolean).pop() ?? "Focused repository"))
      .child(h_flex().flex_none().px(10).pb(8).gap(4).children(FILTERS.map(([id, label]) => this.button(`filter-${id}`, label, cx => this.pick(id, cx), t, this.filter === id))))
      .child(v_flex().id("pr-content").flex_1().min_h(0).overflow_y_scrollbar()
        .when(this.settingsOpen, e => e.child(this.settingsView(t)))
        .when(Boolean(this.success), e => e.child(div().p(12).text_size(12).text_color(t.muted).child(this.success)))
        .when(Boolean(this.error), e => e.child(v_flex().p(12).gap(6)
          .child(div().font_semibold().child("Couldn't load pull requests"))
          .child(div().text_size(12).text_color(t.muted).child(this.error))))
        .children(this.prs.map(pr => this.row(pr, t)))
        .when(!this.error && !this.prs.length, e => e.child(v_flex().p(14).gap(6)
          .child(div().text_color(t.muted).child(this.loading ? "Loading pull requests…" : this.filter === "all" ? "No open pull requests" : this.filter === "mine" ? "No open pull requests of yours" : "No reviews requested"))
          .when(!this.loading, el => el.child(div().text_size(12).text_color(t.dim).child("Refresh to check GitHub again.")))))
        .when(this.more && this.prs.length > 0, e => e.child(div().p(10).child(this.button("prs-more", "Load more", cx => { this.limit += 20; this.refresh(cx); }, t, false, !this.loading)))))
      .child(div().flex_none().px(12).py(7).border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(this.loading ? "Refreshing…" : `${this.prs.length} open${this.more ? "+" : ""} · Row opens GitHub`));
  }
}
