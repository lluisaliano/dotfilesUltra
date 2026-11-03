// Git panel: Changes stages and commits what is tracked. History is read-only.
// Clicking a file shows its diff in a pane beside the terminal (this mod with props {diffPane}).
// Commit tracked never runs git add.

import { View, div, svg } from "gpui-kit";
import {
  v_flex,
  h_flex,
  TextareaState,
  Textarea,
  InputState,
  Input,
} from "gpui-base";
import {
  spaces,
  panes,
  focused,
  exec,
  readTextFile,
  watchFolder,
  theme as herdrTheme,
  home,
  props,
  run,
  openOverlay,
  shared,
  setShared,
} from "herdr";
import { tokenize, languageOf } from "./highlight.js";
import {
  parseStatus,
  stagePlan,
  stageAllPlan,
  commitPlan,
  diffTarget,
  branchLabel,
  tooManyChanges,
  parseBranches,
  switchArgs,
  BRANCH_FORMAT,
  deleteArgs,
  canDelete,
  deletedNote,
  filterBranches,
  canCreate,
  createArgs,
  unpushedArgs,
  parseCount,
  listHeight,
  syncArgs,
  needsRemote,
  isForce,
  parseAheadBehind,
  primaryAction,
  summarize,
  SYNC_MENU,
} from "./plan.js";

// The theme's "raised" gray reads too bright on a black background; buttons use it at 40%,
// as the Linear panel does.
const theme = () => {
  const t = herdrTheme();
  // 40% of "raised" over the background, as a solid #rrggbb: mods add their own alpha to it.
  const mix = (a, b, k) => {
    if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
    const c = (h, i) => parseInt(h.slice(i, i + 2), 16);
    return "#" + [1, 3, 5].map((i) => Math.round(c(a, i) * k + c(b, i) * (1 - k)).toString(16).padStart(2, "0")).join("");
  };
  const soft = mix(t.raised, t.background, 0.4);
  return { ...t, raised: soft, selected: soft };
};

// The file the diff pane shows: { root, on, path, untracked, at }. The panel sets it on a click.
const DIFF = "zed-changes.diff";

function location() {
  const space = spaces().find((s) => s.active),
    f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  // With the diff pane focused, the panel stays on the repository that pane shows.
  if (pane?.mod === "zed-changes" && shared(DIFF)?.root)
    return { cwd: shared(DIFF).root, on: shared(DIFF).on ?? null };
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const READ = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];

// The branches of a repository, ready for the picker (empty when git fails).
async function listBranches(root, on) {
  const r = await exec(
    "git",
    [
      ...READ,
      "for-each-ref",
      "--sort=-committerdate",
      `--format=${BRANCH_FORMAT}`,
      "refs/heads",
      "refs/remotes",
    ],
    { cwd: root, on },
  ).catch(() => null);
  return r?.code === 0 ? parseBranches(r.stdout) : [];
}

const SYNCING = {
  fetch: "Fetching…",
  "fetch-from": "Fetching…",
  pull: "Pulling…",
  "pull-rebase": "Pulling…",
  push: "Pushing…",
  "push-to": "Pushing…",
  "force-push": "Pushing…",
};

// A file's diff against HEAD as lines (an untracked file: all of it, as additions). Max 2000 lines.
async function diffLines({ root, on, path, untracked }) {
  if (untracked) {
    const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
    return text === null || text.includes("\0")
      ? ["No text diff"]
      : text
          .replace(/\n$/, "")
          .split("\n")
          .slice(0, 2000)
          .map((line) => `+${line}`);
  }
  const r = await exec(
    "git",
    [...READ, "diff", "HEAD", "--no-ext-diff", "--no-color", "--", path],
    { cwd: root, on },
  );
  if (r.code !== 0) throw new Error(r.stderr);
  const all = r.stdout.replace(/\n$/, "").split("\n");
  const first = all.findIndex((line) => line.startsWith("@@"));
  return first < 0 ? ["No changes"] : all.slice(first, first + 2000);
}

// Each diff line split into its +/-/space marker and syntax-colored spans; hunk headers stay plain.
function tokenizeDiff(lines, lang) {
  let state = null;
  return lines.map((line) => {
    if (!lang || line.startsWith("@@") || line === "No text diff") {
      if (line.startsWith("@@")) state = null;
      return null;
    }
    const r = tokenize(line.slice(1).replace(/\t/g, "    "), lang, state);
    state = r.state;
    return r.spans;
  });
}

export default class ZedChanges extends View {
  init(_given, cx) {
    if (props()?.diffPane) {
      // the diff pane: this same mod draws it, for the file in shared DIFF
      this.diffPane = true;
      this.lines = [];
      this.tokens = [];
      cx.timer.every(4000, (cx) => this.loadPane(cx, true)); // the file changes under agents
      return;
    }
    if (props()?.sync) {
      this.syncMenu = props();
      this.menuError = null;
      this.pending = null;
      this.syncing = null;
      return;
    } // the sync popup: this same mod draws it
    if (props()?.confirm) {
      this.dialog = props();
      this.menuError = null;
      return;
    } // the delete modal: this same mod draws it
    if (props()?.menu) {
      // the branch popup: this same mod draws it
      this.menu = props();
      this.menuError = null;
      this.menuNote = null;
      this.search = InputState.new({
        placeholder: "Switch or type to create a branch...",
      });
      this.search.on("change", (_e, cx2) => cx2.notify());
      this.search.on("submit", (_e, cx2) => this.submitSearch(cx2));
      try {
        this.search.focus();
      } catch {
        /* not ready yet: the box still takes a click */
      }
      return;
    }
    this.files = [];
    this.history = [];
    this.tab = "changes";
    this.diff = false;
    this.selected = null;
    this.tooMany = false;
    this.remotes = [];
    this.upstream = false;
    this.ahead = 0;
    this.behind = 0;
    this.syncing = null;
    this.lines = [];
    this.branch = "";
    this.message = "";
    this.handle = cx.focus_handle();
    this.input = TextareaState.new({
      placeholder: "Enter commit message",
      rows: 5,
    });
    this.input.on("change", (_e, cx) => {
      this.message = this.input.value();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (this.context === context) this.refresh(cx);
        }
      } catch {
        if (this.context === context) this.watched = null;
      }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const here = location(),
      context = key();
    if (context !== this.context) {
      this.context = context;
      this.root = null;
      this.files = [];
      this.history = [];
      this.selected = null;
      this.tooMany = false;
      this.lines = [];
      this.branch = "";
      this.error = null;
      this.note = null;
      this.watched = null;
    }
    if (!here.cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args) =>
          exec("git", [...READ, ...args], { cwd: here.cwd, on: here.on });
        const top = await git(["rev-parse", "--show-toplevel"]);
        if (key() !== context) return;
        if (top.code !== 0) {
          this.root = null;
          this.error = "Not a git repository";
          return;
        }
        const root = top.stdout.trim();
        const at = (args) =>
          exec("git", [...READ, ...args], { cwd: root, on: here.on });
        if (!here.on && tooManyChanges(root, home(), 0)) {
          // Never run `status` here: it would walk the whole home directory.
          this.root = root;
          this.on = here.on;
          this.files = [];
          this.history = [];
          this.selected = null;
          this.lines = [];
          this.remotes = [];
          this.branch = "—";
          this.tooMany = true;
          this.error =
            "Your home folder is a git repository: too many changes to list";
          return;
        }
        const [status, branch, log, remotes, counts] = await Promise.all([
          at([
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
          ]),
          at(["symbolic-ref", "--short", "-q", "HEAD"]),
          at(["log", "-30", "--pretty=format:%h%x00%s"]),
          at(["remote"]),
          at(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
        ]);
        if (key() !== context) return;
        if (status.code !== 0) throw new Error(status.stderr);
        this.root = root;
        this.on = here.on;
        this.history =
          log.code === 0
            ? log.stdout
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const [hash, subject] = line.split("\0");
                  return { hash, subject };
                })
            : [];
        this.branch = branchLabel(
          branch.code === 0 ? branch.stdout.trim() : "",
          log.code === 0,
        );
        this.remotes =
          remotes.code === 0
            ? remotes.stdout
                .split("\n")
                .map((r) => r.trim())
                .filter(Boolean)
            : [];
        const ab = counts.code === 0 ? parseAheadBehind(counts.stdout) : null; // fails without an upstream
        this.upstream = Boolean(ab);
        this.ahead = ab?.ahead ?? 0;
        this.behind = ab?.behind ?? 0;
        const all = parseStatus(status.stdout);
        this.tooMany = tooManyChanges(root, home(), all.length);
        this.files = this.tooMany ? [] : all.slice(0, 1000);
        if (
          this.selected &&
          !this.files.some((file) => file.path === this.selected)
        ) {
          this.selected = null;
          this.lines = [];
        }
        if (this.diff) this.selected = diffTarget(this.selected, this.files);
        this.error = this.tooMany
          ? `Too many changes to list (${all.length})`
          : null;
        this.watch(root, cx);
        if (this.diff && this.selected)
          await this.loadDiff(this.selected, context);
      } catch (e) {
        if (key() === context) this.error = String(e.message || e);
      } finally {
        if (key() === context) this.loading = false;
        cx.notify();
      }
    });
  }

  async loadDiff(path, context) {
    const file = this.files.find((item) => item.path === path);
    if (!file || !this.root) return;
    let lines;
    if (file.xy === "??") {
      const text = await readTextFile(`${this.root}/${path}`, {
        on: this.on,
      }).catch(() => null);
      lines =
        text === null || text.includes("\0")
          ? ["No text diff"]
          : text
              .replace(/\n$/, "")
              .split("\n")
              .slice(0, 400)
              .map((line) => `+${line}`);
    } else {
      const r = await exec(
        "git",
        [...READ, "diff", "HEAD", "--no-ext-diff", "--no-color", "--", path],
        { cwd: this.root, on: this.on },
      );
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n");
      const first = all.findIndex((line) => line.startsWith("@@"));
      lines = first < 0 ? ["No text diff"] : all.slice(first, first + 400);
    }
    if (key() === context && this.selected === path) {
      this.lines = lines;
      this.tokens = tokenizeDiff(lines, languageOf(path));
    }
  }

  pick(path, cx) {
    this.selected = path;
    this.lines = [];
    this.tokens = [];
    if (this.diff) {
      const context = this.context;
      cx.spawn(async (cx) => {
        try {
          await this.loadDiff(path, context);
        } catch (e) {
          if (key() === context) this.note = String(e.message || e);
        }
        cx.notify();
      });
    }
    cx.notify();
  }

  // Lists the branches and opens the picker as a popup under the branch name.
  async openBranches() {
    if (!this.root || this.tooMany) return;
    const branches = await listBranches(this.root, this.on);
    openOverlay({
      mod: "zed-changes",
      kind: "popup",
      width: 400,
      height: listHeight(branches, true) + 100,
      props: { menu: true, root: this.root, on: this.on, branches },
    });
  }

  async runGit(args) {
    const { root, on } = this.menu ?? this.dialog;
    return exec("git", [...READ, ...args], { cwd: root, on }).catch((e) => ({
      code: 1,
      stdout: "",
      stderr: String(e.message || e),
    }));
  }

  fail(r, cx) {
    this.menuError = (r.stderr || "git failed")
      .trim()
      .split("\n")
      .slice(0, 3)
      .join(" ");
    this.menuNote = null;
    cx.notify();
  }

  async pickBranch(branch, cx) {
    if (branch.current) {
      run("overlay.close");
      return;
    }
    const r = await this.runGit(switchArgs(branch.name));
    if (r.code === 0) run("overlay.close");
    else this.fail(r, cx);
  }

  async createBranch(name, cx) {
    const r = await this.runGit(createArgs(name));
    if (r.code === 0) run("overlay.close");
    else this.fail(r, cx);
  }

  // --- Fetch / pull / push. The button beside the branch name runs the likely one; its ▾ opens a popup.
  openSyncMenu() {
    if (!this.root || this.tooMany) return;
    openOverlay({
      mod: "zed-changes",
      kind: "popup",
      width: 250,
      height: 280,
      props: {
        sync: true,
        root: this.root,
        on: this.on,
        remotes: this.remotes,
        upstream: this.upstream,
        branch: this.branch,
      },
    });
  }

  // Runs a menu entry. In the popup a failure stays visible there; a success closes it. Either way the
  // outcome is published as `zed-changes.result`, which the panel shows for a few seconds.
  async doSync(op, remote, cx) {
    const src = this.syncMenu ?? this,
      args = syncArgs(op, { remote, upstream: src.upstream });
    if (!args || this.syncing) return;
    this.syncing = SYNCING[op];
    this.menuError = null;
    cx.notify();
    const r = await exec("git", [...READ, ...args], {
      cwd: src.root,
      on: src.on,
    }).catch((e) => ({ code: 1, stdout: "", stderr: String(e.message || e) }));
    this.syncing = null;
    const text = summarize(r.stdout, r.stderr);
    setShared("zed-changes.result", { text, ok: r.code === 0, at: Date.now() });
    if (this.syncMenu) {
      if (r.code === 0) run("overlay.close", { id: this.syncMenu.overlay });
      else {
        this.menuError = text;
        this.pending = null;
      }
    } else this.refresh(cx);
    cx.notify();
  }

  requestSync(op, cx) {
    if (needsRemote(op)) {
      this.pending = op;
      cx.notify();
      return;
    }
    if (isForce(op)) {
      const { root, on, overlay, upstream, branch } = this.syncMenu;
      run("overlay.close", { id: overlay });
      openOverlay({
        mod: "zed-changes",
        kind: "dialog",
        width: 400,
        height: 200,
        props: {
          confirm: true,
          sync: true,
          root,
          on,
          args: syncArgs(op, { upstream }),
          title: `Force push ${branch}?`,
          body: "This overwrites the remote branch with yours. It uses --force-with-lease, so git refuses if someone pushed since your last fetch; commits only the remote has are lost.",
        },
      });
      return;
    }
    cx.spawn(async (cx) => this.doSync(op, undefined, cx));
  }

  renderSyncMenu() {
    const t = theme(),
      { remotes } = this.syncMenu;
    const row = (id, label, act, hint) =>
      h_flex()
        .id(id)
        .h(30)
        .px(10)
        .gap(8)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(12.5)
        .text_color(this.syncing ? t.dim : t.foreground)
        .hover((s) => s.bg(t.selected))
        .on_click((_e, cx) => {
          if (!this.syncing) act(cx);
        })
        .child(div().flex_1().min_w(0).truncate().child(label))
        .when(Boolean(hint), (el) =>
          el.child(
            div().flex_none().text_size(11).text_color(t.dim).child(hint),
          ),
        );
    const body = this.pending
      ? [
          div()
            .px(10)
            .pt(6)
            .pb(4)
            .text_size(11.5)
            .text_color(t.dim)
            .child(this.pending === "fetch-from" ? "Fetch from" : "Push to"),
          ...remotes.map((r) =>
            row(`sync-remote-${r}`, r, (cx) =>
              cx.spawn(async (cx) => this.doSync(this.pending, r, cx)),
            ),
          ),
          row("sync-back", "Back", (cx) => {
            this.pending = null;
            cx.notify();
          }),
        ]
      : SYNC_MENU.map((entry) =>
          entry === "-"
            ? div().h(1).my(4).bg(t.border)
            : row(`sync-${entry[0]}`, entry[1], (cx) =>
                this.requestSync(entry[0], cx),
              ),
        );
    return v_flex()
      .id("zed-sync")
      .w_full()
      .p(6)
      .bg(t.popover)
      .when(Boolean(this.syncing), (el) =>
        el.child(
          div()
            .px(10)
            .py(6)
            .text_size(12)
            .text_color(t.accent)
            .child(this.syncing),
        ),
      )
      .children(body)
      .when(Boolean(this.menuError), (el) =>
        el.child(
          div()
            .px(10)
            .py(6)
            .text_size(11.5)
            .text_color(t.ansi1)
            .child(this.menuError),
        ),
      );
  }

  // Handlers below take the `cx` of a `cx.spawn` task: an event handler's own `cx` is only valid until
  // the handler returns, so `cx.notify()` after an `await` on it never redraws.
  // Enter in the search box: create the typed name if it is new, else switch to the first match.
  submitSearch(cx) {
    const query = this.search.value(),
      branches = this.menu.branches;
    if (canCreate(branches, query))
      cx.spawn(async (cx) => this.createBranch(query.trim(), cx));
    else {
      const first = filterBranches(branches, query)[0];
      if (first) cx.spawn(async (cx) => this.pickBranch(first, cx));
    }
  }

  // The trash icon deletes at once. Only a branch with commits no remote has asks first, in a modal.
  async requestDelete(branch, cx) {
    const count = parseCount(
      (await this.runGit(unpushedArgs(branch.name))).stdout,
    );
    if (count === 0) {
      await this.deleteNow(branch.name, cx);
      return;
    }
    const { root, on, overlay } = this.menu;
    run("overlay.close", { id: overlay });
    openOverlay({
      mod: "zed-changes",
      kind: "dialog",
      width: 400,
      height: 190,
      props: {
        confirm: true,
        root,
        on,
        args: deleteArgs(branch.name),
        title: `Delete branch ${branch.name}?`,
        body: `It has ${count} commit${count === 1 ? "" : "s"} that no remote has. They will be lost from the branch; git reflog can still recover them for a while.`,
      },
    });
  }

  async deleteNow(name, cx) {
    const r = await this.runGit(deleteArgs(name));
    if (r.code !== 0) {
      this.fail(r, cx);
      return;
    }
    const { root, on } = this.menu;
    this.menu = { ...this.menu, branches: await listBranches(root, on) };
    this.menuError = null;
    this.menuNote = deletedNote(name, r.stdout);
    cx.notify();
  }

  // The modal: accept runs the command it was opened with (delete a branch, force push), cancel closes it.
  async acceptConfirm(cx) {
    const r = await this.runGit(this.dialog.args);
    if (r.code !== 0) {
      this.fail(r, cx);
      return;
    }
    if (this.dialog.sync)
      setShared("zed-changes.result", {
        text: summarize(r.stdout, r.stderr),
        ok: true,
        at: Date.now(),
      });
    run("overlay.close", { id: this.dialog.overlay });
  }

  renderDialog() {
    const t = theme(),
      { title, body } = this.dialog;
    const button = (id, label, bg, color, act) =>
      div()
        .id(id)
        .h(30)
        .px(14)
        .flex()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(12.5)
        .bg(bg)
        .text_color(color)
        .on_click((_e, cx) => act(cx))
        .child(label);
    return v_flex()
      .id("zed-confirm")
      .w_full()
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(div().text_size(15).font_semibold().child(title))
      .child(div().text_size(12.5).text_color(t.muted).child(body))
      .when(Boolean(this.menuError), (el) =>
        el.child(
          div().text_size(11.5).text_color(t.ansi1).child(this.menuError),
        ),
      )
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .pt(4)
          .child(
            button("confirm-cancel", "Cancel", t.raised, t.muted, () =>
              run("overlay.close", { id: this.dialog.overlay }),
            ),
          )
          .child(
            button("confirm-accept", "Accept", t.ansi1, t.background, (cx) =>
              cx.spawn(async (cx) => this.acceptConfirm(cx)),
            ),
          ),
      );
  }

  // The branch popup, laid out like Zed's: sections, two-line rows (name, then author · age · subject),
  // a trash icon on deletable rows, and a search box at the bottom that also creates branches.
  renderMenu() {
    const t = theme(),
      query = this.search?.value() ?? "",
      all = this.menu.branches;
    const shown = filterBranches(all, query),
      local = shown.filter((b) => !b.remote),
      remote = shown.filter((b) => b.remote);
    const heading = (text) =>
      div().px(10).pt(10).pb(4).text_size(11.5).text_color(t.dim).child(text);
    const row = (b) =>
      h_flex()
        .id(`branch-${b.remote ?? "local"}-${b.name}`)
        .px(10)
        .py(7)
        .gap(10)
        .items_center()
        .rounded(8)
        .cursor_pointer()
        .hover((s) => s.bg(t.selected))
        .on_click((_e, cx) => cx.spawn(async (cx) => this.pickBranch(b, cx)))
        .child(
          div()
            .size(16)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .child(
              svg(
                b.current
                  ? "mods/zed-changes/icons/check.svg"
                  : b.remote
                    ? "mods/zed-changes/icons/cloud.svg"
                    : "mods/zed-changes/icons/git-branch.svg",
              )
                .size(15)
                .text_color(b.current ? t.accent : t.dim),
            ),
        )
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(
              div()
                .truncate()
                .text_size(13.5)
                .text_color(t.foreground)
                .child(b.remote ? `${b.remote}/${b.name}` : b.name),
            )
            .child(
              div()
                .truncate()
                .text_size(11.5)
                .text_color(t.dim)
                .child(
                  [b.author, b.age, b.subject].filter(Boolean).join("  •  "),
                ),
            ),
        )
        .when(canDelete(b), (el) =>
          el.child(
            div()
              .id(`branch-trash-${b.name}`)
              .size(26)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(6)
              .hover((s) => s.bg(t.raised))
              .tooltip(`Delete ${b.name}`)
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => {
                cx.stop_propagation();
                cx.spawn(async (cx) => this.requestDelete(b, cx));
              })
              .child(
                svg("mods/zed-changes/icons/trash.svg")
                  .size(14)
                  .text_color(t.dim),
              ),
          ),
        );
    const create = canCreate(all, query)
      ? h_flex()
          .id("branch-create")
          .px(10)
          .py(9)
          .gap(10)
          .items_center()
          .rounded(8)
          .cursor_pointer()
          .text_size(13)
          .text_color(t.accent)
          .hover((s) => s.bg(t.selected))
          .on_click((_e, cx) =>
            cx.spawn(async (cx) => this.createBranch(query.trim(), cx)),
          )
          .child(`Create branch “${query.trim()}”`)
      : null;
    return v_flex()
      .id("zed-branches")
      .w_full()
      .p(6)
      .bg(t.popover)
      .child(
        v_flex()
          .id("branch-list")
          .h(Math.max(40, listHeight(shown, Boolean(create))))
          .overflow_y_scrollbar()
          .when(local.length > 0, (el) =>
            el.child(heading("Local Branches")).children(local.map(row)),
          )
          .when(remote.length > 0, (el) =>
            el.child(heading("Remote Branches")).children(remote.map(row)),
          )
          .when(shown.length === 0 && !create, (el) =>
            el.child(
              div()
                .px(10)
                .py(10)
                .text_size(12)
                .text_color(t.dim)
                .child("No matching branches"),
            ),
          )
          .when(Boolean(create), (el) => el.child(create)),
      )
      .when(Boolean(this.menuError), (el) =>
        el.child(
          div()
            .px(10)
            .py(6)
            .text_size(11.5)
            .text_color(t.ansi1)
            .child(this.menuError),
        ),
      )
      .when(Boolean(this.menuNote), (el) =>
        el.child(
          div()
            .px(10)
            .py(6)
            .text_size(11.5)
            .text_color(t.muted)
            .child(this.menuNote),
        ),
      )
      .child(
        div()
          .mt(4)
          .h(36)
          .px(10)
          .flex()
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .text_size(12.5)
          .child(Input.new(this.search).size_full().text_color(t.foreground)),
      );
  }

  // A click on a file shows its diff in a pane beside the terminal: the tab's diff pane if it has
  // one, else a new one split to the right. The terminal keeps the keyboard.
  openFile(path, cx) {
    const file = this.files.find((item) => item.path === path);
    if (!file || !this.root) return;
    this.selected = path;
    setShared(DIFF, {
      root: this.root,
      on: this.on,
      path,
      untracked: file.xy === "??",
      deleted: file.xy.includes("D"),
      at: Date.now(),
    });
    const f = focused();
    const tab = f?.tab;
    const open = panes().some(
      (p) => p.tab === tab && p.mod === "zed-changes",
    );
    if (!open) {
      const from = f?.pane ?? panes().find((p) => p.tab === tab && p.terminal)?.pane;
      run("pane.split", {
        direction: "right",
        ...(from ? { pane: from } : {}),
        mod: "zed-changes",
        props: { diffPane: true },
      });
      if (from) run("pane.focus", { pane: from });
    }
    cx.notify();
  }

  // The diff pane: (re)loads when the panel picks another file, and on its timer.
  loadPane(cx, again) {
    const target = shared(DIFF);
    if (!target || this.paneLoading) return;
    if (!again && target.at === this.shownAt) return;
    this.paneLoading = true;
    const at = target.at;
    cx.spawn(async (cx) => {
      try {
        const lines = await diffLines(target);
        if (shared(DIFF)?.at === at) {
          this.shownAt = at;
          this.paneError = null;
          if (lines.join("\n") !== this.lines.join("\n")) {
            this.lines = lines;
            this.tokens = tokenizeDiff(lines, languageOf(target.path));
          }
        }
      } catch (e) {
        this.shownAt = at;
        this.paneError = String(e.message || e);
      } finally {
        this.paneLoading = false;
        cx.notify();
      }
    });
  }

  // `wide`: the pane scrolls sideways, so rows keep their whole line instead of cutting it.
  diffRow(line, i, t, size, wide) {
    const mark = line.startsWith("+")
      ? t.ansi2
      : line.startsWith("-")
        ? t.ansi1
        : null;
    const spans = this.tokens?.[i];
    const base = div()
      .id(`zed-diff-${i}`)
      .px(10)
      .h(size + 7)
      .flex_none()
      .text_size(size)
      .when(Boolean(mark), (el) => el.bg(mark + "18"));
    if (!spans)
      return (wide ? base.whitespace_nowrap() : base.truncate())
        .text_color(mark ?? t.dim)
        .child(line);
    const colors = {
      keyword: t.ansi5,
      string: t.ansi2,
      comment: t.dim,
      function: t.ansi4,
      type: t.ansi3,
      number: t.ansi1,
      boolean: t.ansi1,
      variable: t.ansi6,
    };
    return base
      .flex()
      .when(!wide, (el) => el.overflow_hidden())
      .whitespace_nowrap()
      .child(
        div()
          .w(10)
          .flex_none()
          .text_color(mark ?? t.dim)
          .child(line[0] === " " ? "" : (line[0] ?? "")),
      )
      .children(
        spans.map((sp) =>
          div()
            .text_color(sp.cls ? (colors[sp.cls] ?? t.foreground) : t.foreground)
            .child(sp.text),
        ),
      );
  }

  renderDiffPane(cx) {
    const t = theme(),
      target = shared(DIFF);
    if (target && target.at !== this.shownAt) this.loadPane(cx);
    const parts = (target?.path ?? "").split("/"),
      name = parts.pop();
    return v_flex()
      .id("zed-diff-pane")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .child(
        h_flex()
          .h(32)
          .flex_none()
          .px(12)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .text_size(12.5)
          .child(div().font_semibold().child(name || "Diff"))
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_color(t.dim)
              .child(parts.length ? parts.join("/") + "/" : ""),
          )
          // Open: the whole file in a tab, as the Files panel opens one (zed-file).
          .when(Boolean(target) && !target.deleted, (el) =>
            el.child(
              div()
                .id("zed-diff-open")
                .h(22)
                .px(8)
                .flex()
                .flex_none()
                .items_center()
                .rounded(5)
                .text_size(12)
                .bg(t.raised)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click(() =>
                  run("tab.new", {
                    name: name,
                    mod: "zed-file",
                    props: { file: `${target.root}/${target.path}`, on: target.on ?? null },
                  }),
                )
                .child("Open"),
            ),
          ),
      )
      .child(
        v_flex()
          .id("zed-diff-pane-lines")
          .flex_1()
          .min_h(0)
          .py(4)
          .overflow_y_scrollbar()
          .when(!target, (el) =>
            el.child(
              div().p(12).text_color(t.dim).child("Click a file in Changes to see its diff"),
            ),
          )
          .when(Boolean(this.paneError), (el) =>
            el.child(div().p(12).text_size(12).text_color(t.ansi1).child(this.paneError)),
          )
          .when(Boolean(target) && !this.lines.length && !this.paneError, (el) =>
            el.child(div().p(12).text_color(t.dim).child("Loading…")),
          )
          .child(
            div()
              .id("zed-diff-pane-x")
              .w_full()
              .overflow_x_scrollbar()
              .child(
                v_flex()
                  .min_w(
                    Math.max(300, ...this.lines.map((l) => l.length * 7.5 + 40)),
                  )
                  .children(
                    this.lines.map((line, i) => this.diffRow(line, i, t, 12, true)),
                  ),
              ),
          ),
      );
  }

  git(args, cx, after) {
    if (!this.root || this.busy) return;
    const context = this.context;
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: this.root, on: this.on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        if (key() === context && after) after();
      } catch (e) {
        if (key() === context) this.note = String(e.message || e);
      } finally {
        this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  // --- Pull request. Opens the branch's open PR if it has one; otherwise pushes what GitHub doesn't
  // have yet (so gh never prompts) and opens GitHub's "new pull request" page with `gh pr create --web`.
  // The outcome goes to `zed-changes.result`, like fetch/pull/push.
  async createPR(cx) {
    if (!this.root || this.prBusy || this.syncing) return;
    const root = this.root,
      on = this.on,
      upstream = this.upstream,
      ahead = this.ahead;
    const run2 = (cmd, args) =>
      exec(cmd, args, { cwd: root, on }).catch((e) => ({
        code: 1,
        stdout: "",
        stderr: String(e.message || e),
      }));
    const say = (text, ok) =>
      setShared("zed-changes.result", { text, ok, at: Date.now() });
    const step = (label) => {
      this.prBusy = label;
      cx.notify();
    };
    try {
      step("Checking…");
      const branch = (await run2("git", ["branch", "--show-current"])).stdout.trim();
      if (!branch) return say("Detached HEAD: switch to a branch to open a pull request", false);
      const open = await run2("gh", ["pr", "view", branch, "--json", "state", "-q", ".state"]);
      if (open.code === 0 && open.stdout.trim() === "OPEN") {
        const r = await run2("gh", ["pr", "view", branch, "--web"]);
        return say(r.code === 0 ? `Opened the pull request for ${branch}` : summarize(r.stdout, r.stderr), r.code === 0);
      }
      const base = await run2("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
      if (base.code !== 0) return say(summarize(base.stdout, base.stderr), false);
      if (base.stdout.trim() === branch)
        return say(`You're on ${branch}, the default branch: create a branch for the pull request first`, false);
      if (!upstream || ahead > 0) {
        step("Pushing…");
        const r = await run2("git", syncArgs("push", { upstream }));
        if (r.code !== 0) return say(summarize(r.stdout, r.stderr), false);
      }
      step("Opening…");
      const r = await run2("gh", ["pr", "create", "--web", "--head", branch]);
      say(r.code === 0 ? `Opened GitHub to create the pull request for ${branch}` : summarize(r.stdout, r.stderr), r.code === 0);
    } finally {
      this.prBusy = null;
      this.refresh(cx);
      cx.notify();
    }
  }

  commit(cx) {
    const plan = commitPlan(this.message, this.files);
    if (plan.error) {
      this.note = plan.error;
      cx.notify();
      return;
    }
    this.git(plan.args, cx, () => {
      this.message = "";
      this.input.set_value("");
    });
  }

  chip(id, label, on, action, t) {
    return div()
      .id(id)
      .h(24)
      .px(8)
      .flex()
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .flex_none()
      .text_size(12)
      .bg(on ? t.selected : t.chrome)
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => action(cx))
      .child(label);
  }

  render(cx) {
    if (this.diffPane) return this.renderDiffPane(cx);
    if (this.dialog) return this.renderDialog();
    if (this.syncMenu) return this.renderSyncMenu();
    if (this.menu) return this.renderMenu();
    const t = theme();
    const act =
      this.root && !this.tooMany
        ? primaryAction({
            remotes: this.remotes,
            upstream: this.upstream,
            ahead: this.ahead,
            behind: this.behind,
          })
        : null;
    const result = shared("zed-changes.result"),
      showResult = result && Date.now() - result.at < 12000;
    const letter = (xy) =>
      xy.includes("U")
        ? "U"
        : xy.includes("D")
          ? "D"
          : xy.includes("A") || xy === "??"
            ? "A"
            : "M";
    return v_flex()
      .id("zed-changes")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(8)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(
            this.chip(
              "zed-changes-tab",
              "Changes",
              this.tab === "changes",
              (cx) => {
                this.tab = "changes";
                cx.notify();
              },
              t,
            ),
          )
          .child(
            this.chip(
              "zed-history-tab",
              "History",
              this.tab === "history",
              (cx) => {
                this.tab = "history";
                cx.notify();
              },
              t,
            ),
          )
          .child(div().flex_1())
          .when(this.tab === "changes", (el) =>
            el.when(!this.tooMany, (el) =>
                el.child(
                  this.chip(
                    "zed-stage-all",
                    "Stage All",
                    false,
                    (cx) => this.git(stageAllPlan(), cx),
                    t,
                  ),
                ),
              ),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .when(this.tab === "history", (el) =>
            el.children(
              this.history.map((commit) =>
                h_flex()
                  .h(28)
                  .flex_none()
                  .px(12)
                  .gap(8)
                  .items_center()
                  .child(
                    div().text_color(t.dim).text_size(12).child(commit.hash),
                  )
                  .child(
                    div().flex_1().min_w(0).truncate().child(commit.subject),
                  ),
              ),
            ),
          )
          .when(this.tab === "changes" && this.files.length > 0, (el) =>
            el.children(
              this.files.map((file) =>
                h_flex()
                  .id(`zed-change-${file.path}`)
                  .h(26)
                  .flex_none()
                  .px(8)
                  .gap(8)
                  .items_center()
                  .cursor_pointer()
                  .bg(this.selected === file.path ? t.selected : t.chrome)
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.openFile(file.path, cx))
                  .child(
                    div()
                      .id(`zed-stage-${file.path}`)
                      .size(16)
                      .flex_none()
                      .flex()
                      .items_center()
                      .justify_center()
                      .rounded(3)
                      .border(1)
                      .border_color(file.staged ? t.accent : t.border)
                      .bg(file.staged ? t.accent : t.chrome)
                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                      .on_click((_e, cx) => {
                        cx.stop_propagation();
                        this.git(stagePlan(file), cx);
                      }),
                  )
                  .child(
                    div()
                      .w(12)
                      .text_size(11)
                      .text_color(
                        letter(file.xy) === "D"
                          ? t.ansi1
                          : letter(file.xy) === "A"
                            ? t.ansi2
                            : t.blocked,
                      )
                      .child(letter(file.xy)),
                  )
                  .child(div().flex_1().min_w(0).truncate().child(file.path)),
              ),
            ),
          )
          .when(this.tab === "changes" && !this.files.length, (el) =>
            el.child(
              div()
                .flex_1()
                .flex()
                .items_center()
                .justify_center()
                .text_color(t.dim)
                .child(
                  this.error ||
                    (this.loading
                      ? "Loading…"
                      : this.root
                        ? "No changes to commit"
                        : "No folder"),
                ),
            ),
          )
          .when(this.tab === "history" && !this.history.length, (el) =>
            el.child(
              div()
                .p(12)
                .text_color(t.dim)
                .child(this.loading ? "Loading…" : "No commits"),
            ),
          ),
      )
      .when(Boolean(showResult), (el) =>
        el.child(
          div()
            .px(10)
            .py(4)
            .text_size(11)
            .text_color(result.ok ? t.muted : t.ansi1)
            .child(result.text),
        ),
      )
      .when(Boolean(this.note), (el) =>
        el.child(
          div().px(10).py(4).text_size(11).text_color(t.ansi1).child(this.note),
        ),
      )
      .when(this.tab === "changes", (el) =>
        el.child(
          v_flex()
            .flex_none()
            .gap(8)
            .p(8)
            .border_t(1)
            .border_color(t.border)
            .child(
              h_flex()
                .items_center()
                .child(
                  div()
                    .id("zed-branch")
                    .px(6)
                    .py(2)
                    .rounded(5)
                    .text_size(12)
                    .text_color(t.muted)
                    .when(Boolean(this.root) && !this.tooMany, (el) =>
                      el
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .on_click(() => this.openBranches()),
                    )
                    .child(
                      `${this.branch || "detached"}${this.root && !this.tooMany ? " ▾" : ""}`,
                    ),
                )
                .child(div().flex_1())
                .when(Boolean(act), (el) =>
                  el.child(
                    h_flex()
                      .items_center()
                      .rounded(5)
                      .bg(t.raised)
                      .text_size(12)
                      .child(
                        div()
                          .id("zed-sync-main")
                          .h(24)
                          .px(8)
                          .flex()
                          .items_center()
                          .rounded(5)
                          .cursor_pointer()
                          .text_color(this.syncing ? t.dim : t.foreground)
                          .hover((s) => s.bg(t.hover))
                          .on_click((_e, cx) => {
                            if (!this.syncing)
                              cx.spawn(async (cx) =>
                                this.doSync(act.op, undefined, cx),
                              );
                          })
                          .child(this.syncing ?? act.label),
                      )
                      .child(
                        div()
                          .id("zed-sync-menu")
                          .h(24)
                          .px(6)
                          .flex()
                          .items_center()
                          .rounded(5)
                          .cursor_pointer()
                          .text_color(t.muted)
                          .hover((s) => s.bg(t.hover))
                          .on_click(() => this.openSyncMenu())
                          .child("▾"),
                      ),
                  ),
                ),
            )
            .child(
              div()
                .h(112)
                .px(8)
                .py(6)
                .rounded(6)
                .border(1)
                .border_color(t.border)
                .bg(t.background)
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .child(
                  Textarea.new(this.input)
                    .size_full()
                    .text_size(12)
                    .text_color(t.foreground),
                ),
            )
            .child(
              h_flex()
                .gap(8)
                .justify_end()
                .items_center()
                .when(Boolean(this.root) && !this.tooMany && this.remotes.length > 0, (el) =>
                  el.child(
                    div()
                      .id("zed-create-pr")
                      .h(30)
                      .px(10)
                      .flex()
                      .items_center()
                      .rounded(6)
                      .text_size(12)
                      .bg(t.raised)
                      .text_color(this.prBusy || this.syncing ? t.dim : t.foreground)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => cx.spawn(async (cx) => this.createPR(cx)))
                      .child(this.prBusy ?? "Create PR"),
                  ),
                )
                .child(
                  div()
                    .id("zed-commit")
                    .h(30)
                    .px(10)
                    .flex()
                    .items_center()
                    .rounded(6)
                    .text_size(12)
                    .bg(
                      this.message.trim() &&
                        this.files.some((file) => file.staged)
                        ? t.solid
                        : t.raised,
                    )
                    .text_color(
                      this.message.trim() &&
                        this.files.some((file) => file.staged)
                        ? t.solid_foreground
                        : t.dim,
                    )
                    .cursor_pointer()
                    .on_click((_e, cx) => this.commit(cx))
                    .child(this.busy ? "Committing…" : "Commit Tracked"),
                ),
            ),
        ),
      );
  }
}
