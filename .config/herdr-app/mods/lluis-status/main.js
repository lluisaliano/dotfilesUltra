import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  spaces,
  agents,
  theme,
  run,
  window,
  keys,
  props,
  exec,
  nextCommand,
  focused,
  appHome,
} from "herdr";
import { quietAction, runQuiet } from "./quiet.js";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    // Only one footer copy listens: summary in the composed footer, or the
    // complete footer in older personal layouts. Commands/spacers stay passive.
    if (props()?.role && props().role !== "summary") return;
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (
          ["resize_left", "resize_right", "resize_up", "resize_down"].includes(
            command,
          )
        ) {
          const focus = focused();
          if (!focus?.pane) continue;
          const machine =
            spaces().find((space) => space.id === focus.space)?.machine ?? "";
          try {
            await exec("python3", [
              `${appHome()}/tools/resize-pane.py`,
              command.slice(7),
              focus.pane,
              focus.tab,
              machine,
            ]);
          } catch {
            /* Resizing without an available split is a quiet no-op. */
          }
          continue;
        }
        if (["panel_graph", "panel_linear"].includes(command)) {
          const child = command.slice(6);
          try {
            await exec("herdr-app", [
              "do",
              "layout.select",
              JSON.stringify({ stack: "panel-body", child }),
            ]);
            await exec("herdr-app", [
              "do",
              "layout.show",
              JSON.stringify({ id: "panel" }),
            ]);
          } catch {
            /* No shortcut notification if this layout lacks these panels. */
          }
          continue;
        }
        const action = quietAction(command, keys());
        if (action) await runQuiet(exec, action);
      }
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = {
      cmd: mac ? "⌘" : "Ctrl+",
      ctrl: mac ? "⌃" : "Ctrl+",
      shift: mac ? "⇧" : "Shift+",
      alt: mac ? "⌥" : "Alt+",
      option: mac ? "⌥" : "Alt+",
    };
    const matches = keys().filter(
      (k) => k.section === "global" && k.action === "mod.open:lluis-palette",
    );
    const b = matches.find((k) => k.keys.startsWith("alt-")) ?? matches[0];
    const parts =
      b && b.keys.endsWith("--")
        ? [...b.keys.slice(0, -2).split("-"), "-"]
        : b?.keys.split("-");
    const key =
      parts &&
      parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    if (props()?.role === "spacer") return div().size_full().bg(t.chrome);
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) =>
      h_flex()
        .gap(6)
        .items_center()
        .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
        .child(text);
    const command = () =>
      div()
        .id("palette")
        .text_color(t.dim)
        .on_click(() => run("mod.open", { name: "lluis-palette" }))
        .child(this.hint());
    if (props()?.role === "commands")
      return h_flex()
        .size_full()
        .px(14)
        .items_center()
        .justify_end()
        .bg(t.chrome)
        .text_size(11.8)
        .child(command());
    const root = h_flex()
      .size_full()
      .px(14)
      .gap(16)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(
        label(
          space?.machine ? "server" : "monitor",
          space?.machine ?? "This computer",
        ),
      )
      .when(props()?.role !== "summary" && Boolean(space?.branch), (el) =>
        el.child(label("branch", space.branch)),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).bg(t.dim))
          .child(`${list.length} agent${list.length === 1 ? "" : "s"}`)
          .when(needs > 0, (el) =>
            el.child(div().text_color(t.blocked).child(`· ${needs} needs you`)),
          ),
      );
    if (props()?.role === "summary") return root;
    return root.child(div().flex_1()).child(command());
  }
}
