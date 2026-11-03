// Pure bookkeeping for file tabs (no Herdr imports, so it tests outside the app).

export const baseName = (path) =>
  String(path ?? "")
    .split(/[\\/]/)
    .pop();

// The tab that appeared between two snapshots of tab ids, or null.
export const newTabId = (before, after) => {
  const had = new Set(before);
  return after.find((id) => !had.has(id)) ?? null;
};

// The shared map is { [tabId]: { file: absolute path, icon: icon path } }; zed-tabs reads it for
// the tab's icon. A file is "open" only while its tab exists.
export const findOpenTab = (map, path, liveTabIds) =>
  Object.entries(map ?? {}).find(
    ([id, entry]) => entry?.file === path && liveTabIds.includes(id),
  )?.[0] ?? null;

export const rememberTab = (map, tabId, entry) => ({
  ...(map ?? {}),
  [tabId]: entry,
});

export const pruneTabs = (map, liveTabIds) =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(([id]) => liveTabIds.includes(id)),
  );
