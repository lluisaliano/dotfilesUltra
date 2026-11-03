export function validRepo(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value)
  );
}

export function repoArgs(page) {
  return [
    "api",
    `user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
  ];
}

export function issueArgs(repo) {
  if (!validRepo(repo))
    throw new Error("Use a repository name like owner/repository.");
  return [
    "issue",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,url,labels",
  ];
}

export function parseResult(result) {
  if (result.code !== 0)
    throw new Error(
      result.stderr.trim() || "GitHub request failed. Check gh auth status.",
    );
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value))
    throw new Error("GitHub returned an unexpected response. Try refreshing.");
  return value;
}

export function filterRepos(repos, query) {
  const search = query.trim().toLowerCase();
  return repos.filter((repo) => repo.full_name.toLowerCase().includes(search));
}
