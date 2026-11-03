// Opens a file as a tab of its own (the zed-file mod), or shows its tab when it is already open.
// The mods cannot import each other, so the icon is worked out here and travels in the tab's
// props and in shared state.
import { run, spaces, shared, setShared } from "herdr";
import {
  baseName,
  findOpenTab,
  newTabId,
  rememberTab,
  pruneTabs,
} from "./open-tab-logic.js";

const SHARED_TABS = "zed-file.tabs";

const tabIds = () =>
  spaces().flatMap((space) => (space.tabs ?? []).map((tab) => tab.id));

// `file` is absolute, `icon` its icon path, `on` the space's machine (null = this one).
// Call it from a click handler: it needs that event's `cx` for the timer.
export function openFile({ file, icon, on }, cx) {
  const live = tabIds();
  const existing = findOpenTab(shared(SHARED_TABS), file, live);
  if (existing) return run("tab.select", { id: existing });
  run("tab.new", {
    name: baseName(file),
    mod: "zed-file",
    props: { file, icon, on: on ?? null },
  });
  // tab.new returns nothing, so find the new tab once it is in the model and remember it.
  cx.timer.after(300, () => {
    const id = newTabId(live, tabIds());
    if (id)
      setShared(
        SHARED_TABS,
        rememberTab(pruneTabs(shared(SHARED_TABS), tabIds()), id, {
          file,
          icon,
        }),
      );
  });
}
