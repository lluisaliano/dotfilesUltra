// Layout settings window, laid out like Zed's: search and categories on the left, the selected
// category's settings on the right (label, description, switch). Opened with
// `mod.open {name: "zed-settings"}`. It writes the same shared keys the other mods read:
// Only `zed-quota.options` is shown here; file/editor settings are intentionally excluded.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, shared, setShared, spaces } from "herdr";
import {
  quotaOptions,
  CATEGORIES as ALL_CATEGORIES,
  staticItems,
  providerItems,
  visible,
} from "./options.js";

const quota = () =>
  quotaOptions(shared("zed-quota.start"), shared("zed-quota.options"));
const CATEGORIES = ALL_CATEGORIES.filter(
  (category) => category.id !== "editor",
);
const write = {
  quota: (change) => setShared("zed-quota.options", { ...quota(), ...change }),
};
const read = { quota };
// The quota bar publishes its providers under a key that names the machine it reads.
const providers = () =>
  shared(
    `zed-quota.data:${JSON.stringify(spaces().find((s) => s.active)?.machine ?? null)}`,
  )?.providers ?? [];

export default class ZedSettings extends View {
  init(_given) {
    this.category = CATEGORIES[0].id;
    this.search = InputState.new({ placeholder: "Search settings..." });
    this.search.on("change", (_e, cx2) => cx2.notify());
  }

  close() {
    this.search?.release();
    this.search = null;
  }

  switch(on) {
    const t = theme();
    return h_flex()
      .w(34)
      .h(20)
      .flex_none()
      .px(2)
      .items_center()
      .rounded_full()
      .when(on, (el) => el.justify_end())
      .bg(on ? t.accent : t.raised)
      .border(1)
      .border_color(on ? t.accent : t.border)
      .child(
        div()
          .size(14)
          .rounded_full()
          .bg(on ? t.solid_foreground : t.muted),
      );
  }

  // A choice among a few values: a row of chips under the text.
  choiceRow(item, last, t) {
    const value = item.get(read[item.store]());
    return v_flex()
      .id(`row-${item.id}`)
      .gap(10)
      .py(14)
      .when(!last, (el) => el.border_b(1).border_color(t.border))
      .child(
        v_flex()
          .gap(3)
          .child(div().text_size(13).text_color(t.foreground).child(item.label))
          .child(
            div().text_size(11.5).text_color(t.dim).child(item.description),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .children(
            item.options.map((option) =>
              div()
                .id(`${item.id}-${option}`)
                .h(28)
                .px(12)
                .flex()
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .text_size(12.5)
                .border(1)
                .border_color(option === value ? t.accent : t.border)
                .bg(option === value ? t.selected : t.background)
                .text_color(option === value ? t.foreground : t.muted)
                .hover((s) => s.bg(t.hover))
                .on_click(() =>
                  write[item.store](item.patch(read[item.store](), option)),
                )
                .child(option),
            ),
          ),
      );
  }

  row(item, last, t) {
    if (item.kind === "choice") return this.choiceRow(item, last, t);
    const on = Boolean(item.get(read[item.store]()));
    return h_flex()
      .id(`row-${item.id}`)
      .gap(24)
      .py(14)
      .items_center()
      .cursor_pointer()
      .when(!last, (el) => el.border_b(1).border_color(t.border))
      .on_click(() => write[item.store](item.patch(read[item.store](), !on)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(3)
          .child(div().text_size(13).text_color(t.foreground).child(item.label))
          .child(
            div().text_size(11.5).text_color(t.dim).child(item.description),
          ),
      )
      .child(this.switch(on));
  }

  render() {
    const t = theme(),
      query = this.search?.value() ?? "";
    const all = [
      ...staticItems().filter((item) => item.store === "quota"),
      ...providerItems(providers()),
    ].filter(Boolean);
    const items = visible(all, this.category, query);
    const title = query.trim()
      ? `Results for “${query.trim()}”`
      : CATEGORIES.find((c) => c.id === this.category)?.label;
    return h_flex()
      .id("zed-settings")
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        v_flex()
          .w(210)
          .flex_none()
          .h_full()
          .gap(6)
          .p(10)
          .bg(t.chrome)
          .border_r(1)
          .border_color(t.border)
          .child(
            div()
              .h(32)
              .px(8)
              .flex()
              .items_center()
              .rounded(6)
              .border(1)
              .border_color(t.border)
              .bg(t.background)
              .child(
                Input.new(this.search)
                  .size_full()
                  .text_size(12.5)
                  .text_color(t.foreground),
              ),
          )
          .child(
            v_flex()
              .gap(2)
              .pt(4)
              .children(
                CATEGORIES.map((c) =>
                  div()
                    .id(`cat-${c.id}`)
                    .h(30)
                    .px(10)
                    .flex()
                    .items_center()
                    .rounded(6)
                    .cursor_pointer()
                    .bg(
                      !query.trim() && this.category === c.id
                        ? t.selected
                        : t.chrome,
                    )
                    .text_color(
                      !query.trim() && this.category === c.id
                        ? t.foreground
                        : t.muted,
                    )
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => {
                      this.category = c.id;
                      this.search.set_value("");
                      cx.notify();
                    })
                    .child(c.label),
                ),
              ),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .h_full()
          .min_h(0)
          .overflow_y_scrollbar()
          .px(32)
          .py(24)
          .child(div().text_size(18).font_semibold().pb(8).child(title))
          .children(
            items.map((item, i) => this.row(item, i === items.length - 1, t)),
          )
          .when(items.length === 0, (el) =>
            el.child(
              div()
                .py(16)
                .text_color(t.dim)
                .child(
                  query.trim()
                    ? "No settings match your search."
                    : "Nothing to show here.",
                ),
            ),
          ),
      );
  }
}
