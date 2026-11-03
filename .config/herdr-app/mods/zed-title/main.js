import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, spaces, agents, focused, layout } from "herdr";

// Clawd (Claude Code's mascot, from its terminal block art), hopping along the empty part of the bar: the outer box wanders left and right,
// the inner one jumps. Both loops run natively (no timers, no re-renders).
// GIF companions. GPUI draws GIFs still, so each one's frames are PNGs in
// mods/zed-title/<name>/0..n.png, swapped by the View's 100 ms tick using the
// GIF's own frame durations (multiples of 100 ms).
const SPRITES = {
  hammer: Array(30).fill(100),
  music: [100, 200, 200, 200, 200, 200, 200, 200, 200],
};
const SPRITE_TABLES = Object.fromEntries(
  Object.entries(SPRITES).map(([name, durs]) => [
    name,
    durs.flatMap((ms, i) => Array(ms / 100).fill(i)), // tick -> frame
  ]),
);
function spriteFrame(name, tick) {
  const table = SPRITE_TABLES[name];
  return table[tick % table.length];
}

function clawd(tick = 0) {
  const W = 34, H = 20, TRACK = 140; // 17×5 pixels, each twice as tall as wide, as a terminal draws Clawd
  return div()
    .flex_1()
    .min_w(0)
    .h_full()
    .relative()
    .overflow_hidden()
    .child(
      div()
        .absolute()
        .top(0)
        .w(W)
        .h_full()
        .loop("left", { from: 16, to: 16 + TRACK, period: 9000, easing: "linear" })
        .child(
          image("mods/zed-title/clawd-tall.svg")
            .absolute()
            .w(W)
            .h(H)
            .loop("top", { from: 11, to: 2, period: 520, easing: "ease-out" }),
        ),
    )
    // The hammer creature, parked just right of Clawd's track.
    .child(
      image(`mods/zed-title/hammer/${spriteFrame("hammer", tick)}.png`)
        .absolute()
        .left(16 + TRACK + W + 12)
        .top(3)
        .w(37)
        .h(25),
    )
    // The music creature (headphones), right of the hammer.
    .child(
      image(`mods/zed-title/music/${spriteFrame("music", tick)}.png`)
        .absolute()
        .left(16 + TRACK + W + 12 + 37 + 8)
        .top(5)
        .w(26)
        .h(22),
    );
}

export default class ZedTitle extends View {
  init(_props, cx) {
    this.tick = 0;
    cx.timer.every(100, (cx) => {
      this.tick = (this.tick + 1) % 100000;
      cx.notify();
    });
  }

  button(id, glyph, action, hover) {
    const t = theme();
    return div()
      .id(id)
      .size(22)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .text_color(t.muted)
      .hover((s) =>
        hover ? hover(s, t) : s.bg(t.hover).text_color(t.foreground),
      )
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(glyph);
  }

  render() {
    const t = theme();
    const w = window();
    const space = spaces().find((s) => s.active);
    const focus = focused();
    const tab =
      space?.tabs?.find((c) => c.id === focus?.tab) ??
      space?.tabs?.find((c) => c.active);
    const agent =
      agents().find((a) => a.focused) ??
      (focus?.agent ? agents().find((a) => a.address === focus.agent) : null);
    const crumbs = [];
    if (space?.name) crumbs.push({ text: space.name, color: t.foreground });
    if (space?.branch)
      crumbs.push({ text: space.branch, color: t.muted, icon: "branch" });
    const who =
      agent?.program?.name ||
      (tab && !/^tb\d+$/.test(tab.name) ? tab.name : null);
    if (who) crumbs.push({ text: who, color: t.muted });

    const macos =
      w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen;
    const lights = layout()?.traffic_lights;
    const pad = macos && lights ? Math.max(8, lights[0] + 64) : 8;
    const parts = [];
    if (crumbs.length === 0) {
      parts.push(div().text_color(t.muted).child("Zed"));
    } else {
      crumbs.forEach((c, i) => {
        if (i) parts.push(div().text_color(t.dim).child("·"));
        const bit = h_flex().gap(4).items_center().min_w(0);
        if (c.icon)
          bit.child(
            svg(`mods/workspace-chrome/${c.icon}.svg`)
              .size(12)
              .text_color(c.color),
          );
        bit.child(
          div().truncate().max_w(240).text_color(c.color).child(c.text),
        );
        parts.push(bit);
      });
    }

    return h_flex()
      .size_full()
      .items_center()
      .gap(8)
      .pr(6)
      .pl(pad)
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .child(
        this.button(
          "zed-sidebar",
          svg("mods/workspace-chrome/sidebar.svg").size(14),
          () => run("layout.toggle", { id: "sidebar" }),
        ),
      )
      .child(h_flex().flex_none().min_w(0).gap(8).items_center().children(parts))
      .child(clawd(this.tick))
      // The window buttons, top right, where the system would draw none (Windows, Linux).
      .when(Boolean(w?.buttons), (el) => {
        const win = w.platform === "windows";
        const box = (id, glyph, action, danger) =>
          div()
            .id(id)
            .w(40)
            .h_full()
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .text_color(t.muted)
            .hover((s) =>
              danger
                ? s.bg("#c42b1c").text_color("#ffffff")
                : s.bg(t.hover).text_color(t.foreground),
            )
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click(() => run(action))
            .child(glyph);
        return el.child(
          h_flex()
            .h_full()
            .flex_none()
            .mr(-6)
            .child(box("win-min", win ? svg("mods/zed-tabs/win-min.svg").size(16) : "−", "window.minimize"))
            .child(
              box(
                "win-max",
                win
                  ? svg(`mods/zed-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16)
                  : "□",
                "window.maximize",
              ),
            )
            .child(
              box(
                "win-close",
                win ? svg("mods/zed-tabs/win-close.svg").size(16) : "✕",
                "window.close",
                true,
              ),
            ),
        );
      });
  }
}
