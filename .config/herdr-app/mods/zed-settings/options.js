// Pure helpers for the settings window (no Herdr imports, so they test outside the app).
// The quota defaults and the merge order mirror `options()` in mods/zed-quota/main.js: mods cannot
// import each other, so keep both in step.

export const QUOTA_DEFAULTS = {
  kinds: { session: true, weekly: true, monthly: true, model: false },
  hidden: [],
  windows: {},
  signedOut: false,
  names: false,
  remaining: false,
};

// Layout props are the starting point, what the user saved wins.
export function quotaOptions(start, saved) {
  const s = start ?? {},
    v = saved ?? {};
  return {
    ...QUOTA_DEFAULTS,
    ...s,
    ...v,
    kinds: { ...QUOTA_DEFAULTS.kinds, ...(s.kinds ?? {}), ...(v.kinds ?? {}) },
  };
}

export function toggleHidden(hidden, id) {
  return hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
}

export function fileOptions(saved) {
  return { wrap: false, editor: "Zed", ...(saved ?? {}) };
}

// The window's schema: each item names its category, its text and how it reads and patches its store
// ("file" is `zed-file.options`, "quota" is `zed-quota.options`).
export const CATEGORIES = [
  { id: "editor", label: "Editor" },
  { id: "quota", label: "Quota bar" },
  { id: "providers", label: "Providers" },
];

const KINDS = [
  [
    "session",
    "5-hour limit",
    "Show the 5-hour usage window in the status bar.",
  ],
  ["weekly", "Weekly limit", "Show the weekly usage window in the status bar."],
  [
    "monthly",
    "Monthly limit",
    "Show the monthly usage window in the status bar.",
  ],
  [
    "model",
    "Model limits",
    "Show per-model limits, where a provider has them.",
  ],
];

export function staticItems() {
  return [
    {
      id: "wrap",
      store: "file",
      category: "editor",
      label: "Word wrap",
      description:
        "Soft-wrap long lines in file tabs you open. Alt-Z still toggles it per tab.",
      get: (f) => f.wrap,
      patch: (_f, on) => ({ wrap: on }),
    },
    {
      id: "remaining",
      store: "quota",
      category: "quota",
      label: "Show remaining",
      description: "Show the quota left instead of the quota used.",
      get: (q) => q.remaining,
      patch: (_q, on) => ({ remaining: on }),
    },
    ...KINDS.map(([kind, label, description]) => ({
      id: `kind-${kind}`,
      store: "quota",
      category: "quota",
      label,
      description,
      get: (q) => q.kinds[kind],
      patch: (q, on) => ({ kinds: { ...q.kinds, [kind]: on } }),
    })),
    {
      id: "signed-out",
      store: "quota",
      category: "quota",
      label: "Signed-out providers",
      description: "List providers that have no active session.",
      get: (q) => q.signedOut,
      patch: (_q, on) => ({ signedOut: on }),
    },
    {
      id: "names",
      store: "quota",
      category: "quota",
      label: "Provider names",
      description: "Show the provider's name next to its icon.",
      get: (q) => q.names,
      patch: (_q, on) => ({ names: on }),
    },
  ];
}

// One item per provider the quota bar knows, plus Antigravity's own switch.
export function providerItems(providers) {
  const items = providers.map((p) => ({
    id: `prov-${p.id}`,
    store: "quota",
    category: "providers",
    label: p.label,
    description: `Include ${p.label} in the quota bar.`,
    get: (q) => !q.hidden.includes(p.id),
    patch: (q, on) => ({
      hidden: on
        ? q.hidden.filter((x) => x !== p.id)
        : q.hidden.includes(p.id)
          ? q.hidden
          : [...q.hidden, p.id],
    }),
  }));
  if (providers.some((p) => p.id === "agy"))
    items.push({
      id: "agy-claude-gpt",
      store: "quota",
      category: "providers",
      label: "Antigravity: Claude/GPT limits",
      description: "Show Antigravity's Claude and GPT limits.",
      get: (q) => q.agyClaudeGpt !== false,
      patch: (_q, on) => ({ agyClaudeGpt: on }),
    });
  return items;
}

export function matches(item, query) {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  return !q || `${item.label} ${item.description}`.toLowerCase().includes(q);
}

// A search looks through every category; without one, only the selected category shows.
export function visible(items, category, query) {
  const searching = String(query ?? "").trim() !== "";
  return items.filter(
    (item) => (searching || item.category === category) && matches(item, query),
  );
}

// The editor choice, from the editors found on the machine (null while none is known).
export function editorItem(editors) {
  const options = [...new Set(editors.map((e) => e.label))];
  if (!options.length) return null;
  return {
    id: "editor",
    kind: "choice",
    store: "file",
    category: "editor",
    label: "Editor",
    options,
    description:
      "The editor the “open in” button of a file tab uses. Zed by default.",
    get: (f) => f.editor,
    patch: (_f, value) => ({ editor: value }),
  };
}
