// The cache (D25): each Profile's last Board data in data/wayfinder-cache-<profile>.json, shown at
// once on open and replaced by a background refresh. Pull Requests are cached the same way, once per Profile.
export const POLL_MS = 30 * 60 * 1000; // refresh while shown
export const SHOW_GAP_MS = 60 * 1000; // a refresh on show skips data newer than this
const VERSION = 1;

export const cacheFile = (home, profile) =>
  `${home}/data/wayfinder-cache-${String(profile).replace(/[^A-Za-z0-9._-]/g, "_")}.json`;

// A Board's entry is only valid for the same Account and ref: a reused Board id doesn't show stale data.
const boardKey = (b) => JSON.stringify([b.account, b.ref]);

export function parseCache(text) {
  try {
    const c = JSON.parse(text);
    if (c?.version === VERSION && c.boards && typeof c.boards === "object" && !Array.isArray(c.boards)) return c;
  } catch { /* missing or broken: start empty */ }
  return { version: VERSION, boards: {} };
}

export const serializeCache = (cache) => JSON.stringify(cache) + "\n";

// The cached { at, data } for a Board config, or null.
export function cachedBoard(cache, b) {
  const e = cache.boards[b.id];
  return e && e.key === boardKey(b) && typeof e.at === "number" && e.data ? { at: e.at, data: e.data } : null;
}

// The cache with a Board's data at time `at`. Newer data already there (another copy wrote it) wins.
// Boards no longer in the Profile drop out.
export function withBoard(cache, boards, b, data, at) {
  const out = {};
  for (const x of boards) if (cache.boards[x.id]?.key === boardKey(x)) out[x.id] = cache.boards[x.id];
  const prev = out[b.id];
  if (!(prev && prev.at > at)) out[b.id] = { key: boardKey(b), at, data };
  return { ...cache, version: VERSION, boards: out };
}

// PR data is valid only for the same Accounts: `key` names them (prsKey).
export const prsKey = (accounts) => JSON.stringify(accounts.map((a) => [a.id, a.provider, a.login ?? a.org ?? null]));

export function cachedPrs(cache, key) {
  const e = cache.prs;
  return e && e.key === key && typeof e.at === "number" && Array.isArray(e.data) ? { at: e.at, data: e.data } : null;
}

export function withPrs(cache, key, data, at) {
  if (cache.prs?.key === key && cache.prs.at > at) return cache;
  return { ...cache, version: VERSION, prs: { key, at, data } };
}

export function formatAge(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// Whether the first layout node matching `match` is on screen: neither it nor an ancestor is hidden,
// and each stack on the way shows that branch. A copy outside the layout (a pane, a window) counts as shown.
export function isShown(root, match) {
  const path = (node) => {
    if (!node) return null;
    if (match(node)) return [node];
    for (const c of node.children ?? []) { const p = path(c); if (p) return [node, ...p]; }
    return null;
  };
  const p = path(root);
  if (!p) return true;
  return p.every((n, i) => {
    if (n.hidden) return false;
    const next = p[i + 1];
    if (!next || n.type !== "stack") return true;
    return (n.active ?? n.children?.[0]?.id) === next.id;
  });
}

// Whether a refresh is due: on show (`showing`) once data is SHOW_GAP_MS old, else every POLL_MS.
export function due(lastTry, now, { showing = false } = {}) {
  if (lastTry == null) return true;
  return now - lastTry >= (showing ? SHOW_GAP_MS : POLL_MS);
}
