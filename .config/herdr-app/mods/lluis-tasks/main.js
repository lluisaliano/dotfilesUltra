// Tasks for the selected space: named commands (Build, Format, ...) run in a terminal below
// the focused pane. Each space keeps its own list, empty at first, in shared state
// (`lluis-tasks`: { [spaceId]: [{ id, title, command }] }). Opened as a popup from the
// Tasks button in zed-tabs.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, spaces, focused, shared, setShared, run, props, openOverlay, closeOverlay } from "herdr";

const KEY = "lluis-tasks";
const ICON = "mods/workspace-chrome";

const space = () => spaces().find((s) => s.active);
const tasksOf = (id) => (shared(KEY) ?? {})[id] ?? [];
const ROW = 34, WIDTH = 340;
// The popup is a fixed size, so the list and the form each open it at their own height.
function reopen(edit) {
  const p = props() ?? {}, n = tasksOf(space()?.id).length;
  closeOverlay(p.overlay);
  openOverlay({
    mod: "lluis-tasks", kind: "popup", width: WIDTH,
    height: edit ? 44 + 196 : 86 + Math.max(1, n) * ROW,
    at: p.at ?? "pointer",
    props: { at: p.at, ...(edit ? { edit } : {}) },
  });
}
const saveTasks = (id, list) => setShared(KEY, { ...(shared(KEY) ?? {}), [id]: list });

// Runs the command in the space's folder; when it ends the shell stays, so the output can be read.
function runTask(task) {
  const s = space();
  const folder = focused()?.cwd ?? s?.folder;
  const script = 'printf "\\033[2m$ %s\\033[0m\\n" "$1"; eval "$1"; s=$?; printf "\\n\\033[2m[%s] exit %s\\033[0m\\n" "$0" "$s"; exec "${SHELL:-sh}"';
  run("terminal.open", { argv: ["sh", "-c", script, task.title, task.command], folder, place: "down", name: task.title });
}

export default class Tasks extends View {
  init(_props, cx) {
    this.editing = null; // null, "new", or a task id
    this.title = InputState.new({ placeholder: "Title (e.g. Build)" });
    this.command = InputState.new({ placeholder: "Command (e.g. npm run build)" });
    this.title.on("change", (_e, cx) => cx.notify());
    this.command.on("change", (_e, cx) => cx.notify());
    this.command.on("submit", (_e, cx) => this.save(cx));
    this.title.on("submit", (_e, cx) => { this.command.focus?.(); cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus();
    setShared("lluis-tasks.open", props()?.overlay ?? null);
    const edit = props()?.edit;
    if (edit) {
      const task = tasksOf(space()?.id).find((t) => t.id === edit);
      this.editing = task ? task.id : "new";
      this.title.set_value(task?.title ?? "");
      this.command.set_value(task?.command ?? "");
      this.title.focus?.();
    }
  }

  close() {
    // The Tasks button reads these to close the dropdown instead of reopening it.
    if (shared("lluis-tasks.open") === props()?.overlay) setShared("lluis-tasks.open", null);
    setShared("lluis-tasks.closedAt", Date.now());
    this.title?.release?.();
    this.command?.release?.();
  }

  edit(task) {
    reopen(task ? task.id : "new");
  }

  save(cx) {
    const s = space(), title = this.title.value().trim(), command = this.command.value().trim();
    if (!s || !title || !command) return;
    const list = tasksOf(s.id);
    saveTasks(s.id, this.editing === "new"
      ? [...list, { id: `t${Date.now().toString(36)}`, title, command }]
      : list.map((t) => (t.id === this.editing ? { ...t, title, command } : t)));
    reopen(null);
  }

  remove(task, cx) {
    const s = space();
    saveTasks(s.id, tasksOf(s.id).filter((t) => t.id !== task.id));
    reopen(null);
  }

  iconButton(id, icon, t, onClick) {
    return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(`${ICON}/${icon}.svg`).size(12));
  }

  button(id, label, t, onClick, primary = false, enabled = true) {
    return div().id(id).h(28).px(12).flex().flex_none().items_center().rounded(6).text_size(12.5)
      .when(enabled, (el) => el.cursor_pointer())
      .when(primary, (el) => el.bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { if (enabled) onClick(cx); })
      .child(label);
  }

  field(label, state, t, mono) {
    return v_flex().gap(4)
      .child(div().text_size(11).text_color(t.dim).child(label))
      .child(h_flex().h(30).px(8).items_center().rounded(6).bg(t.background).border_1().border_color(t.input)
        .child(Input.new(state).flex_1().h_full().text_size(12.5).text_color(t.foreground)
          .when(mono, (el) => el.font_family("JetBrains Mono"))));
  }

  form(t) {
    const ok = Boolean(this.title.value().trim() && this.command.value().trim());
    return v_flex().gap(10).px(6).pb(6)
      .child(div().text_size(12.5).font_semibold().child(this.editing === "new" ? "New task" : "Edit task"))
      .child(this.field("Title", this.title, t, false))
      .child(this.field("Command", this.command, t, true))
      .child(h_flex().gap(6).justify_end()
        .child(this.button("task-cancel", "Cancel", t, () => reopen(null)))
        .child(this.button("task-save", "Save", t, (cx) => this.save(cx), true, ok)));
  }

  render() {
    const t = theme(), s = space(), list = s ? tasksOf(s.id) : [];
    return v_flex().id("lluis-tasks").track_focus(this.handle).w_full().min_h(0).p(6).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.editing) reopen(null);
        else closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .child(h_flex().px(6).pt(4).pb(6).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`Tasks · ${s?.name ?? "no space"}`)))
      .when(Boolean(this.editing), (el) => el.child(this.form(t)))
      .when(list.length === 0 && !this.editing, (el) => el.child(
        div().px(8).py(8).text_size(12).text_color(t.dim).child("No tasks in this space yet.")))
      .children((this.editing ? [] : list).map((task) => h_flex().id(`task-${task.id}`).h(34).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .hover((st) => st.bg(t.selected))
        .tooltip(task.command)
        .on_click(() => { closeOverlay(props().overlay); runTask(task); })
        .child(svg("mods/linear/play.svg").size(10).flex_none().text_color(t.ansi2))
        .child(div().flex_1().min_w(0).truncate().child(task.title))
        .child(this.iconButton(`task-edit-${task.id}`, "square-pen", t, () => this.edit(task)))
        .child(this.iconButton(`task-remove-${task.id}`, "x", t, (cx) => this.remove(task, cx)))))
      .when(!this.editing && Boolean(s), (el) => el
        .child(div().h(1).mx(4).my(5).bg(t.border))
        .child(h_flex().id("task-new").h(32).px(8).gap(8).items_center().rounded(7).cursor_pointer().text_color(t.muted)
          .hover((st) => st.bg(t.selected).text_color(t.foreground))
          .on_click(() => this.edit(null))
          .child(svg(`${ICON}/plus.svg`).size(12))
          .child("Define task")));
  }
}
