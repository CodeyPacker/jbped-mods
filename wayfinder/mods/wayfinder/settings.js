// Settings edits to wayfinder.json (#17). Pure: no Herdr imports. Each function takes the raw config
// and returns a changed copy, so the original stays as read. Only the named Profile changes.
const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b); // case-insensitive in any engine

const clone = (v) => JSON.parse(JSON.stringify(v));

function edit(raw, profileName, fn) {
  const out = clone(raw);
  const p = out.profiles?.[profileName];
  if (!p) throw new Error(`No profile "${profileName}"`);
  fn(p);
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Whether a Board config shows a discovered Board. An Azure config without "board" means the team's
// first board, which `firstOfTeam` says.
export function showsBoard(cfg, accountId, found, firstOfTeam = false) {
  if (cfg.account !== accountId) return false;
  const a = cfg.ref ?? {}, b = found.ref;
  if ("list" in b) return String(a.list) === String(b.list);
  if ("team" in b) {
    return a.project === b.project && a.team === b.team && (a.board == null ? firstOfTeam : a.board === b.board);
  }
  return same({ owner: a.owner, number: a.number }, { owner: b.owner, number: b.number });
}

// A Board id from its title, unique in the Profile.
export function boardId(title, taken) {
  const base = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "board";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function followBoard(raw, profileName, accountId, found) {
  return edit(raw, profileName, (p) => {
    p.boards ??= [];
    const id = boardId(found.title, new Set(p.boards.map((b) => b.id)));
    // found.ref names the board, so the config keeps showing it even if the team's default changes.
    p.boards.push({ id, account: accountId, name: found.title, ref: clone(found.ref) });
  });
}

export function unfollowBoard(raw, profileName, id) {
  return edit(raw, profileName, (p) => { p.boards = (p.boards ?? []).filter((b) => b.id !== id); });
}

// An empty list removes the field: the Board shows the Provider's own columns.
export function setTrackedStatuses(raw, profileName, id, statuses) {
  return edit(raw, profileName, (p) => {
    const b = (p.boards ?? []).find((x) => x.id === id);
    if (!b) throw new Error(`No board "${id}"`);
    if (statuses?.length) b.trackedStatuses = [...statuses]; else delete b.trackedStatuses;
  });
}

// Ticks or unticks a status, keeping the order of the rest. A new one goes last.
export const toggleStatus = (list, s) => (list.includes(s) ? list.filter((x) => x !== s) : [...list, s]);

// Moves item i by `by` places, within bounds.
export function move(list, i, by) {
  const j = i + by;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

function prRepos(raw, profileName, accountId, fn) {
  return edit(raw, profileName, (p) => {
    const a = (p.accounts ?? []).find((x) => x.id === accountId);
    if (!a) throw new Error(`No account "${accountId}"`);
    const f = { mode: "all", selected: [], ignored: [], ...(a.prRepos ?? {}) };
    fn(f);
    const out = { mode: f.mode };
    if (f.selected.length) out.selected = f.selected;
    if (f.ignored.length) out.ignored = f.ignored;
    if (out.mode === "all" && !out.selected && !out.ignored) delete a.prRepos; else a.prRepos = out;
  });
}

// "all", "selected" or "ignored". Both lists stay as they are.
export function setRepoMode(raw, profileName, accountId, mode) {
  if (!["all", "selected", "ignored"].includes(mode)) throw new Error(`Unknown repo mode "${mode}"`);
  return prRepos(raw, profileName, accountId, (f) => { f.mode = mode; });
}

// Ticks or unticks a repo in the current mode's list (selected or ignored), kept sorted.
export function toggleRepo(raw, profileName, accountId, repo) {
  return prRepos(raw, profileName, accountId, (f) => {
    if (f.mode === "all") throw new Error("Choose Selected or Ignored first");
    const list = f[f.mode];
    f[f.mode] = list.includes(repo) ? list.filter((r) => r !== repo) : [...list, repo].sort(byName);
  });
}

// Background checks (#1): { enabled, minutes }, only the given fields written. At the defaults
// (enabled, every 5 minutes) the object goes. Checking the values is parseConfig's job.
export const NOTIFY_DEFAULTS = { enabled: true, minutes: 5 };
export function setNotifications(raw, profileName, { enabled, minutes } = {}) {
  return edit(raw, profileName, (p) => {
    const n = { ...(p.notifications ?? {}) };
    if (enabled !== undefined) n.enabled = enabled;
    if (minutes !== undefined) n.minutes = minutes;
    if ((n.enabled ?? NOTIFY_DEFAULTS.enabled) === NOTIFY_DEFAULTS.enabled && (n.minutes ?? NOTIFY_DEFAULTS.minutes) === NOTIFY_DEFAULTS.minutes && Object.keys(n).every((k) => k in NOTIFY_DEFAULTS)) delete p.notifications;
    else p.notifications = n;
  });
}

// Repos to list for a search: ticked ones first, then up to `limit` matches.
export function repoRows(all, ticked, query, limit = 50) {
  const q = String(query ?? "").trim().toLowerCase();
  const f = new Set(ticked);
  const extra = ticked.filter((r) => !all.includes(r));
  const rest = all.filter((r) => !f.has(r) && (!q || r.toLowerCase().includes(q)));
  return { rows: [...ticked.filter((r) => all.includes(r)), ...extra, ...rest.slice(0, limit)], hidden: Math.max(0, rest.length - limit) };
}

// Profiles and Accounts. A Profile's name is also its cache file and az login folder, so it can't be renamed.
export const PROFILE_NAME = /^[A-Za-z0-9_-]{1,32}$/;

export function addProfile(raw, name, runner) {
  if (!PROFILE_NAME.test(name)) throw new Error("A profile name uses letters, digits, - and _ (up to 32)");
  if (raw.profiles?.[name]) throw new Error(`Profile "${name}" already exists`);
  const out = clone(raw);
  out.profiles ??= {};
  out.profiles[name] = { ...(runner ? { runner } : {}), accounts: [], repos: [], boards: [] };
  return out;
}

// The last Profile stays. Removing the active one makes the first other one active.
export function removeProfile(raw, name) {
  const names = Object.keys(raw.profiles ?? {});
  if (!names.includes(name)) throw new Error(`No profile "${name}"`);
  if (names.length < 2) throw new Error("The last profile can't be removed");
  const out = clone(raw);
  delete out.profiles[name];
  if ((out.activeProfile ?? names[0]) === name) out.activeProfile = Object.keys(out.profiles)[0];
  return out;
}

export function accountId(provider, name, taken) {
  if (provider === "clickup") {
    let id = "cu";
    for (let n = 2; taken.has(id); n++) id = `cu-${n}`;
    return id;
  }
  const base = `${provider === "azure" ? "ado" : "gh"}-${String(name).toLowerCase().replace(/^https:\/\/(dev\.azure\.com\/)?/, "").replace(/\.visualstudio\.com.*$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// account: { provider: "github", login }, { provider: "azure", org } or { provider: "clickup" }.
// Checking it is parseConfig's job.
export function addAccount(raw, profileName, account) {
  return edit(raw, profileName, (p) => {
    p.accounts ??= [];
    if (account.provider === "clickup") {
      // One token per variable: a second ClickUp Account needs its own tokenEnv, set in the file.
      const env = account.tokenEnv ?? "CLICKUP_API_TOKEN";
      if (p.accounts.some((a) => a.provider === "clickup" && (a.tokenEnv ?? "CLICKUP_API_TOKEN") === env)) throw new Error("This profile has a ClickUp account already");
      p.accounts.push({ id: accountId("clickup", "", new Set(p.accounts.map((a) => a.id))), provider: "clickup", ...(account.tokenEnv ? { tokenEnv: account.tokenEnv } : {}) });
      return;
    }
    const key = account.provider === "azure" ? "org" : "login";
    const value = String(account[key] ?? "").trim().replace(/\/+$/, "");
    if (!value) throw new Error(account.provider === "azure" ? "Enter the organization URL" : "Enter the GitHub user name");
    if (p.accounts.some((a) => a.provider === account.provider && String(a[key]).toLowerCase() === value.toLowerCase())) throw new Error("That account is already in this profile");
    const id = accountId(account.provider, value, new Set(p.accounts.map((a) => a.id)));
    p.accounts.push(account.provider === "azure" ? { id, provider: "azure", org: value, projects: [] } : { id, provider: "github", login: value });
  });
}

// Removing an Account removes its Boards too.
export function removeAccount(raw, profileName, id) {
  return edit(raw, profileName, (p) => {
    p.accounts = (p.accounts ?? []).filter((a) => a.id !== id);
    p.boards = (p.boards ?? []).filter((b) => b.account !== id);
  });
}

// Renames a Profile in place (its position stays) and follows it with activeProfile. The caller moves
// what is keyed by the name: the cache file, the az login folder, remembered view state.
export function renameProfile(raw, from, to) {
  if (!raw.profiles?.[from]) throw new Error(`No profile "${from}"`);
  if (from === to) return clone(raw);
  if (!PROFILE_NAME.test(to)) throw new Error("A profile name uses letters, digits, - and _ (up to 32)");
  if (raw.profiles[to]) throw new Error(`Profile "${to}" already exists`);
  const out = clone(raw);
  out.profiles = Object.fromEntries(Object.entries(out.profiles).map(([k, v]) => [k === from ? to : k, v]));
  if ((raw.activeProfile ?? Object.keys(raw.profiles)[0]) === from) out.activeProfile = to;
  return out;
}

// Moves a Profile up or down. The order is the switcher's order.
export function moveProfile(raw, name, by) {
  const names = Object.keys(raw.profiles ?? {});
  const i = names.indexOf(name);
  if (i < 0) throw new Error(`No profile "${name}"`);
  const order = move(names, i, by);
  const out = clone(raw);
  out.profiles = Object.fromEntries(order.map((k) => [k, out.profiles[k]]));
  if (out.activeProfile == null) out.activeProfile = names[0]; // the first was active by default: keep it
  return out;
}

// A Board list for a search: matches by title, without regard to case.
export const matchBoards = (list, query) => {
  const q = String(query ?? "").trim().toLowerCase();
  return q ? list.filter((d) => d.title.toLowerCase().includes(q)) : list;
};

// Adds a local clone to the Profile's repos (D17), or finds the one with that path. With a Board, the
// Board lists it. With prRepo, it is the clone of that Pull Request repo. Returns { raw, id }.
export function addRepo(raw, profileName, { path, prRepo = null, boardId = null }) {
  let id = null;
  const out = edit(raw, profileName, (p) => {
    p.repos ??= [];
    const clean = String(path ?? "").trim().replace(/[\\/]+$/, "");
    if (!clean) throw new Error("Pick the repo's folder");
    let r = p.repos.find((x) => x.path === clean);
    if (!r) {
      const base = clean.split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
      const taken = new Set(p.repos.map((x) => x.id));
      id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      r = { id, path: clean };
      p.repos.push(r);
    }
    id = r.id;
    if (prRepo) r.prRepo = prRepo;
    if (boardId) {
      const b = (p.boards ?? []).find((x) => x.id === boardId);
      if (!b) throw new Error(`No board "${boardId}"`);
      b.repos ??= [];
      if (!b.repos.includes(id)) b.repos.push(id);
    }
  });
  return { raw: out, id };
}

// A Repo's Checkout mode for Reviews: "worktree" (the default, so the field goes) or "branch".
export function setRepoCheckout(raw, profileName, repoId, mode) {
  if (!["worktree", "branch"].includes(mode)) throw new Error(`Unknown checkout mode "${mode}"`);
  return edit(raw, profileName, (p) => {
    const r = (p.repos ?? []).find((x) => x.id === repoId);
    if (!r) throw new Error(`No repo "${repoId}"`);
    if (mode === "worktree") delete r.checkout; else r.checkout = mode;
  });
}

// Removes a Repo, and its id from every Board's repos.
export function removeRepo(raw, profileName, repoId) {
  return edit(raw, profileName, (p) => {
    if (!(p.repos ?? []).some((x) => x.id === repoId)) throw new Error(`No repo "${repoId}"`);
    p.repos = p.repos.filter((x) => x.id !== repoId);
    for (const b of p.boards ?? []) if (Array.isArray(b.repos)) b.repos = b.repos.filter((id) => id !== repoId);
  });
}
