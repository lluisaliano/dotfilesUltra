// node mods/profile-pictures/remote.test.mjs
import assert from "node:assert/strict";
import { parseRemote, realHost, apiBase, pictureFor } from "./remote.js";

assert.deepEqual(parseRemote("git@github.com:octo/repo.git\n"), { host: "github.com", path: "octo/repo" });
assert.deepEqual(parseRemote("https://github.com/octo/repo"), { host: "github.com", path: "octo/repo" });
assert.deepEqual(parseRemote("ssh://git@gitlab.com:22/group/sub/repo.git"), { host: "gitlab.com", path: "group/sub/repo" });
assert.deepEqual(parseRemote("https://GitLab.example.com/a/b/"), { host: "gitlab.example.com", path: "a/b" });
assert.equal(parseRemote("not a url"), null);
assert.equal(parseRemote("git@-oProxyCommand=x:a/b"), null);
assert.deepEqual(parseRemote("git@github_work:org/repo.git"), { host: "github_work", path: "org/repo" });

assert.equal(realHost("work", "user git\nhostname github.com\nport 22\n"), "github.com");
assert.equal(realHost("github.com", "hostname ssh.github.com\nport 443\n"), "github.com");
assert.equal(realHost("gitlab.com", undefined), "gitlab.com");

assert.equal(apiBase("github.com"), "https://api.github.com/");
assert.equal(apiBase("octo.ghe.com"), "https://api.octo.ghe.com/");
assert.equal(apiBase("git.corp.example"), "https://git.corp.example/api/v3/");

// `gh api --hostname <host> <endpoint>` and `curl ... <url>` answer from `web`; the rest fails.
const fake = (web, { gh = true } = {}) => async (cmd, args) => {
  if (cmd === "gh" && !gh) throw new Error("gh not installed");
  const key = cmd === "gh" ? `gh ${args[2]} ${args[3]}` : args.at(-1);
  return key in web ? { code: 0, stdout: JSON.stringify(web[key]), stderr: "" } : { code: 1, stdout: "", stderr: "404" };
};
const user = (login, id, base = "https://avatars.githubusercontent.com/u") => ({ login, id, avatar_url: `${base}/${id}?v=4` });
const fork = { owner: user("me", 1), fork: true, parent: { owner: user("up", 2) } };
const mine = { host: "github.com", path: "me/repo" };

// github.com: a fork shows its upstream's owner, or its own with upstream off.
let web = { "gh github.com repos/me/repo": fork };
assert.deepEqual(await pictureFor(mine, true, fake(web)), { id: "github.com_up", sources: [{ url: "https://avatars.githubusercontent.com/u/2?v=4&s=64" }] });
assert.equal((await pictureFor(mine, false, fake(web))).id, "github.com_me");
// Without gh, the anonymous API; without an answer, the owner's picture by name.
assert.equal((await pictureFor(mine, true, fake({ "https://api.github.com/repos/me/repo": fork }, { gh: false }))).id, "github.com_up");
assert.deepEqual(await pictureFor(mine, true, fake({}, { gh: false })), { id: "github.com_me", sources: [{ url: "https://github.com/me.png?size=64" }] });

// Enterprise Server: the avatars API through gh, then the plain URL (a public-mode server).
const ghes = { owner: user("team", 7, "https://avatars.git.corp.example/u") };
const team = { host: "git.corp.example", path: "team/repo" };
assert.deepEqual(await pictureFor(team, true, fake({ "gh git.corp.example repos/team/repo": ghes })), {
  id: "git.corp.example_team",
  sources: [{ url: "https://git.corp.example/api/v3/enterprise/avatars/u/7?s=64", gh: true }, { url: "https://avatars.git.corp.example/u/7?v=4&s=64" }],
});
assert.equal((await pictureFor(team, true, fake({ "https://git.corp.example/api/v3/repos/team/repo": ghes }))).id, "git.corp.example_team");
// A fork on Enterprise Server: its upstream's owner, through the avatars API.
const ghesFork = { owner: user("me", 8), fork: true, parent: { owner: user("team", 7) } };
assert.equal((await pictureFor(team, true, fake({ "gh git.corp.example repos/team/repo": ghesFork }))).sources[0].url, "https://git.corp.example/api/v3/enterprise/avatars/u/7?s=64");

// Enterprise Cloud with data residency: its avatar URL through gh, then plain.
const ghe = { owner: user("org", 9, "https://avatars.octo.ghe.com/u") };
assert.deepEqual((await pictureFor({ host: "octo.ghe.com", path: "org/repo" }, true, fake({ "gh octo.ghe.com repos/org/repo": ghe }))).sources, [
  { url: "https://avatars.octo.ghe.com/u/9?v=4&s=64", gh: true },
  { url: "https://avatars.octo.ghe.com/u/9?v=4&s=64" },
]);

// GitLab: a fork shows its upstream's avatar; a group's comes as a path on the host.
const project = {
  path_with_namespace: "me/repo",
  avatar_url: "https://gitlab.com/me.png",
  forked_from_project: { path_with_namespace: "group/repo", avatar_url: null, namespace: { avatar_url: "/uploads/group.png" } },
};
web = { "https://gitlab.com/api/v4/projects/me%2Frepo": project };
assert.deepEqual(await pictureFor({ host: "gitlab.com", path: "me/repo" }, true, fake(web)), { id: "gitlab.com_group/repo", sources: [{ url: "https://gitlab.com/uploads/group.png" }] });
assert.deepEqual(await pictureFor({ host: "gitlab.com", path: "me/repo" }, false, fake(web)), { id: "gitlab.com_me/repo", sources: [{ url: "https://gitlab.com/me.png" }] });

// A GitLab whose name doesn't say gitlab, answering without any avatar: none, and Forgejo's API isn't asked.
const asked = [];
const selfHosted = fake({ "https://code.example.org/api/v4/projects/me%2Frepo": { path_with_namespace: "me/repo" } });
const asking = async (cmd, args) => (asked.push(args.at(-1)), selfHosted(cmd, args));
assert.equal(await pictureFor({ host: "code.example.org", path: "me/repo" }, true, asking), null);
assert.ok(!asked.some((url) => url.includes("/api/v1/")));
// A private gitlab.com project (no answer): none.
assert.equal(await pictureFor({ host: "gitlab.com", path: "me/repo" }, true, fake({})), null);

// Forgejo and Gitea: a fork shows its upstream's owner, by name first, then the API's URL.
const forgejoUser = (login) => ({ login, avatar_url: `https://codeberg.org/avatars/${login}` });
const forgejoFork = { owner: forgejoUser("me"), fork: true, parent: { owner: forgejoUser("up") } };
web = { "https://codeberg.org/api/v1/repos/me/repo": forgejoFork };
const codeberg = { host: "codeberg.org", path: "me/repo" };
assert.deepEqual(await pictureFor(codeberg, true, fake(web)), {
  id: "codeberg.org_up",
  sources: [{ url: "https://codeberg.org/user/avatar/up/64" }, { url: "https://codeberg.org/avatars/up" }],
});
assert.equal((await pictureFor(codeberg, false, fake(web))).id, "codeberg.org_me");
// A repo's own avatar wins over its owner's; a fork shows its upstream repo's, else that repo's owner.
const repoAvatar = (name) => `https://codeberg.org/repo-avatars/${name}`;
const withAvatars = {
  full_name: "me/repo", avatar_url: repoAvatar("mine"), owner: forgejoUser("me"), fork: true,
  parent: { full_name: "up/repo", avatar_url: repoAvatar("theirs"), owner: forgejoUser("up") },
};
web = { "https://codeberg.org/api/v1/repos/me/repo": withAvatars };
assert.deepEqual(await pictureFor(codeberg, true, fake(web)), { id: "codeberg.org_up/repo", sources: [{ url: repoAvatar("theirs") }] });
assert.deepEqual(await pictureFor(codeberg, false, fake(web)), { id: "codeberg.org_me/repo", sources: [{ url: repoAvatar("mine") }] });
web = { "https://codeberg.org/api/v1/repos/me/repo": { ...withAvatars, parent: { ...withAvatars.parent, avatar_url: "" } } };
assert.equal((await pictureFor(codeberg, true, fake(web))).id, "codeberg.org_up");
web = { "https://codeberg.org/api/v1/repos/me/repo": forgejoFork };
// The Forgejo API is asked with the host's ~/.netrc login, if any; the others are not.
const calls = [];
const recording = async (cmd, args) => (calls.push([cmd, ...args]), fake(web)(cmd, args));
await pictureFor(codeberg, true, recording);
assert.deepEqual(calls.filter((c) => c.includes("--netrc-optional")).map((c) => c.at(-1)), ["https://codeberg.org/api/v1/repos/me/repo"]);
// A server whose API wants a login (no answer): the remote owner's picture by name, so a server
// of another kind just keeps the letter when that address gives no image.
assert.deepEqual(await pictureFor({ host: "git.example.org", path: "team/repo" }, true, fake({})), {
  id: "git.example.org_team",
  sources: [{ url: "https://git.example.org/user/avatar/team/64" }],
});
console.log("ok");
