// Groups live in shared "space-groups" on the computer running the app:
// { groups: [{ id, name, machine, folded, parent }] in the order shown, spaces: { <space id>: <group id> } }.
// A space id already carries its machine ("server/s3"; local ones have none), and a
// group only holds spaces and groups of its own machine. `parent` is the id of the
// group it sits in, null at the top; siblings show in array order.

import { shared, setShared, spaces, machines } from "herdr";

export const MOD = "space-groups";
const KEY = "space-groups";

export function load() {
  const raw = shared(KEY) ?? {};
  const groups = (Array.isArray(raw.groups) ? raw.groups : [])
    .filter((g) => typeof g?.id === "string" && typeof g?.name === "string")
    .map((g) => ({ id: g.id, name: g.name, machine: g.machine ?? null, folded: Boolean(g.folded), parent: typeof g.parent === "string" ? g.parent : null }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const g of groups) {
    const p = byId.get(g.parent);
    if (!p || p.machine !== g.machine) g.parent = null;
  }
  for (const g of groups) {
    const seen = new Set([g.id]);
    for (let p = byId.get(g.parent); p; p = byId.get(p.parent)) {
      if (seen.has(p.id)) { g.parent = null; break; }
      seen.add(p.id);
    }
  }
  const members = Object.fromEntries(Object.entries(raw.spaces ?? {}).filter(([, g]) => byId.has(g)));
  return { groups, spaces: members };
}

function save(state) {
  setShared(KEY, state);
}

export const groupsOn = (state, machine) => state.groups.filter((g) => g.machine === (machine ?? null));

export const childrenOf = (state, machine, parent) => groupsOn(state, machine).filter((g) => g.parent === (parent ?? null));

export function tree(state, machine, parent = null, depth = 0) {
  return childrenOf(state, machine, parent).flatMap((g) => [{ g, depth }, ...tree(state, machine, g.id, depth + 1)]);
}

export function within(state, groupId) {
  const below = new Set([groupId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const g of state.groups) if (g.parent && below.has(g.parent) && !below.has(g.id)) { below.add(g.id); grew = true; }
  }
  return below;
}

export function path(state, g) {
  const names = [];
  for (let at = g; at; at = state.groups.find((o) => o.id === at.parent)) names.unshift(at.name);
  return names.join(" / ");
}

export function groupOf(state, space) {
  const g = state.groups.find((g) => g.id === state.spaces[space.id]);
  return g && g.machine === (space.machine ?? null) ? g : null;
}

export function assign(spaceId, groupId) {
  const state = load();
  if (groupId) state.spaces[spaceId] = groupId;
  else delete state.spaces[spaceId];
  save(state);
}

export function create(name, machine, parent = null) {
  const state = load();
  const id = `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  state.groups.push({ id, name, machine: machine ?? null, folded: false, parent });
  save(state);
  return id;
}

export function rename(groupId, name) {
  const state = load();
  const g = state.groups.find((g) => g.id === groupId);
  if (!g) return;
  g.name = name;
  save(state);
}

export function remove(groupId) {
  const state = load();
  const g = state.groups.find((g) => g.id === groupId);
  if (!g) return;
  state.groups = state.groups.filter((o) => o !== g);
  for (const o of state.groups) if (o.parent === g.id) o.parent = g.parent;
  state.spaces = Object.fromEntries(Object.entries(state.spaces)
    .map(([s, id]) => [s, id === g.id ? g.parent : id]).filter(([, id]) => id));
  save(state);
}

// `where`: "above" or "below" the target, as its sibling, or "into" it, as its last group.
export function reorder(groupId, targetId, where) {
  const state = load();
  const g = state.groups.find((g) => g.id === groupId);
  const target = state.groups.find((g) => g.id === targetId);
  if (!g || !target || g.machine !== target.machine || within(state, g.id).has(target.id)) return;
  state.groups.splice(state.groups.indexOf(g), 1);
  if (where === "into") {
    g.parent = target.id;
    state.groups.push(g);
  } else {
    g.parent = target.parent;
    state.groups.splice(state.groups.indexOf(target) + (where === "below" ? 1 : 0), 0, g);
  }
  save(state);
}

export function nest(groupId, parentId) {
  const state = load();
  const g = state.groups.find((g) => g.id === groupId);
  const p = parentId && state.groups.find((o) => o.id === parentId);
  if (!g || (parentId && (!p || p.machine !== g.machine || within(state, g.id).has(p.id)))) return;
  state.groups.splice(state.groups.indexOf(g), 1);
  g.parent = parentId ?? null;
  state.groups.push(g);
  save(state);
}

export function shift(groupId, by) {
  const state = load();
  const g = state.groups.find((g) => g.id === groupId);
  const mine = g ? childrenOf(state, g.machine, g.parent) : [];
  const target = mine[mine.indexOf(g) + by];
  if (target) reorder(groupId, target.id, by > 0 ? "below" : "above");
}

export function toggle(groupId) {
  const state = load();
  const g = state.groups.find((g) => g.id === groupId);
  if (!g) return;
  g.folded = !g.folded;
  save(state);
}

export function unfold(groupId) {
  const state = load();
  const g = state.groups.find((g) => g.id === groupId);
  if (!g?.folded) return;
  g.folded = false;
  save(state);
}

export const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// A closed space leaves its group. Only once its machine's spaces could be read:
// a machine that is away or still loading shows none of them.
export function prune() {
  const raw = shared(KEY);
  if (!raw) return;
  const state = load();
  const ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name ?? null));
  const live = new Set(spaces().map((s) => s.id));
  const machineOf = Object.fromEntries(state.groups.map((g) => [g.id, g.machine]));
  const kept = Object.fromEntries(Object.entries(state.spaces).filter(([id, g]) => live.has(id) || !ready.has(machineOf[g])));
  if (Object.keys(kept).length !== Object.keys(raw.spaces ?? {}).length) save({ ...state, spaces: kept });
}
