// Linear issues, through the `linear` CLI's GraphQL passthrough (`linear api`): it keeps
// its own login, so no API key lives here. Lives in the right panel's stack in
// layouts/my-main.json; the Linear button in my-tabs toggles it. The list nests
// sub-issues under their parent; tapping an issue pushes its details, where status,
// priority and assignee (a person, an agent as Linear's delegate, or both) can be changed,
// and ▶ runs a play action from settings (a named agent + prompt) on the issue. Changing needs the CLI's key to
// have write access; the panel checks that up front and offers the fix. Preferences live in
// shared state (`linear.prefs`): per-copy localStorage starts over when the layout rebuilds.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, run, theme as herdrTheme, layout, notify, shared, setShared, knownAgents, props, openOverlay, closeOverlay } from "herdr";

// The theme's "raised" gray read too bright on a black background (bands, search, switch):
// the panel uses it at 40% so text on it keeps its contrast. Same look in light themes.
const theme = () => {
  const t = herdrTheme();
  // 40% of "raised" over the background, as a solid #rrggbb: mods add their own alpha to it.
  const mix = (a, b, k) => {
    if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
    const c = (h, i) => parseInt(h.slice(i, i + 2), 16);
    return "#" + [1, 3, 5].map((i) => Math.round(c(a, i) * k + c(b, i) * (1 - k)).toString(16).padStart(2, "0")).join("");
  };
  const soft = mix(t.raised, t.background, 0.4);
  return { ...t, raised: soft };
};

const EVERY = 60000;
const PAGE = 250;
const ICON = "mods/workspace-chrome", OWN = "mods/linear";
const TYPE_ORDER = { triage: 0, started: 1, unstarted: 2, backlog: 3, completed: 4, canceled: 5 };
const TYPES = [["backlog", "Backlog"], ["unstarted", "Todo"], ["started", "In progress"], ["completed", "Done"], ["canceled", "Canceled"]];
const SCOPES = [["anyone", "Anyone"], ["me", "Me"], ["unassigned", "Unassigned"]];
const PRIORITIES = [[1, "Urgent"], [2, "High"], [3, "Medium"], [4, "Low"], [0, "No priority"]];
// `projects`: ids (and "none" for issues without one); empty means every project.
const DEFAULT_FILTER = { scope: "anyone", types: ["backlog", "unstarted", "started"], projects: [] };
const NO_PROJECT = "No project";
const PREFS = "linear.prefs";
const DEFAULT_PROMPT = "Start working on Linear issue $issueId: $title\n$url\n\nRead it first with `linear issue view $issueId`.";
const VARIABLES = ["$issueId", "$title", "$url", "$branch", "$description"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The filter dropdowns open under the header (42) and the filter bar (116).
const FILTER_BAR = 116, MENU_TOP = 42 + FILTER_BAR + 4;

const LIST = `query($filter: IssueFilter, $first: Int) {
  issues(first: $first, filter: $filter) {
    pageInfo { hasNextPage }
    nodes {
      id identifier title url branchName priority sortOrder
      state { id name color type position }
      project { id name }
      assignee { name initials }
      delegate { name initials }
      parent { id identifier }
      children { nodes { state { type } } }
    }
  }
}`;

const DETAIL = `query($id: String!) {
  issue(id: $id) {
    id identifier title url branchName description priority
    state { id name color type }
    assignee { id name initials }
    delegate { id name initials }
    cycle { number name isActive startsAt endsAt }
    project { name }
    projectMilestone { name }
    team {
      states { nodes { id name color type position } }
      members { nodes { id name initials active app isMe } }
    }
    parent { identifier title state { name color type } }
    children { nodes { id identifier title priority state { name color type } assignee { name initials } delegate { name initials } } }
  }
  users(first: 100) { nodes { id name initials active app } }
}`;

const UPDATE = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
const PROJECTS = `{ projects(first: 250) { nodes { id name } } }`;
const VIEWER = `{ viewer { name } organization { name urlKey } }`;
const INSTALL = ["paru", "-S", "linear-cli-schpet-bin"];
const KEYS_URL = (org) => `https://linear.app/${org ? `${org}/` : ""}settings/account/security`;
// Linear checks the key's scope before looking the issue up, so updating an issue that
// can't exist tells whether the key may write, without changing anything.
const NO_ISSUE = "00000000-0000-0000-0000-000000000000";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

class ReadOnlyKey extends Error {}

function explain(message) {
  return /Invalid scope/i.test(message) ? new ReadOnlyKey("Your Linear key can only read, so this change wasn't saved.") : new Error(message);
}

async function api(query, variables) {
  const r = await exec("linear", ["api", "--no-input", "--variables-json", JSON.stringify(variables), query]);
  // On failure `linear api` prints the GraphQL error body to stderr, not stdout.
  let body;
  try { body = JSON.parse(r.code === 0 ? r.stdout : r.stderr || r.stdout); }
  catch { throw new Error((r.stderr || r.stdout).trim() || `linear exited with ${r.code}`); }
  if (body.errors?.length) throw explain(body.errors[0].message);
  if (r.code !== 0) throw new Error((r.stderr || `linear exited with ${r.code}`).trim());
  return body.data;
}

function listFilter({ scope, types, projects }) {
  const filter = { state: { type: { in: types } } };
  if (scope === "me") filter.assignee = { isMe: { eq: true } };
  if (scope === "unassigned") filter.assignee = { null: true };
  const ids = projects.filter((p) => p !== "none");
  const parts = [...(ids.length ? [{ project: { id: { in: ids } } }] : []), ...(projects.includes("none") ? [{ project: { null: true } }] : [])];
  if (parts.length === 1) Object.assign(filter, parts[0]);
  if (parts.length === 2) filter.or = parts;
  return filter;
}

// Urgent first, no priority last, then Linear's manual order.
const rank = (p) => (p === 0 ? 5 : p);
const byPriority = (a, b) => rank(a.priority) - rank(b.priority) || a.sortOrder - b.sortOrder;
const byType = (a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.position - b.position;
const date = (s) => { const d = new Date(s); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
const errorText = (e) => String(e?.message ?? e);

// Root issues in status sections (workflow order), each split by project (alphabetical, none last).
function groups(nodes) {
  const states = new Map();
  for (const node of nodes) {
    const { state } = node.issue, name = node.issue.project?.name ?? NO_PROJECT;
    const s = states.get(state.id) ?? { state, projects: new Map() };
    s.projects.set(name, [...(s.projects.get(name) ?? []), node]);
    states.set(state.id, s);
  }
  return [...states.values()]
    .sort((a, b) => byType(a.state, b.state))
    .map((s) => ({ ...s, projects: [...s.projects].sort(([a], [b]) => (a === NO_PROJECT) - (b === NO_PROJECT) || a.localeCompare(b)) }));
}

const countRows = (nodes) => nodes.reduce((n, node) => n + 1 + countRows(node.children), 0);

// Sub-issues counted per status, in workflow order.
function tally(issues) {
  const counts = new Map();
  for (const { state } of issues) counts.set(state.name, { state, count: (counts.get(state.name)?.count ?? 0) + 1 });
  return [...counts.values()].sort((a, b) => (TYPE_ORDER[a.state.type] ?? 9) - (TYPE_ORDER[b.state.type] ?? 9));
}

function statusIcon(state, t, size = 14) {
  const file = TYPE_ORDER[state?.type] === undefined || state.type === "triage" ? "unstarted" : state.type;
  return svg(`${OWN}/status-${file}.svg`).size(size).flex_none().text_color(state?.color ?? t.dim);
}

// For filter rows, which name a status type rather than one team's state.
function typeColor(type, t) {
  return { started: t.ansi3, completed: t.ansi4, unstarted: t.muted }[type] ?? t.dim;
}

function priorityIcon(priority, t) {
  if (priority === 1)
    return div().size(14).flex_none().rounded(3).bg(t.blocked).text_color(t.background).text_size(10).font_bold()
      .flex().items_center().justify_center().child("!");
  if (!priority)
    return h_flex().size(14).flex_none().items_center().justify_center().gap(2)
      .children([0, 1, 2].map(() => div().size(2).rounded(1).bg(t.dim)));
  const lit = { 2: 3, 3: 2, 4: 1 }[priority];
  return h_flex().size(14).flex_none().items_end().justify_center().gap(1).pb(2).children(
    [1, 2, 3].map((k) => div().w(3).h(2 + k * 3).rounded(1).bg(k <= lit ? t.foreground : t.border)));
}

// People are circles, agents rounded squares; the tint comes from the name.
function avatar(person, t, agent = false) {
  const tints = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6];
  let h = 0;
  for (const ch of person.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const c = tints[h % tints.length];
  return div().size(18).flex_none().rounded(agent ? 5 : 9).bg(c + "30").text_color(c).text_size(8.5).font_semibold()
    .flex().items_center().justify_center().child(person.initials || person.name.slice(0, 2));
}

const nobody = (t) => div().size(18).flex_none().rounded(9).border_1().border_color(t.border);

const prefs = () => shared(PREFS) ?? {};
const savePrefs = (change) => setShared(PREFS, { ...prefs(), ...change });

// Play actions: { id, name, agent (a knownAgents key; null: the first installed), prompt }.
// Before there were several, the one agent and prompt sat at the top of the prefs.
function actions() {
  const p = prefs();
  return p.actions ?? [{ id: "start", name: "Start working", agent: p.agent ?? null, prompt: p.prompt ?? DEFAULT_PROMPT }];
}
const saveActions = (list) => savePrefs({ actions: list });

function agentIcon(a, t, size = 16) {
  if (!a?.icon) return div().size(size).flex_none();
  return (a.tint ? svg(a.icon).text_color(t.foreground) : image(a.icon)).size(size).flex_none();
}

// What earlier versions kept in this copy's localStorage, so moving to shared state loses nothing.
function legacy(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
  catch { return fallback; }
}

// A prompt as text plus a token for each variable, so the prompt box draws them as chips.
function tokenized(text) {
  const tokens = [...text.matchAll(/\$(issueId|title|url|branch|description)\b/g)].map((m) => ({
    range: { start: m.index, end: m.index + m[0].length }, token: { id: m[1], text: m[0] } }));
  return { text, tokens };
}

function fillPrompt(template, issue) {
  const values = { issueId: issue.identifier, title: issue.title, url: issue.url, branch: issue.branchName ?? "", description: issue.description ?? "" };
  return template.replace(/\$(issueId|title|url|branch|description)\b/g, (_m, key) => values[key]);
}

function copyId(id) {
  exec("sh", ["-c", 'printf %s "$1" | wl-copy', "sh", id])
    .then(() => notify({ title: `Copied ${id}`, level: "success", timeout: 1500 }))
    .catch((e) => notify({ title: `Couldn't copy ${id}`, body: errorText(e), level: "error" }));
}

export default class Linear extends View {
  init(_props, cx) {
    if (props()?.pickAgent) return this.initAgentPicker(cx);
    this.issues = null; this.more = false; this.error = null; this.loadedAt = 0; this.token = 0;
    this.stack = []; this.details = {}; this.detailErrors = {}; this.updateErrors = {};
    this.expanded = new Set(); this.picking = null; this.saving = null; this.hover = null;
    this.search = ""; this.menu = null; this.projects = []; this.canWrite = null;
    // Setup checks for the welcome screen: cli and viewer are null while unknown.
    this.setup = { cli: null, viewer: null, viewerError: null };
    const saved = prefs();
    this.welcome = !(saved.welcomed || legacy("welcomed", 0) === 1);
    // Copy the old per-copy flag into shared state, so a rebuilt copy doesn't welcome again.
    if (!this.welcome && !saved.welcomed) savePrefs({ welcomed: true });
    this.filter = { ...DEFAULT_FILTER, ...(saved.filter ?? legacy("filter", {})) };
    this.collapsed = new Set(saved.collapsed ?? legacy("collapsed", []));
    this.settingsOpen = false; this.agents = null; this.focusedPrompt = null;
    // Each action's name and prompt editors, kept by action id (text states live on the view).
    this.editors = {};
    for (const a of actions()) this.editorsFor(a);
    this.loadAgents(cx);
    this.input = InputState.new({ placeholder: "Search issues" });
    this.input.on("change", (_e, cx) => { this.search = this.input.value(); cx.notify(); });
    this.refresh(cx); this.loadProjects(cx); this.checkSetup(cx);
    // Timers run while the panel is hidden too; only fetch while it shows.
    cx.timer.every(EVERY, (cx) => { if (this.shown()) this.refresh(cx); });
    // While the welcome waits on a step (say, a login in a terminal), it ticks by itself.
    cx.timer.every(5000, (cx) => { if (this.welcome && !this.setupDone() && this.shown()) this.checkSetup(cx); });
  }

  // Fetching pauses only while this sits, unselected or folded away, in the right panel's
  // stack; placed anywhere else (an overlay, another block), it counts as shown.
  shown() {
    const root = layout(), body = find(root, "panel-body");
    const own = body?.children?.find((c) => c.content?.mod === "linear");
    if (props()?.overlay || !own) return true;
    return !find(root, "panel")?.hidden && body.active === own.id;
  }

  // A newer refresh (say, a filter change) wins over one still running.
  refresh(cx) {
    const token = ++this.token, filter = this.filter;
    this.loading = true;
    cx.spawn(async (cx) => {
      let issues = [], more = false, error = null;
      try {
        if (filter.types.length) {
          const { issues: page } = await api(LIST, { filter: listFilter(filter), first: PAGE });
          issues = page.nodes; more = page.pageInfo.hasNextPage;
        }
      } catch (e) { error = errorText(e); }
      if (token !== this.token) return;
      Object.assign(this, { issues, more, error, loading: false, loadedAt: Date.now() });
      cx.notify();
    });
  }

  loadProjects(cx) {
    cx.spawn(async (cx) => {
      try { this.projects = (await api(PROJECTS, {})).projects.nodes.sort((a, b) => a.name.localeCompare(b.name)); cx.notify(); }
      catch { /* the list shows its own error */ }
    });
  }

  setupDone() {
    return Boolean(this.setup.cli && this.setup.viewer && this.canWrite);
  }

  checkSetup(cx) {
    if (this.checking) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      try {
        const v = await exec("linear", ["--version"]).catch(() => null);
        this.setup.cli = v?.code === 0 ? v.stdout.trim() : false;
        if (this.setup.cli) {
          try { this.setup.viewer = await api(VIEWER, {}); this.setup.viewerError = null; }
          catch (e) { this.setup.viewer = false; this.setup.viewerError = errorText(e); }
        }
        if (this.setup.viewer) {
          const before = this.issues;
          this.checkWrite(cx);
          // Logging in from the welcome makes the list readable; fetch it again.
          if (before === null || this.error) { this.refresh(cx); this.loadProjects(cx); }
        }
      } finally { this.checking = false; cx.notify(); }
    });
  }

  finishWelcome(cx) {
    this.welcome = false;
    savePrefs({ welcomed: true });
    cx.notify();
  }

  openSettings(cx) {
    this.settingsOpen = true; this.menu = null;
    for (const a of actions()) this.editorsFor(a);
    this.loadAgents(cx);
    cx.notify();
  }

  loadAgents(cx) {
    cx.spawn(async (cx) => { this.agents = (await knownAgents().catch(() => [])).filter((a) => a.installed); cx.notify(); });
  }

  initAgentPicker(cx) {
    this.agents = null; this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      this.agents = (await knownAgents().catch(() => [])).filter((a) => a.installed);
      this.at = Math.max(0, this.agents.indexOf(this.agentFor(actions().find((a) => a.id === props().pickAgent) ?? {})));
      cx.notify();
    });
  }

  pickAgent(agent) {
    this.updateAction(props().pickAgent, { agent: agent.key });
    closeOverlay(props().overlay);
  }

  renderAgentPicker(t) {
    const action = actions().find((a) => a.id === props().pickAgent), agents = this.agents ?? [];
    const current = action && this.agentFor(action);
    return v_flex().id("linear-agent-picker").track_focus(this.handle).w_full().p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "down" && agents.length) this.at = (this.at + 1) % agents.length;
        else if (e.key === "up" && agents.length) this.at = (this.at + agents.length - 1) % agents.length;
        else if (e.key === "enter" && agents[this.at]) this.pickAgent(agents[this.at]);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).truncate().child(`Agent for ${action?.name || "this action"}`))
      .when(this.agents === null, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("Looking for agents…")))
      .when(this.agents?.length === 0, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("No agents installed. Install one such as Claude Code or Codex.")))
      .children(agents.map((a, i) => h_flex().id(`pick-${a.key}`).h(38).flex_none().px(8).gap(10).items_center().rounded(7).cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click(() => this.pickAgent(a))
        .child(agentIcon(a, t, 18))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().child(a.name))
          .child(div().text_size(11).text_color(t.dim).truncate().font_family("JetBrains Mono").child(a.run.join(" "))))
        .when(a === current, (el) => el.child(svg(`${ICON}/check.svg`).size(12).flex_none().text_color(t.accent)))));
  }

  agentFor(action) {
    return this.agents?.find((a) => a.key === action.agent) ?? this.agents?.[0] ?? null;
  }

  // Only from init or an event handler: text states need a live host call.
  editorsFor(action) {
    if (this.editors[action.id]) return this.editors[action.id];
    const name = InputState.new({ placeholder: "Action name", value: action.name });
    const prompt = TextareaState.new({ rows: 3 });
    prompt.set_value(tokenized(action.prompt));
    prompt.set_auto_grow(3, 10);
    name.on("change", (_e, cx) => { this.updateAction(action.id, { name: name.value() }); cx.notify(); });
    prompt.on("change", (_e, cx) => { this.updateAction(action.id, { prompt: prompt.value() }); cx.notify(); });
    prompt.on("focus", (_e, cx) => { this.focusedPrompt = action.id; cx.notify(); });
    // Variables typed by hand become chips once the box loses focus; doing it while typing
    // would move the cursor.
    prompt.on("blur", (_e, cx) => {
      if (this.focusedPrompt === action.id) this.focusedPrompt = null;
      const text = prompt.value(), next = tokenized(text);
      if (next.tokens.length !== prompt.tokens().length) prompt.set_value(next);
      cx.notify();
    });
    return (this.editors[action.id] = { name, prompt });
  }

  updateAction(id, change) {
    saveActions(actions().map((a) => (a.id === id ? { ...a, ...change } : a)));
  }

  addAction(cx) {
    const action = { id: `a${Date.now().toString(36)}`, name: "New action", agent: actions()[0]?.agent ?? null, prompt: DEFAULT_PROMPT };
    saveActions([...actions(), action]);
    this.editorsFor(action);
    cx.notify();
  }

  removeAction(id, cx) {
    saveActions(actions().filter((a) => a.id !== id));
    const ed = this.editors[id];
    ed?.name.release?.(); ed?.prompt.release();
    delete this.editors[id];
    cx.notify();
  }

  // A play action: a new tab in this space running its agent, with the prompt as the first message.
  startAgent(issue, action, cx) {
    cx.spawn(async (cx) => {
      const agents = (await knownAgents().catch(() => [])).filter((a) => a.installed);
      const agent = agents.find((a) => a.key === action.agent) ?? agents[0];
      if (!agent) {
        notify({ title: "No agent to start", body: "Install an agent such as Claude Code or Codex, then pick it in Linear settings.", level: "error" });
        return;
      }
      run("tab.new", { name: issue.identifier, argv: agent.run, task: fillPrompt(action.prompt, issue) });
      notify({ title: `${action.name || "Action"}: started ${agent.name} on ${issue.identifier}`, level: "success", timeout: 2000 });
    });
  }

  checkWrite(cx) {
    if (this.canWrite === false) this.canWrite = null;
    cx.spawn(async (cx) => {
      try { await api(UPDATE, { id: NO_ISSUE, input: {} }); this.canWrite = true; }
      catch (e) { this.canWrite = e instanceof ReadOnlyKey ? false : /not found/i.test(errorText(e)) ? true : null; }
      cx.notify();
    });
  }

  toggleFold(key, cx) {
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    savePrefs({ collapsed: [...this.collapsed] });
    cx.notify();
  }

  setFilter(change, cx) {
    this.filter = { ...this.filter, ...change };
    savePrefs({ filter: this.filter });
    this.refresh(cx);
    cx.notify();
  }

  load(id, cx) {
    cx.spawn(async (cx) => {
      try { this.details[id] = await api(DETAIL, { id }); delete this.detailErrors[id]; }
      catch (e) { this.detailErrors[id] = errorText(e); }
      cx.notify();
    });
  }

  open(id, cx) {
    this.stack.push(id); this.picking = null; this.menu = null;
    this.load(id, cx);
    cx.notify();
  }

  update(issue, field, input, cx) {
    this.saving = field; this.picking = null; delete this.updateErrors[issue.identifier];
    cx.notify();
    cx.spawn(async (cx) => {
      try { await api(UPDATE, { id: issue.id, input }); }
      catch (e) {
        this.updateErrors[issue.identifier] = errorText(e);
        if (e instanceof ReadOnlyKey) this.canWrite = false;
      }
      this.saving = null;
      this.load(issue.identifier, cx); this.refresh(cx);
      cx.notify();
    });
  }

  iconButton(id, content, t, onClick) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(content);
  }

  header(t, title, extra = [], back = this.stack.length ? (_e, cx) => { this.stack.pop(); this.picking = null; this.menu = null; cx.notify(); } : null) {
    return h_flex().h(42).flex_none().px(back ? 8 : 14).gap(4).items_center().border_b(1).border_color(t.border)
      .when(Boolean(back), (el) => el.child(this.iconButton("linear-back", svg(`${ICON}/chevron-left.svg`).size(15), t, back)))
      .child(title)
      .child(div().flex_1())
      .children(extra)
      .child(this.iconButton("linear-refresh", this.loading ? svg(`${ICON}/spinner.svg`).size(13).spin(900) : svg(`${OWN}/refresh.svg`).size(13), t,
        (_e, cx) => { this.refresh(cx); this.loadProjects(cx); const open = this.stack.at(-1); if (open) this.load(open, cx); cx.notify(); }));
  }


  filterBar(t) {
    const { scope, types, projects } = this.filter;
    const segment = ([value, label]) => div().id(`scope-${value}`).flex_1().h_full().flex().items_center().justify_center().rounded(5).cursor_pointer().text_size(11.5)
      .when(scope === value, (el) => el.bg(t.background).text_color(t.foreground))
      .when(scope !== value, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => this.setFilter({ scope: value }, cx)).child(label);
    const dropdown = (menu, content) => h_flex().id(`linear-${menu}-filter`).flex_1().min_w(0).h_full().px(8).gap(6).items_center().rounded(7)
      .cursor_pointer().text_size(11.5).border_1().border_color(this.menu === menu ? t.accent : t.border).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { this.menu = this.menu === menu ? null : menu; this.hover = null; cx.notify(); })
      .children(content).child(div().flex_1()).child(svg(`${ICON}/chevron-down.svg`).size(11).flex_none());
    const selected = TYPES.filter(([value]) => types.includes(value));
    const projectLabel = !projects.length ? "All projects" : projects.length > 1 ? `${projects.length} projects`
      : projects[0] === "none" ? NO_PROJECT : this.projects.find((p) => p.id === projects[0])?.name ?? "1 project";
    return v_flex().h(FILTER_BAR).flex_none().px(10).pt(10).pb(8).gap(8).border_b(1).border_color(t.border)
      .child(h_flex().id("linear-search").h(30).flex_none().px(9).gap(7).items_center().rounded(8).bg(t.raised).cursor_text()
        .child(svg(`${ICON}/search.svg`).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))
        .when(Boolean(this.search), (el) => el.child(this.iconButton("linear-clear", svg(`${ICON}/x.svg`).size(11), t,
          (_e, cx) => { this.input.set_value(""); this.search = ""; cx.notify(); }).size(20))))
      .child(h_flex().h(26).flex_none().p(2).rounded(7).bg(t.raised).children(SCOPES.map(segment)))
      .child(h_flex().h(26).flex_none().gap(6)
        .child(dropdown("status", [
          h_flex().flex_none().gap(2).children(selected.map(([type]) => statusIcon({ type, color: typeColor(type, t) }, t, 12))),
          div().truncate().child(selected.length ? "Status" : "No status")]))
        .child(dropdown("project", [div().min_w(0).truncate().child(projectLabel)])));
  }

  menuRow(key, icon, label, on, t, onClick) {
    return h_flex().id(key).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12.5)
      .hover((s) => s.bg(t.hover)).on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); })
      .when(Boolean(icon), (el) => el.child(icon))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(on, (el) => el.child(svg(`${ICON}/check.svg`).size(12).flex_none().text_color(t.accent)));
  }

  filterMenu(t) {
    const { types, projects } = this.filter;
    // GPUI hands a click to everything under the pointer, top first: stopping it here keeps
    // the issue row beneath the dropdown from opening too.
    const stop = (_e, cx) => cx.stop_propagation();
    const box = v_flex().id(`linear-${this.menu}-menu`).absolute().top(MENU_TOP).w(200).p(4).rounded(9).bg(t.popover).border_1().border_color(t.border)
      .on_mouse_down("left", stop).on_click(stop);
    if (this.menu === "status")
      return box.left(10).children(TYPES.map(([type, label]) => {
        const on = types.includes(type);
        return this.menuRow(`type-${type}`, statusIcon({ type, color: typeColor(type, t) }, t), label, on, t,
          (_e, cx) => this.setFilter({ types: on ? types.filter((x) => x !== type) : [...types, type] }, cx));
      }));
    const toggle = (id) => (_e, cx) => this.setFilter({ projects: projects.includes(id) ? projects.filter((x) => x !== id) : [...projects, id] }, cx);
    // The scroll lives inside the positioned box: a scrolling element loses its absolute placement.
    return box.right(10).child(v_flex().id("linear-project-scroll").max_h(292).overflow_y_scrollbar()
      .child(this.menuRow("project-all", null, "All projects", !projects.length, t, (_e, cx) => this.setFilter({ projects: [] }, cx)))
      .child(div().mx(6).my(4).h(1).flex_none().bg(t.border))
      .children(this.projects.map((p) => this.menuRow(`project-${p.id}`, null, p.name, projects.includes(p.id), t, toggle(p.id))))
      .child(this.menuRow("project-none", null, NO_PROJECT, projects.includes("none"), t, toggle("none"))));
  }

  // Rows skip hover styling while a filter dropdown is open: GPUI hovers everything under
  // the pointer and a mod can't make the dropdown occlude, so the list would light up behind it.
  issueRows(node, depth, t, searching, parents) {
    const i = node.issue, kids = node.children, hovered = this.hover === i.id;
    const open = kids.length > 0 && (searching || this.expanded.has(i.id));
    const total = i.children.nodes.length, done = i.children.nodes.filter((c) => c.state.type === "completed").length;
    const row = h_flex().id(`issue-${i.id}`).h(32).flex_none().pl(4 + depth * 20).pr(6).gap(7).items_center().rounded(7).cursor_pointer()
      .when(!this.menu, (el) => el.hover((s) => s.bg(t.hover)))
      .on_hover((on, cx) => { if (on && !this.menu) this.hover = i.id; else if (this.hover === i.id) this.hover = null; cx.notify(); })
      .on_click((_e, cx) => this.open(i.identifier, cx))
      .child(div().id(`fold-${i.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
        .when(kids.length > 0, (el) => el.when(!this.menu, (el) => el.hover((s) => s.bg(t.raised).text_color(t.foreground)))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (this.expanded.has(i.id)) this.expanded.delete(i.id); else this.expanded.add(i.id);
            cx.notify();
          })
          .child(svg(`${ICON}/${open ? "chevron-down" : "chevron-right"}.svg`).size(11))))
      .child(priorityIcon(i.priority, t))
      .child(div().w(this.idWidth).flex_none().text_size(11.5).text_color(t.dim).child(i.identifier))
      .child(statusIcon(i.state, t))
      .child(div().flex_1().min_w(0).truncate().child(i.title))
      // A sub-issue whose parent the filter hides says where it belongs.
      .when(Boolean(i.parent) && !parents.has(i.parent.id), (el) => el.child(
        div().flex_none().text_size(11).text_color(t.dim).child(`in ${i.parent.identifier}`)))
      .when(total > 0, (el) => el.child(h_flex().flex_none().gap(3).items_center().text_size(11).text_color(t.dim)
        .child(svg(`${OWN}/sub-issues.svg`).size(12)).child(`${done}/${total}`)))
      .when(hovered, (el) => el.child(this.iconButton(`copy-${i.id}`, svg(`${OWN}/copy.svg`).size(12), t,
        (_e, cx) => { cx.stop_propagation(); copyId(i.identifier); }).size(20)))
      .when(!hovered && Boolean(i.delegate), (el) => el.child(avatar(i.delegate, t, true)))
      .when(!hovered && Boolean(i.assignee), (el) => el.child(avatar(i.assignee, t)));
    return [row, ...(open ? kids.flatMap((k) => this.issueRows(k, depth + 1, t, searching, parents)) : [])];
  }

  renderList(t) {
    const all = this.issues ?? [];
    const q = this.search.trim().toLowerCase();
    const byId = new Map(all.map((i) => [i.id, i])), kids = new Map();
    for (const i of all) if (i.parent && byId.has(i.parent.id)) kids.set(i.parent.id, [...(kids.get(i.parent.id) ?? []), i]);
    const matches = (i) => !q || i.identifier.toLowerCase().includes(q) || i.title.toLowerCase().includes(q);
    // While searching, a match keeps its ancestors so it shows in place.
    const visible = (i) => {
      const children = (kids.get(i.id) ?? []).sort(byPriority).map(visible).filter(Boolean);
      return matches(i) || children.length ? { issue: i, children } : null;
    };
    // Issue numbers share one column width so the status icons line up.
    this.idWidth = Math.max(0, ...all.map((i) => i.identifier.length)) * 7 + 2;
    const roots = all.filter((i) => !(i.parent && byId.has(i.parent.id))).sort(byPriority).map(visible).filter(Boolean);
    const shownCount = countRows(roots);
    const empty = this.error ? this.error
      : this.issues === null ? "Loading issues…"
      : !this.filter.types.length ? "Choose a status to see issues."
      : q ? `No issues match “${this.search.trim()}”.` : "No issues match these filters.";

    return [
      this.header(t, h_flex().gap(8).items_center()
        .child(div().font_semibold().child("Linear"))
        .when(this.issues !== null, (el) => el.child(div().text_size(11.5).text_color(t.dim).child(String(shownCount)))),
        [this.iconButton("linear-help", svg(`${OWN}/help.svg`).size(14), t, (_e, cx) => { this.welcome = true; this.menu = null; this.checkSetup(cx); cx.notify(); }),
         this.iconButton("linear-settings", svg(`${ICON}/settings.svg`).size(14), t, (_e, cx) => this.openSettings(cx))]),
      this.filterBar(t),
      v_flex().id("linear-list").flex_1().min_h(0).overflow_y_scrollbar().px(6).py(6)
        .when(!roots.length, (el) => el.child(div().p(10).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
        .children(groups(roots).map((g) => {
          // Folded sections stay folded across filters and restarts; a search opens them.
          const stateKey = `state:${g.state.id}`, stateOpen = Boolean(q) || !this.collapsed.has(stateKey);
          const fold = (open) => svg(`${ICON}/${open ? "chevron-down" : "chevron-right"}.svg`).size(11).flex_none().text_color(t.dim);
          return v_flex().pb(stateOpen ? 10 : 4)
            .child(h_flex().id(`group-${g.state.id}`).h(30).flex_none().px(8).gap(8).items_center().rounded(7).bg(t.raised).cursor_pointer()
              .when(!this.menu, (el) => el.hover((s) => s.bg(t.hover))).on_click((_e, cx) => this.toggleFold(stateKey, cx))
              .child(fold(stateOpen))
              .child(statusIcon(g.state, t))
              .child(div().text_size(12.5).font_medium().child(g.state.name))
              .child(div().text_size(11.5).text_color(t.dim).child(String(countRows(g.projects.flatMap(([, n]) => n))))))
            .when(stateOpen, (el) => el.children(g.projects.flatMap(([project, nodes]) => {
              const key = `project:${g.state.id}:${project}`, open = Boolean(q) || !this.collapsed.has(key);
              return [
                ...(g.projects.length === 1 && project === NO_PROJECT ? [] : [
                  h_flex().id(`group-${key}`).h(28).flex_none().pl(8).pr(8).gap(6).items_end().pb(5).rounded(6).cursor_pointer()
                    .text_size(11).text_color(t.dim).when(!this.menu, (el) => el.hover((s) => s.text_color(t.foreground)))
                    .on_click((_e, cx) => this.toggleFold(key, cx))
                    .child(fold(open))
                    .child(div().min_w(0).truncate().child(project))
                    .child(div().flex_none().child(String(countRows(nodes)))),
                ]),
                ...(open ? nodes.flatMap((n) => this.issueRows(n, 0, t, Boolean(q), byId)) : []),
              ];
            })));
        }))
        .when(this.more, (el) => el.child(div().px(10).py(6).text_size(11).text_color(t.dim)
          .child(`Showing the first ${PAGE} issues. Narrow the filters to see the rest.`))),
    ];
  }


  // A property row; with `pick`, tapping it opens that picker below.
  prop(label, value, t, pick) {
    const row = h_flex().id(`prop-${label}`).h(30).flex_none().px(6).gap(10).items_center().rounded(6)
      .child(div().w(76).flex_none().text_size(12).text_color(t.dim).child(label))
      .child(h_flex().flex_1().min_w(0).gap(7).items_center().text_size(12.5).children([].concat(value)));
    if (!pick || this.canWrite === false) return row;
    const saving = this.saving === pick;
    return row.cursor_pointer().when(this.picking === pick, (el) => el.bg(t.hover)).when(!this.menu, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { if (!this.saving) { this.picking = this.picking === pick ? null : pick; cx.notify(); } })
      .child(saving ? svg(`${ICON}/spinner.svg`).size(12).spin(900).text_color(t.dim)
        : svg(`${ICON}/chevron-down.svg`).size(11).flex_none().text_color(t.dim));
  }

  options(items, t) {
    return v_flex().ml(92).mt(2).mb(6).p(4).rounded(8).bg(t.popover).border_1().border_color(t.border)
      .children(items.map(({ key, icon, label, current, onPick, header }) => header
        ? div().px(8).pt(6).pb(3).text_size(11).text_color(t.dim).child(header)
        : h_flex().id(`opt-${key}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().text_size(12.5)
          .when(!this.menu, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { if (current) { this.picking = null; cx.notify(); } else onPick(cx); })
          .child(icon)
          .child(div().flex_1().min_w(0).truncate().child(label))
          .when(current, (el) => el.child(svg(`${ICON}/check.svg`).size(12).text_color(t.accent)))));
  }

  pickers(d, users, t) {
    const set = (field, input) => (cx) => this.update(d, field, input, cx);
    const members = d.team.members.nodes.filter((m) => m.active && !m.app);
    const agents = users.filter((u) => u.active && u.app);
    return {
      status: [...d.team.states.nodes].sort(byType).map((s) => ({
        key: `state-${s.id}`, icon: statusIcon(s, t), label: s.name, current: s.id === d.state.id, onPick: set("status", { stateId: s.id }) })),
      priority: PRIORITIES.map(([p, label]) => ({
        key: `priority-${p}`, icon: priorityIcon(p, t), label, current: p === d.priority, onPick: set("priority", { priority: p }) })),
      assignee: [
        { key: "people", header: "People" },
        { key: "nobody", icon: nobody(t), label: "Unassigned", current: !d.assignee, onPick: set("assignee", { assigneeId: null }) },
        ...members.map((m) => ({ key: `member-${m.id}`, icon: avatar(m, t), label: m.isMe ? `${m.name} (you)` : m.name,
          current: m.id === d.assignee?.id, onPick: set("assignee", { assigneeId: m.id }) })),
        { key: "agents", header: "Agents work on it for the assignee" },
        { key: "no-agent", icon: nobody(t), label: "No agent", current: !d.delegate, onPick: set("assignee", { delegateId: null }) },
        ...agents.map((a) => ({ key: `agent-${a.id}`, icon: avatar(a, t, true), label: a.name,
          current: a.id === d.delegate?.id, onPick: set("assignee", { delegateId: a.id }) }))],
    };
  }

  linkRow(key, issue, t) {
    return h_flex().id(`${key}-${issue.identifier}`).h(30).flex_none().px(6).gap(7).items_center().rounded(6).cursor_pointer()
      .when(!this.menu, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.open(issue.identifier, cx))
      .child(priorityIcon(issue.priority, t))
      .child(div().flex_none().text_size(11.5).text_color(t.dim).child(issue.identifier))
      .child(statusIcon(issue.state, t))
      .child(div().flex_1().min_w(0).truncate().child(issue.title))
      .when(Boolean(issue.delegate), (el) => el.child(avatar(issue.delegate, t, true)))
      .when(Boolean(issue.assignee), (el) => el.child(avatar(issue.assignee, t)));
  }

  button(key, label, t, onClick, primary = false) {
    return div().id(key).h(26).px(10).flex().flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.bg(t.background).border_1().border_color(t.border).when(!this.menu, (el) => el.hover((s) => s.bg(t.hover))))
      .on_click(onClick).child(label);
  }

  keyButtons(t, prefix) {
    const org = this.setup.viewer?.organization?.urlKey;
    return [
      this.button(`${prefix}-create-key`, "Create key ↗", t, () => exec("xdg-open", [KEYS_URL(org)])),
      // `linear auth login` saves a new key beside the old one, under the organization's slug, without
      // making it the default; the default is what this panel and the CLI use, so switch to it.
      this.button(`${prefix}-login`, "Log in", t, () => run("terminal.open", { place: "right",
        argv: org ? ["sh", "-c", 'linear auth login && linear auth default "$1"', "sh", org] : ["linear", "auth", "login"] })),
    ];
  }

  readOnlyNotice(_d, t) {
    return v_flex().mt(10).p(12).gap(8).rounded(8).bg(t.raised).text_size(12)
      .child(div().font_medium().child("Editing is off"))
      .child(div().text_color(t.muted).child("Your Linear key can only read. Create a personal API key with write access, then log in with it."))
      .child(h_flex().gap(6).flex_wrap().children(this.keyButtons(t, "notice"))
        .child(this.button("notice-recheck", "Check again", t, (_e, cx) => { this.checkWrite(cx); cx.notify(); })));
  }

  // One setup step: its state mark, what it is, where it stands, and the fix when needed.
  step(n, title, state, detail, actions, t) {
    const mark = state === "ok" ? div().size(20).flex_none().rounded(10).bg(t.ansi2 + "26").text_color(t.ansi2).flex().items_center().justify_center()
        .child(svg(`${ICON}/check.svg`).size(11))
      : state === "wait" ? div().size(20).flex_none().flex().items_center().justify_center().child(svg(`${ICON}/spinner.svg`).size(13).spin(900).text_color(t.dim))
      : div().size(20).flex_none().rounded(10).border_1().border_color(state === "todo" ? t.ansi3 : t.border).text_size(11)
        .text_color(state === "todo" ? t.ansi3 : t.dim).flex().items_center().justify_center().child(String(n));
    return h_flex().gap(10).items_start().py(8)
      .child(mark)
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(div().text_size(12.5).font_medium().text_color(state === "blocked" ? t.dim : t.foreground).child(title))
        .child(div().text_size(12).text_color(t.muted).child(detail))
        .when(actions.length > 0, (el) => el.child(h_flex().pt(4).gap(6).flex_wrap().children(actions))));
  }

  renderWelcome(t) {
    const { cli, viewer, viewerError } = this.setup;
    const feature = (icon, text) => h_flex().gap(10).items_start().py(5)
      .child(div().w(16).pt(1).flex_none().flex().justify_center().text_color(t.muted).child(icon))
      .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(text));
    const install = cli === null ? ["wait", "Looking for the linear command…", []]
      : cli ? ["ok", `Found ${cli}.`, []]
      : ["todo", "Herdr reads Linear through the linear CLI. Install it from the AUR:", [
          this.button("welcome-install", "Install with paru", t, () => run("terminal.open", { argv: INSTALL, place: "right" }))]];
    const login = !cli ? ["blocked", "Needs the CLI first.", []]
      : viewer === null ? ["wait", "Checking your login…", []]
      : viewer ? ["ok", `Signed in as ${viewer.viewer.name} in ${viewer.organization.name}.`, []]
      : ["todo", `Create a personal API key in Linear, then log in with it. (${viewerError})`, this.keyButtons(t, "welcome")];
    const write = !viewer ? ["blocked", "Needs a login first.", []]
      : this.canWrite === null ? ["wait", "Checking what your key can do…", []]
      : this.canWrite ? ["ok", "Your key can change issues.", []]
      : ["todo", "Your key can only read, so you can browse but not change issues. To edit, create a key with write access and log in with it.", this.keyButtons(t, "welcome-write")];
    return [
      this.header(t, div().font_semibold().child("Welcome"), [], null),
      v_flex().id("linear-welcome").flex_1().min_h(0).overflow_y_scrollbar().px(16).pt(18).pb(16)
        .child(h_flex().gap(10).items_center().pb(6)
          .child(svg(`${OWN}/linear.svg`).size(22).text_color(t.foreground))
          .child(div().text_size(17).font_semibold().child("Linear, next to your terminals")))
        .child(div().text_size(12.5).text_color(t.muted).pb(14)
          .child("Your team's issues in a side panel, read and changed through your own Linear login."))
        .child(v_flex().pb(10)
          .child(feature(statusIcon({ type: "started", color: t.ansi3 }, t), "Browse issues by status and project, with sub-issues folded under their parent."))
          .child(feature(svg(`${ICON}/search.svg`).size(13), "Filter by who it's assigned to, status and project, or search by ID and title."))
          .child(feature(svg(`${OWN}/sub-issues.svg`).size(14), "Open an issue for its description, cycle, project, parent and sub-issues."))
          .child(feature(svg(`${ICON}/check.svg`).size(13), "Change status, priority, assignee and the agent working on it."))
          .child(feature(svg(`${OWN}/play.svg`).size(12), "Start an agent on an issue in a new tab, with a prompt you write in settings."))
          .child(feature(svg(`${OWN}/copy.svg`).size(13), "Copy an issue ID like ENG-123 in one click.")))
        .child(div().h(1).bg(t.border).my(8))
        .child(h_flex().pt(6).pb(2).items_center()
          .child(div().flex_1().text_size(13).font_semibold().child("Set up"))
          .child(this.button("welcome-recheck", this.checking ? "Checking…" : "Check again", t, (_e, cx) => { this.checkSetup(cx); cx.notify(); })))
        .child(this.step(1, "Install the Linear CLI", ...install, t))
        .child(this.step(2, "Log in to Linear", ...login, t))
        .child(this.step(3, "Allow editing (optional)", ...write, t))
        .child(h_flex().pt(16).justify_end()
          .child(this.button("welcome-done", viewer ? "Show issues" : "Skip for now", t, (_e, cx) => this.finishWelcome(cx), Boolean(viewer)).h(30).px(14))),
    ];
  }

  section(title, note, t) {
    return v_flex().gap(3).pb(12)
      .child(div().text_size(13.5).font_semibold().child(title))
      .when(Boolean(note), (el) => el.child(div().text_size(12).text_color(t.muted).child(note)));
  }

  actionCard(action, sample, t) {
    const ed = this.editors[action.id], agent = this.agentFor(action), focused = this.focusedPrompt === action.id;
    const insert = (name) => (_e, cx) => { ed.prompt.replace_with_token({ id: name.slice(1), text: name }); ed.prompt.focus(); cx.notify(); };
    // Variables share one look: in the prompt box, on the insert buttons.
    const chip = (text) => div().px(5).rounded(4).bg(t.accent + "24").text_color(t.accent).font_family("JetBrains Mono").child(text);
    return v_flex().mb(12).rounded(10).border_1().border_color(t.border).bg(t.raised)
      .child(h_flex().h(44).flex_none().pl(12).pr(6).gap(8).items_center()
        .child(svg(`${OWN}/play.svg`).size(11).flex_none().text_color(t.ansi2))
        .child(ed ? Input.new(ed.name).flex_1().min_w(0).h_full().text_size(13).font_semibold().text_color(t.foreground)
          : div().flex_1().min_w(0).truncate().font_semibold().child(action.name))
        .child(h_flex().id(`agent-of-${action.id}`).h(30).flex_none().pl(8).pr(7).gap(7).items_center().rounded(8).cursor_pointer()
          .bg(t.background).border_1().border_color(t.border).text_size(12.5)
          .hover((s) => s.bg(t.hover))
          .on_click(() => openOverlay({ mod: "linear", kind: "popup", width: 260, props: { pickAgent: action.id } }))
          .child(agentIcon(agent, t, 16))
          .child(div().child(agent?.name ?? (this.agents === null ? "…" : "Pick an agent")))
          .child(svg(`${ICON}/chevron-down.svg`).size(10).text_color(t.dim)))
        .child(this.iconButton(`remove-${action.id}`, svg(`${ICON}/x.svg`).size(11), t, (_e, cx) => this.removeAction(action.id, cx))))
      .child(v_flex().px(12).pb(12).gap(10)
        .child(v_flex().gap(6)
          .child(div().text_size(11).text_color(t.dim).child("Prompt"))
          .child(div().px(10).py(8).rounded(8).bg(t.background).border_1().border_color(focused ? t.accent : t.input).cursor_text()
            .child(ed ? Textarea.new(ed.prompt).w_full().text_size(12.5).text_color(t.foreground)
                .token((tok) => h_flex().h(tok.line_height).items_center().child(chip(tok.token.text)))
              : div().text_size(12.5).child(action.prompt))))
        .child(h_flex().gap(4).flex_wrap().items_center()
          .child(div().pr(2).text_size(11).text_color(t.dim).child("Insert"))
          .children(VARIABLES.map((name) => div().id(`insert-${action.id}-${name}`).h(22).px(3).flex().items_center().rounded(5)
            .cursor_pointer().text_size(11).hover((s) => s.bg(t.hover))
            .when(Boolean(ed), (el) => el.on_click(insert(name)))
            .child(chip(`+ ${name}`)))))
        .child(v_flex().gap(4).pt(2)
          .child(div().text_size(11).text_color(t.dim).child(`Sends, for ${sample.identifier}`))
          .child(div().pl(10).border_l(2).border_color(t.border).text_size(12).text_color(t.muted)
            .child(fillPrompt(action.prompt, sample) || "Nothing yet: write a prompt above."))));
  }

  renderSettings(t) {
    const sample = this.details[this.stack.at(-1)]?.issue ?? this.issues?.[0]
      ?? { identifier: "ENG-123", title: "Add dark mode to settings", url: "https://linear.app/…/ENG-123", branchName: "eng-123-add-dark-mode" };
    const list = actions();
    return [
      this.header(t, div().font_semibold().child("Settings"), [], (_e, cx) => { this.settingsOpen = false; cx.notify(); }),
      v_flex().id("linear-settings").flex_1().min_h(0).overflow_y_scrollbar().px(14).pt(16).pb(20)
        .child(this.section("Play actions", "Each one opens a new tab, starts its agent and sends its prompt. Pick one from ▶ on an issue.", t))
        .children(list.map((a) => this.actionCard(a, sample, t)))
        .child(h_flex().id("add-action").h(36).flex_none().gap(6).items_center().justify_center().rounded(10).cursor_pointer()
          .border_1().border_color(t.border).text_size(12.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.addAction(cx))
          .child(svg(`${ICON}/plus.svg`).size(12)).child("Add action"))
        .child(div().h(1).bg(t.border).my(22))
        .child(h_flex().gap(12).items_center()
          .child(v_flex().flex_1().min_w(0).gap(3)
            .child(div().text_size(13.5).font_semibold().child("Welcome"))
            .child(div().text_size(12).text_color(t.muted).child("The introduction and setup checks from the first run.")))
          .child(this.button("settings-welcome", "Show again", t,
            (_e, cx) => { this.settingsOpen = false; this.welcome = true; this.checkSetup(cx); cx.notify(); }))),
    ];
  }

  // ▶'s menu when there's more than one action.
  playMenu(d, t) {
    const stop = (_e, cx) => cx.stop_propagation();
    return v_flex().id("linear-play-menu").absolute().top(46).left(70).w(260).p(4).rounded(9).bg(t.popover).border_1().border_color(t.border)
      .on_mouse_down("left", stop).on_click(stop)
      .children(actions().map((a) => {
        const agent = this.agentFor(a);
        return this.menuRow(`play-${a.id}`, agentIcon(agent, t, 14),
          h_flex().gap(6).min_w(0).child(div().min_w(0).truncate().child(a.name || "Untitled"))
            .child(div().flex_none().text_size(11.5).text_color(t.dim).child(agent?.name ?? "")),
          false, t, (_e, cx) => { this.menu = null; this.startAgent(d, a, cx); cx.notify(); });
      }));
  }

  renderDetail(id, t) {
    const data = this.details[id], err = this.detailErrors[id], d = data?.issue;
    const title = h_flex().flex_1().min_w(0).gap(2).items_center()
      .child(div().font_semibold().flex_none().pr(6).child(id))
      .when(Boolean(d) && actions().length > 0, (el) => {
        const list = actions(), many = list.length > 1;
        return el.child(this.iconButton("linear-play",
          h_flex().gap(2).items_center().child(svg(`${OWN}/play.svg`).size(12))
            .when(many, (el) => el.child(svg(`${ICON}/chevron-down.svg`).size(9))), t,
          (_e, cx) => { if (many) { this.menu = this.menu === "play" ? null : "play"; cx.notify(); } else this.startAgent(d, list[0], cx); })
          .w(many ? 36 : 26).text_color(t.ansi2));
      })
      .child(this.iconButton("linear-copy", svg(`${OWN}/copy.svg`).size(13), t, () => copyId(id)))
      .when(Boolean(d), (el) => el.child(this.iconButton("linear-open", div().child("↗"), t, () => exec("xdg-open", [d.url]))));
    if (!d) return [this.header(t, title), div().p(16).text_color(err ? t.ansi1 : t.dim).child(err ?? "Loading…")];

    const pick = this.pickers(d, data.users.nodes, t);
    const children = [...d.children.nodes].sort((a, b) => byType(a.state, b.state) || rank(a.priority) - rank(b.priority));
    const done = children.filter((c) => c.state.type === "completed").length;
    const muted = (s) => div().min_w(0).truncate().text_color(t.dim).child(s);
    const cycle = d.cycle && [
      div().flex_none().child(d.cycle.name || `Cycle ${d.cycle.number}`),
      muted(`${date(d.cycle.startsAt)} – ${date(d.cycle.endsAt)}`),
      ...(d.cycle.isActive ? [div().flex_none().px(6).py(1).rounded(4).bg(t.accent + "26").text_color(t.accent).text_size(10.5).child("Current")] : []),
    ];
    const withPicker = (key, row) => [row, ...(this.picking === key ? [this.options(pick[key], t)] : [])];

    return [
      this.header(t, title),
      v_flex().id(`linear-detail-${id}`).flex_1().min_h(0).overflow_y_scrollbar().px(14).pt(14).pb(18)
        .when(Boolean(d.parent), (el) => el.child(h_flex().id("linear-parent").h(24).flex_none().px(2).gap(6).items_center().rounded(5)
          .cursor_pointer().text_size(11.5).text_color(t.dim).when(!this.menu, (el) => el.hover((s) => s.text_color(t.foreground)))
          .on_click((_e, cx) => this.open(d.parent.identifier, cx))
          .child(div().flex_none().child("Sub-issue of"))
          .child(statusIcon(d.parent.state, t, 12))
          .child(div().flex_none().child(d.parent.identifier))
          .child(div().min_w(0).truncate().child(d.parent.title))))
        .child(div().px(2).pt(4).pb(14).text_size(16).font_semibold().child(d.title))
        .child(v_flex().gap(1)
          .children(withPicker("status", this.prop("Status", [statusIcon(d.state, t), div().child(d.state.name)], t, "status")))
          .children(withPicker("priority", this.prop("Priority", [priorityIcon(d.priority, t), div().child(PRIORITIES.find(([p]) => p === d.priority)?.[1] ?? "No priority")], t, "priority")))
          .children(withPicker("assignee", this.prop("Assignee", [
            ...(d.assignee ? [avatar(d.assignee, t), div().flex_shrink_0().truncate().child(d.assignee.name)] : [nobody(t), muted("Unassigned")]),
            ...(d.delegate ? [div().pl(4).flex_none().text_color(t.dim).child("with"), avatar(d.delegate, t, true), div().min_w(0).truncate().child(d.delegate.name)] : []),
          ], t, "assignee")))
          .child(this.prop("Cycle", cycle ?? muted("No cycle"), t))
          .child(this.prop("Project", d.project ? [div().flex_none().child(d.project.name), ...(d.projectMilestone ? [muted(d.projectMilestone.name)] : [])] : muted("No project"), t)))
        .when(this.canWrite === false, (el) => el.child(this.readOnlyNotice(d, t)))
        .when(this.canWrite !== false && Boolean(this.updateErrors[id]), (el) => el.child(div().mt(6).p(10).rounded(7).bg(t.ansi1 + "18").text_size(12).text_color(t.ansi1).child(this.updateErrors[id])))
        .child(div().my(14).h(1).bg(t.border))
        .child(d.description
          ? TextView.markdown(`linear-desc-${id}`, d.description).selectable(true).text_size(12.5)
          : div().px(2).text_color(t.dim).child("No description."))
        .when(children.length > 0, (el) => el
          .child(h_flex().pt(22).pb(8).px(2).gap(8).items_center()
            .child(div().text_size(12.5).font_medium().child("Sub-issues"))
            .child(div().text_size(11.5).text_color(t.dim).child(`${done} of ${children.length} done`)))
          .child(h_flex().px(2).pb(8).gap(6).flex_wrap().children(tally(children).map(({ state, count }) =>
            h_flex().h(22).px(7).gap(5).items_center().rounded(6).bg(t.raised).text_size(11.5)
              .child(statusIcon(state, t, 12)).child(div().child(state.name)).child(div().text_color(t.dim).child(String(count))))))
          .children(children.map((c) => this.linkRow("child", c, t)))),
    ];
  }

  render(cx) {
    const t = theme();
    if (props()?.pickAgent) return this.renderAgentPicker(t);
    if (Date.now() - this.loadedAt > EVERY && !this.loading && this.shown()) this.refresh(cx);
    const open = this.stack.at(-1);
    return v_flex().id("linear").relative().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .children(this.welcome ? this.renderWelcome(t) : this.settingsOpen ? this.renderSettings(t) : open ? this.renderDetail(open, t) : this.renderList(t))
      .when(!this.welcome && !this.settingsOpen && Boolean(this.menu), (el) => el
        .child(div().id("linear-backdrop").absolute().inset_0().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.menu = null; cx.notify(); }))
        .child(this.menu === "play" ? (open && this.details[open] ? this.playMenu(this.details[open].issue, t) : div()) : this.filterMenu(t)));
  }
}
