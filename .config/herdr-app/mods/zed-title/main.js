import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, spaces, agents, focused, layout } from "herdr";

// Two companions in the empty part of the bar: the music creature (headphones)
// dancing, and Savage Codex Hacker (petdex.dev, its "idle" row) typing.
// GPUI draws GIFs still, so their frames are PNGs in mods/zed-title/<name>/0..n.png,
// swapped by the View's 100 ms tick using each frame's duration
// (multiples of 100 ms).
const SPRITES = {
  music: [100, 200, 200, 200, 200, 200, 200, 200, 200],
  codex: [1200, 100, 200, 500, 100, 300],
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

function companion(tick = 0) {
  return div()
    .flex_1()
    .min_w(0)
    .h_full()
    .relative()
    .overflow_hidden()
    .child(
      image(`mods/zed-title/music/${spriteFrame("music", tick)}.png`)
        .absolute()
        .left(16)
        .top(5)
        .w(26)
        .h(22),
    )
    .child(
      image(`mods/zed-title/codex/${spriteFrame("codex", tick)}.png`)
        .absolute()
        .left(16 + 26 + 8)
        .top(4)
        .w(22)
        .h(24),
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
      .child(companion(this.tick));
  }
}
