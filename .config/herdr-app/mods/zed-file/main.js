// A file shown as a tab: read-only, with syntax highlighting and line numbers. Opened by
// `tab.new {mod: "zed-file", props: {file, on}}` from the Files panel. Editing is left to a code
// editor (the header button opens the file in one). It re-reads the file when its folder changes
// (agents edit files under you).

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import {
  props,
  run,
  exec,
  openOverlay,
  window,
  setShared,
  readTextFile,
  watchFolder,
  shared,
  theme,
  settings,
  home,
} from "herdr";
import {
  languageFor,
  prepare,
  shortPath,
  detectScript,
  parseFound,
  launchArgs,
  editorIcon,
  preferredEditor,
} from "./file.js";

export default class ZedFile extends View {
  init(_given, cx) {
    const p = props() ?? {};
    if (p.menu) {
      this.menu = p;
      return;
    } // the "Open in" popup: this same mod draws it
    this.file = p.file ?? null;
    this.on = p.on ?? null;
    this.icon = p.icon ?? null; // worked out by the Files panel: mods cannot import each other
    this.state = { kind: "loading", text: "" };
    this.code = null;
    this.wrap = Boolean(shared("zed-file.options")?.wrap); // the global default; the header toggle overrides it per tab
    this.alive = true;
    this.detect(cx);
    if (!this.file) {
      this.state = { kind: "missing", text: "" };
      return;
    }
    this.load(cx);
    cx.spawn(async (cx) => {
      const dir = this.file.slice(0, Math.max(this.file.lastIndexOf("/"), 1));
      try {
        while (this.alive) {
          await watchFolder(dir);
          if (this.alive) await this.load(cx);
        }
      } catch {
        /* no watcher: the file stays as read */
      }
    });
  }

  // Looks for installed editors once per session; the result is shared by every file tab.
  async detect(cx) {
    if (shared("zed-file.editors") || window()?.platform === "windows") return;
    setShared("zed-file.editors", []); // claim it, so tabs opened meanwhile do not repeat the search
    try {
      const r = await exec("sh", ["-c", detectScript()]);
      setShared("zed-file.editors", parseFound(r.stdout));
    } catch {
      /* no sh: the button stays hidden */
    }
    cx.notify();
  }

  openMenu() {
    const editors = shared("zed-file.editors") ?? [];
    openOverlay({
      mod: "zed-file",
      kind: "popup",
      width: 240,
      height: 12 + 30 + editors.length * 38,
      props: { menu: true, file: this.file, editors },
    });
  }

  // An editor's icon, or a letter tile when Material Icon Theme has none.
  glyph(e, t, size = 16) {
    const icon = editorIcon(e.cmd, Boolean(settings().dark));
    return icon
      ? image(icon).size(size).flex_none()
      : div()
          .size(size)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(4)
          .bg(t.selected)
          .text_size(size * 0.6)
          .font_semibold()
          .text_color(t.muted)
          .child(e.label[0]);
  }

  // The popup, styled like Herdr's own menus: a dim heading, then one row per installed editor
  // with its icon (a letter tile when Material Icon Theme has none).
  renderMenu() {
    const t = theme(),
      { file, editors } = this.menu;
    const row = (e) => {
      return h_flex()
        .id(`open-${e.cmd}`)
        .h(38)
        .px(10)
        .gap(10)
        .items_center()
        .rounded(8)
        .cursor_pointer()
        .text_size(13)
        .text_color(t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click(() => {
          exec("sh", launchArgs(e.cmd, file)).catch(() => {});
          run("overlay.close");
        })
        .child(this.glyph(e, t, 20))
        .child(div().flex_1().min_w(0).truncate().child(e.label));
    };
    return v_flex()
      .id("zed-open-in")
      .w_full()
      .p(6)
      .bg(t.popover)
      .child(
        div()
          .px(10)
          .pt(6)
          .pb(4)
          .text_size(11.5)
          .text_color(t.dim)
          .child("Open in"),
      )
      .children(editors.map(row));
  }

  async load(cx) {
    let text = null;
    try {
      text = await readTextFile(this.file, { on: this.on });
    } catch {
      text = null;
    }
    this.state = prepare(text);
    if (this.state.kind === "ok") {
      if (this.code) this.code.set_value(this.state.text);
      else this.build(this.state.text);
    }
    cx.notify();
  }

  build(value) {
    const t = theme();
    this.code = EditorState.new({
      language: languageFor(this.file),
      readonly: true,
      value,
      soft_wrap: this.wrap,
      font_family: settings().font_family,
      font_size: 13,
      syntax: {
        keyword: t.ansi5,
        string: t.ansi2,
        comment: t.dim,
        function: t.ansi4,
        type: t.ansi3,
        number: t.ansi1,
        constant: t.ansi6,
      },
    });
  }

  // soft_wrap is fixed when the editor is created, so toggling rebuilds it around the same text.
  toggleWrap(cx) {
    if (!this.code) return;
    const text = this.code.value();
    this.code.release();
    this.wrap = !this.wrap;
    this.build(text);
    cx.notify();
  }

  async close() {
    this.alive = false;
    this.code?.release();
    this.code = null;
  }

  message(text, t) {
    return div()
      .flex_1()
      .flex()
      .items_center()
      .justify_center()
      .text_color(t.dim)
      .child(text);
  }

  render() {
    if (this.menu) return this.renderMenu();
    const t = theme(),
      s = this.state;
    const body =
      s.kind === "ok" && this.code
        ? Editor.new(this.code).flex_1().min_h(0)
        : s.kind === "binary"
          ? this.message("Binary file · no text view", t)
          : s.kind === "missing"
            ? this.message("This file is not available", t)
            : this.message("Loading…", t);
    return v_flex()
      .id("zed-file")
      .key_context("ZedFile")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.keystroke === "alt-z") {
          cx.stop_propagation();
          this.toggleWrap(cx);
        }
      })
      .child(
        h_flex()
          .h(28)
          .px(12)
          .gap(8)
          .flex_none()
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .text_size(12)
          .child(this.icon ? image(this.icon).size(14).flex_none() : div())
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_color(t.muted)
              .child(this.file ? shortPath(this.file, home()) : ""),
          )
          .when(s.truncated, (el) =>
            el.child(div().text_color(t.blocked).child("truncated")),
          )
          .when(
            this.state.kind === "ok" &&
              !this.on &&
              this.file &&
              (shared("zed-file.editors") ?? []).length > 0,
            (el) => {
              const editors = shared("zed-file.editors"),
                main = preferredEditor(
                  editors,
                  shared("zed-file.options")?.editor,
                );
              return el.child(
                h_flex()
                  .id("open-in")
                  .flex_none()
                  .items_center()
                  .text_color(t.dim)
                  .child(
                    div()
                      .id("open-main")
                      .p(2)
                      .rounded(4)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .tooltip(`Open in ${main.label}`)
                      .on_click(() =>
                        exec("sh", launchArgs(main.cmd, this.file)).catch(
                          () => {},
                        ),
                      )
                      .child(this.glyph(main, t, 22)),
                  )
                  .child(
                    div()
                      .id("open-menu")
                      .px(4)
                      .rounded(4)
                      .cursor_pointer()
                      .hover((s) => s.text_color(t.foreground))
                      .tooltip("Choose an editor")
                      .on_click(() => this.openMenu())
                      .child("▾"),
                  ),
              );
            },
          )
          .when(this.state.kind === "ok", (el) =>
            el.child(
              div()
                .id("wrap")
                .cursor_pointer()
                .text_color(this.wrap ? t.foreground : t.dim)
                .on_click((_e, cx) => this.toggleWrap(cx))
                .child("wrap"),
            ),
          )
          .child(div().text_color(t.dim).child("read only")),
      )
      .child(body);
  }
}
