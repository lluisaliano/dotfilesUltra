import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, knownAgents, run, props, closeOverlay } from "herdr";

export default class AgentLauncher extends View {
  init(_props, cx) {
    this.space = spaces().find((space) => space.active);
    this.agents = [];
    this.loading = true;
    this.selected = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: this.space?.machine });
      } catch {
        this.error = "Could not check agents. Close and try again.";
      }
      this.loading = false;
      cx.notify();
    });
  }

  choices() {
    return ["claude", "codex"].map((key) =>
      this.agents.find((agent) => agent.key === key),
    );
  }

  launch(index) {
    const agent = this.choices()[index];
    if (!agent?.installed) return;
    run("tab.new", {
      name: agent.name,
      space: this.space?.id,
      argv: agent.run,
    });
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    return v_flex()
      .id("agent-launcher")
      .track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.modifiers.alt || event.modifiers.platform) return;
        const control = Boolean(event.modifiers.control);
        const down = control
          ? event.key === "n"
          : ["down", "arrowdown"].includes(event.key);
        const up = control
          ? event.key === "p"
          : ["up", "arrowup"].includes(event.key);
        if (control && !down && !up) return;
        if (down) {
          this.selected = Math.min(
            this.selected + 1,
            this.choices().length - 1,
          );
          cx.notify();
        } else if (up) {
          this.selected = Math.max(this.selected - 1, 0);
          cx.notify();
        } else if (["enter", "return"].includes(event.key)) {
          this.launch(this.selected);
        } else if (event.key === "1" || event.key === "2") {
          this.launch(Number(event.key) - 1);
        } else return;
        cx.stop_propagation();
      })
      .size_full()
      .p(16)
      .gap(8)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .child(div().font_semibold().text_size(15).child("New agent tab"))
          .child(
            div().text_size(11).text_color(t.muted).child("Esc to cancel"),
          ),
      )
      .children(
        this.choices().map((agent, index) =>
          h_flex()
            .id(`agent-choice-${index}`)
            .h(44)
            .px(10)
            .gap(10)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .bg(index === this.selected ? t.selected : t.surface)
            .text_color(agent?.installed ? t.foreground : t.muted)
            .hover((style) => style.bg(t.hover))
            .on_click(() => this.launch(index))
            .child(
              svg(index === 0 ? "icons/claude.svg" : "icons/codex.svg").size(
                18,
              ),
            )
            .child(
              div()
                .flex_1()
                .child(index === 0 ? "Claude" : "Codex"),
            )
            .child(
              div()
                .text_size(11)
                .child(
                  this.loading
                    ? "Checking…"
                    : agent?.installed
                      ? `${index + 1}`
                      : "Not installed",
                ),
            ),
        ),
      )
      .child(
        div()
          .text_size(11)
          .text_color(t.muted)
          .child(
            this.error || "Ctrl+N / Ctrl+P or ↑ / ↓ · Enter to open · 1 / 2",
          ),
      );
  }
}
