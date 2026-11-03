import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { theme, exec } from "herdr";
import {
  validRepo,
  repoArgs,
  issueArgs,
  parseResult,
  filterRepos,
} from "./data.js";

export default class GitHubIssues extends View {
  init(_props, cx) {
    this.repo = localStorage.getItem("repository") || "";
    this.choosing = !validRepo(this.repo);
    this.repos = [];
    this.issues = [];
    this.page = 0;
    this.request = 0;
    this.filter = "";
    this.input = InputState.new({
      placeholder: "Filter or enter owner/repository",
    });
    this.input.on("change", (_event, cx) => {
      this.filter = this.input.value();
      cx.notify();
    });
    this.input.on("submit", (_event, cx) => {
      const value = this.filter.trim();
      if (validRepo(value)) this.selectRepo(value, cx);
      else {
        const matches = filterRepos(this.repos, value);
        if (matches.length === 1) this.selectRepo(matches[0].full_name, cx);
      }
    });
    if (this.choosing) this.loadRepos(cx);
    else this.refresh(cx);
    cx.timer.every(120000, (cx) => {
      if (!this.choosing) this.refresh(cx);
    });
  }

  loadRepos(cx, more = false) {
    if (this.loadingRepos) return;
    this.loadingRepos = true;
    this.repoError = "";
    const page = more ? this.page + 1 : 1;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const repos = parseResult(await exec("gh", repoArgs(page)));
        this.repos = more ? [...this.repos, ...repos] : repos;
        this.page = page;
        this.more = repos.length === 100;
      } catch (error) {
        this.repoError = String(error.message || error);
      }
      this.loadingRepos = false;
      cx.notify();
    });
  }

  selectRepo(repo, cx) {
    if (!validRepo(repo)) return;
    this.repo = repo;
    localStorage.setItem("repository", repo);
    this.choosing = false;
    this.issues = [];
    this.refresh(cx);
  }

  refresh(cx) {
    if (!validRepo(this.repo)) return;
    const request = ++this.request;
    const repo = this.repo;
    this.loading = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const issues = parseResult(await exec("gh", issueArgs(repo)));
        if (request !== this.request) return;
        this.issues = issues;
        this.updated = new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
      } catch (error) {
        if (request !== this.request) return;
        this.error = String(error.message || error);
      }
      this.loading = false;
      cx.notify();
    });
  }

  button(id, text, action) {
    const t = theme();
    return div()
      .id(id)
      .px(9)
      .py(6)
      .rounded(6)
      .text_size(11.5)
      .bg(t.raised)
      .text_color(t.foreground)
      .cursor_pointer()
      .hover((style) => style.bg(t.hover))
      .on_click(action)
      .child(text);
  }

  render() {
    const t = theme();
    const message = (text) =>
      div().p(12).text_size(12).text_color(t.muted).child(text);
    const root = v_flex()
      .id("github-issues")
      .size_full()
      .min_h(0)
      .rounded(10)
      .bg(t.surface)
      .text_color(t.foreground)
      .text_size(12.5)
      .child(
        h_flex()
          .px(12)
          .py(12)
          .gap(8)
          .items_center()
          .child(div().flex_1().font_semibold().child("GitHub Issues"))
          .child(
            this.button(
              "github-repos",
              this.choosing ? "Reload" : "Change repo",
              (_event, cx) => {
                this.choosing = true;
                this.loadRepos(cx);
                this.input.focus();
                cx.notify();
              },
            ),
          ),
      );

    if (this.choosing) {
      const matches = filterRepos(this.repos, this.filter);
      return root
        .child(
          div()
            .px(12)
            .pb(8)
            .text_color(t.muted)
            .text_size(11.5)
            .child("Choose a repository to see its open issues."),
        )
        .child(
          Input.new(this.input)
            .mx(12)
            .mb(8)
            .h(34)
            .px(9)
            .rounded(6)
            .border_1()
            .border_color(t.input)
            .bg(t.background)
            .text_color(t.foreground),
        )
        .when(validRepo(this.filter.trim()), (el) =>
          el.child(
            div()
              .px(12)
              .pb(8)
              .child(
                this.button(
                  "github-direct",
                  `Open ${this.filter.trim()}`,
                  (_event, cx) => this.selectRepo(this.filter.trim(), cx),
                ),
              ),
          ),
        )
        .when(Boolean(this.repoError), (el) =>
          el.child(message(`${this.repoError} Use Reload to retry.`)),
        )
        .child(
          v_flex()
            .id("repository-list")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .children(
              matches.map((repo) =>
                h_flex()
                  .id(`repo-${repo.id}`)
                  .px(12)
                  .py(9)
                  .gap(8)
                  .cursor_pointer()
                  .hover((style) => style.bg(t.hover))
                  .on_click((_event, cx) => this.selectRepo(repo.full_name, cx))
                  .child(
                    div().flex_1().min_w(0).truncate().child(repo.full_name),
                  )
                  .child(
                    div()
                      .text_size(10)
                      .text_color(t.muted)
                      .child(repo.private ? "Private" : "Public"),
                  ),
              ),
            )
            .when(this.loadingRepos, (el) =>
              el.child(message("Loading repositories…")),
            )
            .when(
              !this.loadingRepos && matches.length === 0 && !this.repoError,
              (el) =>
                el.child(message("No matches. Enter owner/repository above.")),
            ),
        )
        .child(
          h_flex()
            .px(12)
            .py(10)
            .gap(8)
            .when(Boolean(this.more), (el) =>
              el.child(
                this.button("github-more", "Load more", (_event, cx) =>
                  this.loadRepos(cx, true),
                ),
              ),
            )
            .when(validRepo(this.repo), (el) =>
              el.child(
                this.button("github-back", "Back to issues", (_event, cx) => {
                  this.choosing = false;
                  cx.notify();
                }),
              ),
            ),
        );
    }

    return root
      .child(
        h_flex()
          .px(12)
          .pb(10)
          .gap(8)
          .items_center()
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_color(t.muted)
              .child(this.repo),
          )
          .child(
            this.button(
              "github-refresh",
              this.loading ? "Loading…" : "Refresh",
              (_event, cx) => {
                if (!this.loading) this.refresh(cx);
              },
            ),
          ),
      )
      .when(Boolean(this.error), (el) =>
        el.child(message(`${this.error} Use Refresh to retry.`)),
      )
      .child(
        v_flex()
          .id("issue-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .children(
            this.issues.map((issue) =>
              v_flex()
                .id(`issue-${issue.number}`)
                .px(12)
                .py(10)
                .gap(5)
                .cursor_pointer()
                .hover((style) => style.bg(t.hover))
                .on_click((_event, cx) => {
                  if (/^https:\/\/github\.com\//.test(issue.url))
                    cx.open_url(issue.url);
                })
                .child(
                  div()
                    .text_color(t.accent)
                    .text_size(11)
                    .child(`#${issue.number}`),
                )
                .child(div().child(issue.title))
                .when(issue.labels.length > 0, (el) =>
                  el.child(
                    div()
                      .truncate()
                      .text_size(11)
                      .text_color(t.muted)
                      .child(
                        issue.labels.map((label) => label.name).join(" · "),
                      ),
                  ),
                ),
            ),
          )
          .when(
            !this.loading && !this.error && this.issues.length === 0,
            (el) => el.child(message("No open issues in this repository.")),
          ),
      )
      .child(
        div()
          .px(12)
          .py(10)
          .text_size(10.5)
          .text_color(t.muted)
          .child(
            this.loading
              ? "Loading open issues…"
              : `${this.issues.length === 100 ? "Latest 100" : this.issues.length} open · Refreshes every 2 min${this.updated ? ` · ${this.updated}` : ""}`,
          ),
      );
  }
}
