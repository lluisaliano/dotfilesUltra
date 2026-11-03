import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  spaces,
  panes,
  run,
  openOverlay,
  closeOverlay,
  theme,
  window,
  shared,
  layout,
  settings,
  props,
  nextCommand,
} from "herdr";
import { openInZed } from "./zed.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // keys.json: "alt-e": "zed-tabs.open_zed" does what the Zed button does.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "open_zed") this.openZed(cx);
      }
    });
  }

  openZed(cx) {
    const space = spaces().find((p) => p.active);
    if (this.zedOpening || !space) return;
    this.zedOpening = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await openInZed(space);
      this.zedOpening = false;
      cx.notify();
    });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : (body?.active ?? null);
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null,
          want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) {
            run("layout.select", { stack: "panel-body", child: want });
            run("layout.show", { id: "panel" });
          } else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find((p) => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) =>
      div()
        .id(id)
        .size(26)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click(action)
        .child(label);
    const item = (c, i) => {
      const program =
        panes().find((p) => p.tab === c.id && p.program?.agent)?.program ??
        panes().find((p) => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name)
        ? (program?.name ?? "Terminal")
        : c.name;
      return h_flex()
        .id(`tab-${c.id}`)
        .h(29)
        .px(10)
        .gap(7)
        .rounded(7)
        .items_center()
        .flex_none()
        .text_size(12.8)
        .border(1)
        .border_color(c.active ? t.border : t.chrome)
        .bg(c.active ? t.raised : t.chrome)
        .text_color(c.active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = i;
          if (e.click_count === 2) run("tab.rename", { id: c.id });
        })
        .on_mouse_up("left", () => {
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== i)
            run("tab.move", {
              id: shown[from].id,
              index: space.tabs.findIndex((x) => x.id === c.id) + 1,
            });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({
            mod: "menu",
            kind: "popup",
            width: 200,
            props: { tab: "tab", target: { id: c.id, space: space.id } },
          });
        })
        .when(Boolean(program?.icon), (el) =>
          el.child(
            program.tint
              ? svg(program.icon).size(14).text_color(t.muted)
              : image(program.icon).size(14),
          ),
        )
        .child(
          div()
            .max_w(170)
            .truncate()
            .child(c.zoomed ? `${name} Z` : name),
        )
        .when(c.status === "working", (el) =>
          el.child(
            svg("mods/workspace-chrome/spinner.svg")
              .size(12)
              .flex_none()
              .text_color(t.working)
              .spin(900),
          ),
        )
        .when(c.status === "blocked" || c.status === "done", (el) =>
          el.child(div().size(6).rounded(3).bg(t[c.status])),
        )
        .when(c.active, (el) =>
          el.child(
            div()
              .id(`close-${c.id}`)
              .text_color(t.dim)
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                run("tab.close", { id: c.id });
              })
              .child(svg("mods/pane/close.svg").size(12)),
          ),
        );
    };
    const root = layout(),
      sidebar = find(root, "sidebar"),
      w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding =
      w?.platform === "macos" &&
      w.titlebar === "none" &&
      !w.fullscreen &&
      root?.traffic_lights
        ? Math.max(
            10,
            (root.traffic_lights[0] + 64) / settings().zoom -
              (sidebar?.hidden ? 0 : (sidebar?.size?.px ?? 0)),
          )
        : 10;
    const panel = find(root, "panel"),
      body = find(root, "panel-body");
    // Buttons turned off in Settings > Toolbar (lluis-settings).
    const hidden = new Set(shared("zed-tabs.hidden") ?? []);
    const enabled = [
      ...(shared("workspace.panels") ?? ["files", "changes"]),
      "graph",
      "linear",
      "pr-review-assist",
    ].filter((id) => !hidden.has(id));
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex()
        .id(`panel-${id}`)
        .h(26)
        .px(8)
        .gap(5)
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .bg(on ? t.selected : t.chrome)
        .text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else {
            run("layout.select", { stack: "panel-body", child: id });
            run("layout.show", { id: "panel" });
          }
        })
        .child(svg(icon).size(14))
        .child(label);
    };
    // Looks like a panel button, but opens the space in Zed (see zed.js) instead of a panel.
    const zedButton = () =>
      h_flex()
        .id("open-zed")
        .h(26)
        .px(8)
        .gap(5)
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .bg(t.chrome)
        .text_color(this.zedOpening ? t.dim : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => this.openZed(cx))
        .child(svg("mods/zed-tabs/zed-logo.svg").size(14))
        .child(this.zedOpening ? "Opening…" : "Zed");
    return h_flex()
      .size_full()
      .min_w(0)
      .px(10)
      .pl(lightsPadding)
      .gap(3)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .on_mouse_up("left", () => {
        this.pressed = null;
      })
      .on_scroll_wheel((e) => {
        if (Math.abs(e.delta.y) >= 1)
          run(e.delta.y > 0 ? "tab.prev" : "tab.next");
      })
      .child(
        h_flex()
          .id("tab-scroll")
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .gap(3)
          .overflow_x_scrollbar()
          .children(shown.map(item))
          .child(
            button("tab-new", "+", () =>
              openOverlay({
                mod: "herdr-open-with-zed",
                kind: "popup",
                width: 250,
                height: 543,
              }),
            ),
          ),
      )
      .when(!hidden.has("tasks"), (el) => el.child(
        h_flex()
          .id("open-tasks")
          .h(26)
          .px(8)
          .gap(5)
          .flex_none()
          .items_center()
          .rounded(6)
          .text_size(12)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover))
          // A dropdown under the button, its right edge on the button's.
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            // A second press closes it. The press outside may have closed it a moment ago.
            const open = shared("lluis-tasks.open");
            if (open) return closeOverlay(open);
            if (Date.now() - (shared("lluis-tasks.closedAt") ?? 0) < 400) return;
            const b = e.bounds;
            const at = b
              ? { x: Math.max(8, b.x + b.width - 340), y: b.y + b.height + 6 }
              : "pointer";
            const n = (shared("lluis-tasks") ?? {})[space?.id]?.length ?? 0;
            openOverlay({
              mod: "lluis-tasks",
              kind: "popup",
              width: 340,
              height: 86 + Math.max(1, n) * 34,
              at,
              props: { at },
            });
          })
          .child(svg("mods/linear/play.svg").size(11))
          .child("Tasks"),
      ))
      .when(!hidden.has("zed"), (el) => el.child(zedButton()))
      .when(enabled.includes("files"), (el) =>
        el.child(panelButton("files", "Files", "mods/files/file.svg")),
      )
      .when(enabled.includes("changes"), (el) =>
        el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")),
      )
      .when(enabled.includes("graph"), (el) =>
        el.child(panelButton("graph", "Graph", "mods/git-graph/icons/graph.svg")),
      )
      .when(enabled.includes("pr-review-assist"), (el) =>
        el.child(panelButton("pr-review-assist", "View PRs", "mods/pr-review-assist/pr.svg")),
      )
      .when(enabled.includes("linear"), (el) =>
        el.child(panelButton("linear", "Linear", "mods/linear/linear.svg")),
      )
      .when(w?.buttons && !props()?.hideWindowButtons, (el) =>
        el
          .child(
            button(
              "minimize",
              w.platform === "windows"
                ? svg("mods/zed-tabs/win-min.svg").size(16)
                : "−",
              () => run("window.minimize"),
            ),
          )
          .child(
            button(
              "maximize",
              w.platform === "windows"
                ? svg(
                    `mods/zed-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`,
                  ).size(16)
                : "□",
              () => run("window.maximize"),
            ),
          )
          .child(
            button(
              "close-window",
              w.platform === "windows"
                ? svg("mods/zed-tabs/win-close.svg").size(16)
                : svg("mods/pane/close.svg").size(13),
              () => run("window.close"),
            ),
          ),
      );
  }
}
