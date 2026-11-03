// Keep all reported windows in the cache; this preference only controls presentation.
export function visibleWindows(provider, options) {
  return provider.windows.filter(window => provider.id !== "agy"
    || options.agyClaudeGpt !== false
    || !window.id?.startsWith("claude_gpt_"));
}

// Status bar only: an optional per-provider allowlist of window ids, set with the layout prop
// `windows` (for example {"grok": ["credits"]}). Order follows the provider's windows. An empty
// or non-matching list is ignored, so a typo never hides a provider. The popup keeps every window.
export function stripWindows(provider, options) {
  const shown = visibleWindows(provider, options);
  const wanted = options.windows?.[provider.id];
  if (!Array.isArray(wanted) || wanted.length === 0) return shown;
  const kept = shown.filter(window => wanted.includes(window.id));
  return kept.length ? kept : shown;
}
