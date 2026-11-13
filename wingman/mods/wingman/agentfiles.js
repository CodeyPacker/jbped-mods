// The "Agent files" list (the Edit tab's third left-column mode) and Review's one-line backfill
// note, from the session log source (sessionlog.js): what main.js draws, kept pure so it can be
// tested. agentview.js gathers the logs and draws.
import { ownerOf } from "./roots.js";
import { ordered } from "./sessionlog.js";

/** The list shows at most this many rows. */
export const MAX_ROWS = 300;

/** Several agents' results as one list, newest first: the same reduction over every agent's files. */
export function mergeResults(results) {
  const files = new Map();
  for (const r of results) for (const f of r?.files ?? []) {
    const g = files.get(f.path);
    if (!g) { files.set(f.path, { ...f }); continue; }
    g.read ||= f.read; g.edited ||= f.edited; g.created ||= f.created;
    if (f.lastAt != null && (g.lastAt == null || f.lastAt > g.lastAt)) g.lastAt = f.lastAt;
  }
  return ordered(files);
}

/** "read", "edited" or "new" for a file's row. */
export const markOf = (f) => (f.created ? "new" : f.edited ? "edited" : "read");

/** "now", "42s", "5m", "3h", "2d" since `at` (ms); "" when unknown. */
export function relTime(at, now = Date.now()) {
  if (at == null) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * The list's rows: each file with its root (`store`, one of the space's `roots`: { root, on, plain })
 * and path relative to it, or `store` null for a file outside every root (shown, not openable).
 * `on`: the space's machine. `own(store, rel)` gives a file its one identity (main.js own).
 */
export function listRows(files, roots, on = null, own = (s, r) => [s, r], max = MAX_ROWS) {
  const out = [];
  for (const f of files.slice(0, max)) {
    const o = ownerOf(roots, f.path, on);
    if (!o || !o.rel) { out.push({ key: `x|${f.path}`, file: f, store: null, rel: f.path, mark: markOf(f) }); continue; }
    const [store, rel] = own(o.root, o.rel);
    out.push({ key: `${store.root}|${rel}`, file: f, store, rel, mark: markOf(f) });
  }
  return out;
}

/**
 * The files the agent edited (log) that Review has no record of: in a repo (not a plain folder),
 * not among Review's files (`reviewed`: keys "<root>|<rel>"). `dirty(store)`: that repo's changed
 * paths (a Set), so only files still under Changes count.
 */
export function unrecorded(rows, reviewed, dirty) {
  return rows.filter((r) => r.store && !r.store.plain && r.file.edited && !reviewed.has(r.key) && dirty(r.store)?.has(r.rel));
}

/** Review's note for `n` such files, or null when there are none. */
export const backfillText = (n) => (n > 0 ? `${n} file${n === 1 ? " was" : "s were"} edited by the agent without the hook; they appear under Changes` : null);

/** The head line of the list: how many agents, and what's uncertain about their logs. */
export function headLine({ agents = 0, results = [], enabled = true }) {
  if (!enabled) return "The session log source is off (⚙ Settings)";
  if (!agents) return "No Claude agent in this space";
  const errs = results.filter((r) => r?.error), none = results.filter((r) => r && !r.log && !r.error);
  const parts = [];
  if (results.some((r) => r?.ambiguous)) parts.push("several Claudes share this folder: showing the newest log");
  if (results.some((r) => r?.partial)) parts.push("long log: its last part only");
  if (errs.length) parts.push(errs[0].error);
  else if (none.length === results.length && results.length) parts.push("no session log found yet");
  return parts.join(" · ");
}

/**
 * Whether a copy reads the logs now: the setting is on, a space is shown, and the copy shows the
 * list (Edit with Agent files in the left column) or Review, and is on screen (`visible`).
 */
export function wants({ enabled, space, mode, left, column, visible }) {
  if (!enabled || !space || !visible) return null;
  if (mode === "edit" && column && left === "agent") return "edit";
  if (mode === "review") return "review";
  return null;
}
