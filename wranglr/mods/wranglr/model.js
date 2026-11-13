// Wranglr's rules: which Group each space is in, the order shown, and what each action does.
// Pure: no Herdr, no Node APIs, no clock. act never mutates its inputs.

const SORTS = ["recent", "kind", "az", "manual"];
const KIND_RANK = { workspace: 0, repo: 1, custom: 2 };
const UNNAMED_BRANCHES = new Set(["main", "master", "develop", "staging", "HEAD"]);
const PENDING_LIMIT = 20;

export function emptyState() {
  return {
    v: 1, place: {}, started: {}, custom: [], subs: {}, folded: {},
    order: { groups: [], spaces: {} }, dismissed: [], seen: {}, snap: {},
    names: {}, titles: {}, naming: {}, pending: [], active: {},
  };
}

export function mkey(machine) {
  return machine ?? "";
}

function machineOfKey(key) {
  return key === "" ? null : key;
}

// A remote space id starts with "<machine>/". Used only when the snapshot is gone.
function machineOfId(id) {
  const i = id.indexOf("/");
  return i > 0 ? id.slice(0, i) : null;
}

// Main roots per Machine: what Wranglr has seen, overridden by what the config declares.
export function clonedMap(config, state) {
  const out = {};
  const put = (mk, identity, path) => {
    if (!path) return;
    (out[mk] ||= {})[identity] = path;
  };
  for (const [identity, seen] of Object.entries(state?.seen || {}))
    for (const [mk, path] of Object.entries(seen.on || {})) put(mk, identity, path);
  for (const [identity, repo] of Object.entries(config?.repos || {}))
    for (const [mk, on] of Object.entries(repo.on || {})) put(mk, identity, on?.path);
  for (const ws of config?.workspaces || [])
    for (const [mk, on] of Object.entries(ws.on || {}))
      for (const [identity, path] of Object.entries(on?.paths || {})) put(mk, identity, path);
  return out;
}

// Paths

function isWindowsPath(mk, local) {
  return mk === "" && !!local?.windows;
}

function normPath(path, win) {
  let p = String(path ?? "");
  if (win) p = p.replace(/\\/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

function pathKey(path, win) {
  const p = normPath(path, win);
  return win ? p.toLowerCase() : p;
}

function samePath(a, b, win) {
  return pathKey(a, win) === pathKey(b, win);
}

function isUnder(path, dir, win) {
  const d = pathKey(dir, win);
  return pathKey(path, win).startsWith(d.endsWith("/") ? d : d + "/");
}

function isAbsolutePath(p) {
  return /^([\/\\]|[A-Za-z]:)/.test(p);
}

function joinPath(base, rel) {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.replace(/[\/\\]+$/, "") + sep + rel.replace(/^\.[\/\\]/, "");
}

// "." and ".." resolved, so a path names one place however it was written. Keeps the path's own separator.
function cleanPath(path) {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const lead = path.match(/^([A-Za-z]:)?[\/\\]*/)[0];
  const out = [];
  for (const part of path.slice(lead.length).split(/[\/\\]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return lead.replace(/[\/\\]+/g, sep) + out.join(sep);
}

function isHomeShaped(dir) {
  return /^\/(home\/[^/]+|root|Users\/[^/]+)$/.test(dir);
}

// Declared home, else the deepest common parent of every Repo of the Workspace on that Machine.
export function workspaceHome(workspace, mk, cloned, local) {
  const declared = workspace?.on?.[mk]?.home;
  if (declared) return declared;
  const repos = workspace?.repos || [];
  if (repos.length < 2) return null;
  const known = cloned?.[mk] || {};
  const paths = repos.map((id) => known[id]);
  if (paths.some((p) => !p)) return null;
  const win = isWindowsPath(mk, local);
  const parents = paths.map((p) => normPath(p, win).split("/").slice(0, -1));
  const common = [];
  for (let i = 0; i < parents[0].length; i++) {
    const part = parents[0][i];
    const same = (x) => (win ? x?.toLowerCase() === part.toLowerCase() : x === part);
    if (!parents.every((ps) => same(ps[i]))) break;
    common.push(part);
  }
  const dir = common.join("/");
  if (dir === "" || /^[A-Za-z]:$/.test(dir) || /^\/mnt(\/[^/]+)?$/.test(dir)) return null;
  if (mk === "" ? samePath(dir, local?.home ?? "", win) : isHomeShaped(dir)) return null;
  return win && paths[0].includes("\\") ? dir.replace(/\//g, "\\") : dir;
}

// Naming helpers

export function ticketOf(branch, name, pattern) {
  const prefix = /^(#?\d+|[A-Za-z]+-\d+) /.exec(name || "");
  if (prefix) return prefix[1];
  if (!branch || !pattern) return null;
  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return null;
  }
  const m = re.exec(branch);
  return m && m[1] ? m[1] : null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function branchWords(branch, ticket) {
  if (!branch) return [];
  let rest = branch.replace(/^[^/]+\//, "");
  if (ticket) {
    const id = escapeRegExp(String(ticket).replace(/^#/, ""));
    rest = rest.replace(new RegExp(`(^|[-_/.\\s])#?${id}(?=$|[-_/.\\s])`, "i"), "$1");
  }
  const words = rest.replace(/#/g, " ").split(/[-_/.\s]+/).filter(Boolean).map((w) => w.toLowerCase());
  if (words.length) words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words;
}

function nameFrom(ticket, words) {
  return [ticket, ...words].filter(Boolean).join(" ");
}

// World helpers

function readyKeys(world) {
  return (world.machines || []).filter((m) => m.layout === "ready").map((m) => mkey(m.name));
}

function isReady(world, mk) {
  return readyKeys(world).includes(mk);
}

function activityOfSpace(space) {
  let best = 0;
  for (const t of space?.tabs || []) best = Math.max(best, t.changed_at || 0, t.working_since || 0);
  return best;
}

function lastSegments(identity, n) {
  return identity.split("/").filter(Boolean).slice(-n).join("/");
}

// Machine keys to start on: the Group's priority list, then the default Machine setting, then this
// computer, then any other ready Machine. Only ready Machines the Group can start on are kept.
function machineChoices(ctx, priority, usable) {
  const ready = readyKeys(ctx.world);
  const preset = ctx.config.settings?.machine;
  const out = [];
  for (const mk of [...(Array.isArray(priority) ? priority : []), ...(typeof preset === "string" ? [preset] : []), "", ...ready])
    if (ready.includes(mk) && !out.includes(mk) && usable(mk)) out.push(mk);
  return out;
}

// Context shared by arrange and act: rows, Groups that exist, and membership.

function context(world, config, rawState) {
  const state = { ...emptyState(), ...rawState };
  state.order = { groups: [], spaces: {}, ...state.order };
  const cloned = world.cloned || clonedMap(config, state);
  const local = world.local || { home: "", windows: false };
  const workspaces = config.workspaces || [];
  const wsByName = new Map(workspaces.map((w) => [w.name, w]));
  const live = new Map(world.spaces.map((s, i) => [s.id, i]));

  const repoNames = new Map();
  for (const [identity, seen] of Object.entries(state.seen)) repoNames.set(identity, seen.name);
  for (const repo of Object.values(world.repos || {}))
    if (repo && !repoNames.has(repo.identity)) repoNames.set(repo.identity, repo.name);
  for (const snap of Object.values(state.snap))
    if (snap.identity && !repoNames.has(snap.identity)) repoNames.set(snap.identity, lastSegments(snap.identity, 1));

  const groupExists = (gid) => {
    if (gid.startsWith("ws:")) return wsByName.has(gid.slice(3));
    if (gid.startsWith("repo:")) return repoNames.has(gid.slice(5));
    if (gid.startsWith("custom:")) return state.custom.some((c) => "custom:" + c.id === gid);
    return false;
  };
  const subExists = (gid, sub) => (state.subs[gid] || []).some((s) => s.id === sub);

  const rows = world.spaces.map((space) => ({
    id: space.id, space, name: space.name, machine: space.machine, dim: false,
  }));
  for (const [id, snap] of Object.entries(state.snap)) {
    if (live.has(id) || isReady(world, mkey(snap.machine))) continue;
    rows.push({ id, space: null, name: snap.name, machine: snap.machine, dim: true });
  }
  const herdrIndex = new Map(rows.map((r, i) => [r.id, i]));

  return { world, config, state, cloned, local, workspaces, wsByName, repoNames, groupExists, subExists, rows, herdrIndex };
}

function placementMember(ctx, id) {
  const p = ctx.state.place[id];
  if (!p) return null;
  if (p.group === "") return { group: "", sub: null };
  if (!ctx.groupExists(p.group)) return null;
  if (p.sub != null && !ctx.subExists(p.group, p.sub)) return null;
  return { group: p.group, sub: p.sub ?? null };
}

function startedMember(ctx, id) {
  const name = ctx.state.started[id];
  return name != null && ctx.wsByName.has(name) ? { group: "ws:" + name, sub: null } : null;
}

function homeMember(ctx, row) {
  const folder = row.space ? row.space.folder : ctx.state.snap[row.id]?.folder;
  if (!folder) return null;
  const mk = mkey(row.machine);
  for (const ws of ctx.workspaces) {
    const home = workspaceHome(ws, mk, ctx.cloned, ctx.local);
    if (home && samePath(folder, home, isWindowsPath(mk, ctx.local))) return { group: "ws:" + ws.name, sub: null };
  }
  return null;
}

function repoMember(ctx, id) {
  const repo = ctx.world.repos?.[id];
  const identity = repo === undefined ? ctx.state.snap[id]?.identity : repo?.identity;
  return identity ? { group: "repo:" + identity, sub: null } : null;
}

function memberOf(ctx, row) {
  return placementMember(ctx, row.id) || startedMember(ctx, row.id) || homeMember(ctx, row)
    || repoMember(ctx, row.id) || { group: "", sub: null };
}

// Sorting

function activityOf(ctx, row) {
  return activityOfSpace(row.space) || ctx.state.active[row.id] || 0;
}

function byName(a, b) {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

function sortRows(ctx, rows, key) {
  const sort = ctx.config.settings.sort;
  const herdr = (a, b) => ctx.herdrIndex.get(a.id) - ctx.herdrIndex.get(b.id);
  const list = [...rows];
  if (sort === "recent") return list.sort((a, b) => activityOf(ctx, b) - activityOf(ctx, a) || herdr(a, b));
  if (sort === "manual") {
    const order = ctx.state.order.spaces[key] || [];
    const pos = (r) => (order.includes(r.id) ? order.indexOf(r.id) : Infinity);
    return list.sort((a, b) => pos(a) - pos(b) || herdr(a, b));
  }
  return list.sort((a, b) => byName(a, b) || herdr(a, b));
}

function byKind(a, b) {
  return KIND_RANK[a.kind] - KIND_RANK[b.kind] || byName(a, b);
}

function sortGroups(ctx, groups) {
  const sort = ctx.config.settings.sort;
  const list = [...groups];
  if (sort === "az") return list.sort((a, b) => byName(a, b) || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
  if (sort === "manual") {
    const order = ctx.state.order.groups;
    const pos = (g) => (order.includes(g.id) ? order.indexOf(g.id) : Infinity);
    return list.sort((a, b) => pos(a) - pos(b) || byKind(a, b));
  }
  if (sort === "recent") {
    const latest = (g) => Math.max(0, ...allRows(g).map((r) => activityOf(ctx, r)));
    const empty = (g) => allRows(g).length === 0;
    return list.sort((a, b) => empty(a) - empty(b) || latest(b) - latest(a) || byName(a, b));
  }
  return list.sort(byKind);
}

function allRows(group) {
  return [...group.rows, ...group.subgroups.flatMap((s) => s.rows)];
}

// Groups

function groupMachines(ctx, group) {
  if (group.kind === "custom") return machineChoices(ctx, ctx.state.custom.find((x) => "custom:" + x.id === group.id)?.machines, () => true);
  if (group.kind === "repo") {
    const identity = group.id.slice(5);
    return machineChoices(ctx, ctx.config.repos?.[identity]?.machines, (mk) => !!ctx.cloned[mk]?.[identity]);
  }
  const ws = ctx.wsByName.get(group.name);
  return machineChoices(ctx, ws.machines, (mk) => !!workspaceHome(ws, mk, ctx.cloned, ctx.local));
}

function candidateGroups(ctx, members) {
  const groups = ctx.workspaces.map((w) => ({ id: "ws:" + w.name, kind: "workspace", name: w.name }));
  const occupied = new Set(Object.values(members).map((m) => m.group));
  for (const [identity, name] of ctx.repoNames) {
    const id = "repo:" + identity;
    const shown = occupied.has(id) || (ctx.state.seen[identity] && !ctx.state.dismissed.includes(identity));
    if (shown) groups.push({ id, kind: "repo", name: name || lastSegments(identity, 1), identity });
  }
  const repos = groups.filter((g) => g.kind === "repo");
  const clash = repos.filter((g) => repos.some((o) => o !== g && o.name.toLowerCase() === g.name.toLowerCase()));
  for (const g of clash) g.name = lastSegments(g.identity, 2);
  for (const c of ctx.state.custom) groups.push({ id: "custom:" + c.id, kind: "custom", name: c.name });
  return groups;
}

function buildTree(ctx) {
  const members = {};
  for (const row of ctx.rows) members[row.id] = memberOf(ctx, row);
  const folded = (key) => !!ctx.state.folded[key];
  const groups = candidateGroups(ctx, members).map((g) => {
    const mine = ctx.rows.filter((r) => members[r.id].group === g.id);
    const subgroups = (ctx.state.subs[g.id] || []).map((s) => ({
      id: s.id, name: s.name, folded: folded(g.id + "/" + s.id),
      rows: sortRows(ctx, mine.filter((r) => members[r.id].sub === s.id), g.id + "/" + s.id),
    }));
    const group = {
      id: g.id, kind: g.kind, name: g.name, folded: folded(g.id),
      rows: sortRows(ctx, mine.filter((r) => members[r.id].sub == null), g.id), subgroups,
    };
    group.machines = groupMachines(ctx, group);
    group.can = {
      plus: g.kind === "custom" || group.machines.length > 0,
      dismiss: g.kind === "repo" && mine.length === 0,
    };
    return group;
  });
  const sorted = sortGroups(ctx, groups);
  const loose = sortRows(ctx, ctx.rows.filter((r) => members[r.id].group === ""), "");
  const order = [...sorted.flatMap(allRows), ...loose].filter((r) => !r.dim).map((r) => r.id);
  return { tree: { groups: sorted, loose, order }, members };
}

export function arrange(world, config, state) {
  return buildTree(context(world, config, state)).tree;
}

// Actions. Each handler edits `s`, a private copy of the state, and pushes effects.

function copyState(state) {
  const base = emptyState();
  const s = { ...base, ...JSON.parse(JSON.stringify(state || {})) };
  s.order = { groups: [], spaces: {}, ...s.order };
  return s;
}

function spaceById(world, id) {
  return world.spaces.find((s) => s.id === id) || null;
}

function toast(effects, body) {
  effects.push({ type: "toast", level: "warning", title: "Wranglr", body });
}

function syncSpaces(c) {
  const { world, s } = c;
  for (const space of world.spaces) {
    const repo = world.repos?.[space.id];
    const identity = repo ? repo.identity : repo === null ? null : s.snap[space.id]?.identity ?? null;
    s.snap[space.id] = { name: space.name, machine: space.machine, identity, folder: space.folder };
    const activity = activityOfSpace(space);
    if (activity > 0) s.active[space.id] = activity;
    const title = world.titles?.[space.id];
    if (title && !s.titles[space.id]) s.titles[space.id] = title;
    if (!repo) continue;
    const seen = (s.seen[repo.identity] ||= { name: repo.name, on: {} });
    seen.name = repo.name;
    seen.on = { ...seen.on, [mkey(space.machine)]: repo.main };
    s.dismissed = s.dismissed.filter((d) => d !== repo.identity);
  }
}

function pendingMatches(c, entry, space) {
  if (mkey(space.machine) !== mkey(entry.machine) || (entry.before || []).includes(space.id)) return false;
  const mk = mkey(space.machine);
  const win = isWindowsPath(mk, c.world.local);
  if (samePath(space.folder, entry.folder, win)) return true;
  return entry.folder === "" && mk === "" && samePath(space.folder, c.world.local?.home ?? "", win);
}

function syncPending(c, known) {
  const { world, s } = c;
  const fresh = world.spaces.filter((sp) => !known.has(sp.id));
  const claimed = new Set();
  const kept = [];
  for (const entry of s.pending) {
    const space = fresh.find((sp) => !claimed.has(sp.id) && pendingMatches(c, entry, sp));
    if (space) {
      claimed.add(space.id);
      if (entry.workspace) s.started[space.id] = entry.workspace;
      if (entry.group.startsWith("custom:") || entry.sub != null) s.place[space.id] = { group: entry.group, sub: entry.sub ?? null };
      // Started from a Repo group: assume that Repo until git says otherwise.
      if (entry.group.startsWith("repo:") && world.repos?.[space.id] === undefined && s.snap[space.id] && !s.snap[space.id].identity)
        s.snap[space.id].identity = entry.group.slice(5);
      continue;
    }
    const age = (entry.age || 0) + 1;
    if (age < PENDING_LIMIT) kept.push({ ...entry, age });
  }
  s.pending = kept;
}

function forget(s, id) {
  for (const map of [s.place, s.started, s.snap, s.names, s.titles, s.naming, s.active]) delete map[id];
  for (const key of Object.keys(s.order.spaces)) s.order.spaces[key] = s.order.spaces[key].filter((x) => x !== id);
}

function syncForget(c) {
  const { world, s } = c;
  const live = new Set(world.spaces.map((sp) => sp.id));
  const ids = new Set([s.place, s.started, s.snap, s.names, s.titles, s.naming, s.active].flatMap(Object.keys));
  for (const list of Object.values(s.order.spaces)) for (const id of list) ids.add(id);
  for (const id of ids) {
    if (live.has(id)) continue;
    const machine = id in s.snap ? s.snap[id].machine : machineOfId(id);
    if (isReady(world, mkey(machine))) forget(s, id);
  }
}

function syncPlacements(c) {
  const ctx = context(c.world, c.config, c.s);
  for (const [id, p] of Object.entries(c.s.place)) {
    if (p.group === "") continue;
    if (!ctx.groupExists(p.group) || (p.sub != null && !ctx.subExists(p.group, p.sub))) delete c.s.place[id];
  }
}

function rename(c, id, name) {
  c.effects.push({ type: "rename", id, name });
  c.s.names[id] = name;
  c.s.naming[id] = "done";
}

function ask(c, space, ticket, title) {
  c.effects.push({ type: "ask", space: space.id, ticket, branch: space.branch, title });
  c.s.naming[space.id] = "asked";
}

function syncNaming(c) {
  const { world, config, s } = c;
  if (!config.settings.autoname) return;
  for (const space of world.spaces) {
    const id = space.id;
    if (!s.naming[id]) {
      if (space.named && s.names[id] !== space.name) {
        s.naming[id] = "done";
        continue;
      }
      if (!space.branch || UNNAMED_BRANCHES.has(space.branch)) continue;
      const ticket = ticketOf(space.branch, null, config.settings.ticket);
      const words = branchWords(space.branch, ticket);
      if (words.length >= 1 && words.length <= 4) rename(c, id, nameFrom(ticket, words));
      else s.naming[id] = words.length > 4 ? "wait" : "done";
    }
    if (s.naming[id] === "wait" && world.titles?.[id])
      ask(c, space, ticketOf(space.branch, null, config.settings.ticket), s.titles[id] || world.titles[id]);
  }
}

function doSync(a, c) {
  const known = new Set(Object.keys(c.prev.snap || {}));
  syncSpaces(c);
  syncPending(c, known);
  syncForget(c);
  syncPlacements(c);
  syncNaming(c);
}

function containerKey(group, sub) {
  return group === "" ? "" : sub == null ? group : group + "/" + sub;
}

function targetValid(c, group, sub) {
  if (group === "") return sub == null;
  const ctx = context(c.world, c.config, c.prev);
  return ctx.groupExists(group) && (sub == null || ctx.subExists(group, sub));
}

function rowKnown(c, id) {
  return c.tree().members[id] !== undefined;
}

function doMove(a, c) {
  if (!rowKnown(c, a.space) || !targetValid(c, a.group, a.sub)) return false;
  c.s.place[a.space] = { group: a.group, sub: a.group === "" ? null : a.sub ?? null };
  return true;
}

function containerRows(tree, key) {
  if (key === "") return tree.loose;
  for (const g of tree.groups) {
    if (g.id === key) return g.rows;
    for (const sub of g.subgroups) if (g.id + "/" + sub.id === key) return sub.rows;
  }
  return [];
}

function insertBefore(list, item, before) {
  const out = list.filter((x) => x !== item);
  const i = before == null ? -1 : out.indexOf(before);
  out.splice(i < 0 ? out.length : i, 0, item);
  return out;
}

function doDrop(a, c) {
  if (!doMove(a, c)) return;
  const key = containerKey(a.group, a.group === "" ? null : a.sub ?? null);
  const shown = containerRows(c.tree().tree, key).map((r) => r.id);
  for (const k of Object.keys(c.s.order.spaces)) c.s.order.spaces[k] = c.s.order.spaces[k].filter((x) => x !== a.space);
  c.s.order.spaces[key] = insertBefore(shown, a.space, a.before);
}

function doDropGroup(a, c) {
  const shown = c.tree().tree.groups.map((g) => g.id);
  if (!shown.includes(a.group)) return;
  c.s.order.groups = insertBefore(shown, a.group, a.before);
}

function doSelect(a, c) {
  const id = c.tree().tree.order[a.index - 1];
  if (id) c.effects.push({ type: "select", id });
}

function doStep(a, c) {
  const order = c.tree().tree.order;
  if (!order.length) return;
  const at = order.indexOf(c.world.focus);
  const step = a.type === "next" ? 1 : -1;
  const i = at < 0 ? (step > 0 ? 0 : order.length - 1) : (at + step + order.length) % order.length;
  c.effects.push({ type: "select", id: order[i] });
}

function toggleFold(s, key) {
  if (s.folded[key]) delete s.folded[key];
  else s.folded[key] = true;
}

function doFold(a, c) {
  if (!targetValid(c, a.group, a.sub) || a.group === "") return;
  toggleFold(c.s, a.sub == null ? a.group : a.group + "/" + a.sub);
}

function doFoldFocused(a, c) {
  const member = c.tree().members[c.world.focus];
  if (member && member.group !== "") toggleFold(c.s, member.group);
}

function doSort(a, c) {
  const current = c.config.settings.sort;
  const value = a.value ?? SORTS[(SORTS.indexOf(current) + 1) % SORTS.length];
  if (SORTS.includes(value)) c.effects.push({ type: "setting", key: "sort", value });
}

// The settings menu's Save: the changed settings, written in one go.
const SETTINGS = ["sort", "plus", "worktrees", "autoname", "ticket", "agent", "machine"];
function doSettings(a, c) {
  const values = {};
  for (const key of SETTINGS) if (a.values && typeof a.values === "object" && key in a.values) values[key] = a.values[key];
  if (Object.keys(values).length) c.effects.push({ type: "settings", values });
}

// A Group's own settings. A Custom group's are in the State; a Workspace's and a Repo's go to the config file.
function doGroupSettings(a, c) {
  const v = a.values, id = typeof a.group === "string" ? a.group : "";
  if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).length) return;
  if (id.startsWith("custom:")) {
    const custom = c.s.custom.find((x) => "custom:" + x.id === id);
    if (custom && Array.isArray(v.machines)) custom.machines = [...new Set(v.machines.filter((m) => typeof m === "string"))];
  } else if (id.startsWith("ws:")) {
    if (c.ctx().wsByName.has(id.slice(3))) c.effects.push({ type: "group", kind: "workspace", key: id.slice(3), values: v });
  } else if (id.startsWith("repo:") && id.length > 5) c.effects.push({ type: "group", kind: "repo", key: id.slice(5), values: v });
}

function slugId(name, taken) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

function cleanName(name) {
  return typeof name === "string" ? name.trim() : "";
}

function doAddCustom(a, c) {
  const name = cleanName(a.name);
  if (!name) return;
  c.s.custom.push({ id: slugId(name, c.s.custom.map((x) => x.id)), name });
}

function doRenameGroup(a, c) {
  const name = cleanName(a.name);
  const custom = c.s.custom.find((x) => "custom:" + x.id === a.group);
  if (name && custom) custom.name = name;
}

function dropContainer(s, prefix) {
  delete s.folded[prefix];
  delete s.order.spaces[prefix];
  for (const k of Object.keys(s.folded)) if (k.startsWith(prefix + "/")) delete s.folded[k];
  for (const k of Object.keys(s.order.spaces)) if (k.startsWith(prefix + "/")) delete s.order.spaces[k];
}

function doRemoveCustom(a, c) {
  const s = c.s;
  if (!s.custom.some((x) => "custom:" + x.id === a.group)) return;
  s.custom = s.custom.filter((x) => "custom:" + x.id !== a.group);
  delete s.subs[a.group];
  dropContainer(s, a.group);
  s.order.groups = s.order.groups.filter((g) => g !== a.group);
  for (const [id, p] of Object.entries(s.place)) if (p.group === a.group) delete s.place[id];
}

function doAddSub(a, c) {
  const name = cleanName(a.name);
  if (!name || a.group === "" || !targetValid(c, a.group, null)) return;
  const subs = (c.s.subs[a.group] ||= []);
  subs.push({ id: slugId(name, subs.map((x) => x.id)), name });
}

function doRenameSub(a, c) {
  const name = cleanName(a.name);
  const sub = (c.s.subs[a.group] || []).find((x) => x.id === a.sub);
  if (name && sub) sub.name = name;
}

function doRemoveSub(a, c) {
  const s = c.s;
  const subs = s.subs[a.group] || [];
  if (!subs.some((x) => x.id === a.sub)) return;
  s.subs[a.group] = subs.filter((x) => x.id !== a.sub);
  if (!s.subs[a.group].length) delete s.subs[a.group];
  dropContainer(s, a.group + "/" + a.sub);
  for (const p of Object.values(s.place)) if (p.group === a.group && p.sub === a.sub) p.sub = null;
}

function doDismiss(a, c) {
  const group = c.tree().tree.groups.find((g) => g.id === a.group);
  if (!group || !group.can.dismiss) return;
  const identity = a.group.slice(5);
  if (!c.s.dismissed.includes(identity)) c.s.dismissed.push(identity);
}

function doNamed(a, c) {
  const space = spaceById(c.world, a.space);
  const words = typeof a.words === "string" ? a.words.trim().split(/\s+/).filter(Boolean) : [];
  if (space && c.s.naming[a.space] === "asked" && words.length >= 1 && words.length <= 4)
    rename(c, a.space, nameFrom(ticketOf(space.branch, space.name, c.config.settings.ticket), words));
  else c.s.naming[a.space] = "done";
}

function doName(a, c) {
  const space = spaceById(c.world, a.space);
  if (!space) return;
  const ticket = ticketOf(space.branch, space.name, c.config.settings.ticket);
  const words = !space.branch || UNNAMED_BRANCHES.has(space.branch) ? [] : branchWords(space.branch, ticket);
  if (words.length >= 1 && words.length <= 4) rename(c, space.id, nameFrom(ticket, words));
  else ask(c, space, ticket, c.world.titles?.[space.id] || c.s.titles[space.id] || "");
}

// Plus

function pickMachine(a, choices, usable) {
  if (a.machine !== undefined) {
    const mk = mkey(a.machine);
    return usable(mk) ? mk : null;
  }
  return choices[0] ?? null;
}

function addPending(c, a, entry) {
  const before = c.world.spaces.map((sp) => sp.id);
  c.s.pending.push({ group: a.group, sub: a.sub ?? null, workspace: null, ...entry, before, age: 0 });
}

// A Custom group has no folder: the space starts in the home folder of the Machine.
function plusCustom(a, c, group) {
  const usable = (mk) => a.machine !== undefined || isReady(c.world, mk);
  const machine = machineOfKey(pickMachine(a, group.machines, usable) ?? "");
  c.effects.push({ type: "start", machine, folder: "", argv: c.config.settings.agent, name: null, worktree: null });
  addPending(c, a, { machine, folder: "" });
}

// Where a Repo's new worktrees go: the Repo's own pattern, else the setting. {clone} is the main root on that Machine.
function worktreePattern(c, identity) {
  return c.config.repos?.[identity]?.worktrees || c.config.settings.worktrees;
}

function plusRepo(a, c, group, mode) {
  const ctx = c.ctx();
  const identity = a.group.slice(5);
  const usable = (mk) => !!ctx.cloned[mk]?.[identity] && (a.machine !== undefined || isReady(c.world, mk));
  const mk = pickMachine(a, group.machines, usable);
  if (mk === null) return toast(c.effects, `${group.name} is not cloned on a reachable Machine.`);
  const main = ctx.cloned[mk][identity];
  const machine = machineOfKey(mk);
  let folder = main;
  let worktree = null;
  if (mode === "worktree") {
    if (!a.branch) return toast(c.effects, "A worktree needs a branch name.");
    const filled = worktreePattern(c, identity).replaceAll("{clone}", main).replaceAll("{branch}", a.branch).replaceAll("{repo}", identity.split("/").pop());
    folder = cleanPath(isAbsolutePath(filled) ? filled : joinPath(main, filled));
    worktree = { main, branch: a.branch, path: folder, from: c.config.repos?.[identity]?.from || null };
  }
  c.effects.push({ type: "start", machine, folder, argv: c.config.settings.agent, name: null, worktree });
  // Always remembered, so the new space shows in this Group at once instead of loose until git answers.
  addPending(c, a, { machine, folder });
}

function isClaude(argv) {
  const base = String(argv?.[0] ?? "").split(/[\/\\]/).pop().toLowerCase();
  return base === "claude" || base === "claude.exe";
}

function workspaceArgv(c, ws, mk, home) {
  const agent = c.config.settings.agent;
  if (!agent || !isClaude(agent)) return agent;
  const win = isWindowsPath(mk, c.world.local);
  const known = c.ctx().cloned[mk] || {};
  const extra = ws.repos.map((id) => known[id]).filter((p) => p && !samePath(p, home, win) && !isUnder(p, home, win));
  if (!extra.length) return agent;
  const argv = [...agent, ...extra.flatMap((p) => ["--add-dir", p])];
  return win ? argv : ["env", "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1", ...argv];
}

function plusWorkspace(a, c, group, mode) {
  if (mode === "worktree") return toast(c.effects, "A Workspace has no single Repo to make a worktree in.");
  const ctx = c.ctx();
  const ws = ctx.wsByName.get(a.group.slice(3));
  const home = (mk) => workspaceHome(ws, mk, ctx.cloned, ctx.local);
  const usable = (mk) => !!home(mk) && (a.machine !== undefined || isReady(c.world, mk));
  const mk = pickMachine(a, group.machines, usable);
  if (mk === null) return toast(c.effects, `${ws.name} has no Workspace home on a reachable Machine.`);
  const folder = home(mk);
  const machine = machineOfKey(mk);
  c.effects.push({ type: "start", machine, folder, argv: workspaceArgv(c, ws, mk, folder), name: ws.name, worktree: null });
  addPending(c, a, { machine, folder, workspace: ws.name });
}

function doPlus(a, c) {
  const group = c.tree().tree.groups.find((g) => g.id === a.group);
  if (!group || (a.sub != null && !group.subgroups.some((s) => s.id === a.sub))) return;
  const mode = a.mode ?? c.config.settings.plus;
  if (group.kind === "custom") plusCustom(a, c, group);
  else if (group.kind === "repo") plusRepo(a, c, group, mode);
  else plusWorkspace(a, c, group, mode);
}

const HANDLERS = {
  sync: doSync, move: doMove, drop: doDrop, dropGroup: doDropGroup,
  select: doSelect, next: doStep, prev: doStep, plus: doPlus,
  fold: doFold, foldFocused: doFoldFocused, sort: doSort, settings: doSettings, groupSettings: doGroupSettings,
  addCustom: doAddCustom, renameGroup: doRenameGroup, removeCustom: doRemoveCustom,
  addSub: doAddSub, renameSub: doRenameSub, removeSub: doRemoveSub,
  dismiss: doDismiss, name: doName, named: doNamed,
};

export function act(action, world, config, state) {
  const handler = HANDLERS[action?.type];
  if (!handler) return { state, effects: [] };
  const prev = copyState(state);
  let built = null;
  let ctx = null;
  const c = {
    world, config, prev, s: copyState(state), effects: [],
    ctx: () => (ctx ||= context(world, config, prev)),
    tree: () => (built ||= buildTree(c.ctx())),
  };
  handler(action, c);
  const same = JSON.stringify(c.s) === JSON.stringify(state);
  return { state: same ? state : c.s, effects: c.effects };
}
