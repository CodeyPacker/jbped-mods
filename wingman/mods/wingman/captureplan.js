// Capture's decisions, one record per repo (store identity: machine + root), shared by every
// reviewed space that includes the repo. No Herdr calls: capturePass takes the Capture, and the
// only import is capture.js's tailText, which caps error texts.
import { tailText } from "./capture.js";

/**
 * Each repo's capture state from the spaces that include it and the agents' statuses.
 * `spaces`: [{ id, roots: [key] }], the reviewed spaces and their repos' record keys.
 * `agents`: [{ address, space, app, status }]. `active`: the statuses of an agent in a turn.
 * Returns Map key -> { spaces, active, by, space }:
 * - active: an agent is working in any space that includes the repo.
 * - by: the working agent when it is the only one there and a Claude (its hook delivers rejection
 *   feedback, even for edits made through Bash), else null.
 * - space: the working agents' space when they are all in one. Working agents in several spaces
 *   give null: an edit can't be told apart, and an entry without a space shows in every space
 *   (store.shows) rather than being hidden from the space whose agent made it. With nobody
 *   working: the one space that includes the repo, else null.
 */
export function capturePlan(spaces, agents, active) {
  const out = new Map();
  for (const sp of spaces) for (const k of sp.roots) {
    const r = out.get(k) ?? { spaces: [] };
    if (!r.spaces.includes(sp.id)) r.spaces.push(sp.id);
    out.set(k, r);
  }
  for (const r of out.values()) {
    const working = agents.filter((a) => r.spaces.includes(a.space) && active.has(a.status));
    const homes = [...new Set(working.map((a) => a.space))];
    r.active = working.length > 0;
    r.by = working.length === 1 && working[0].app === "claude-code" ? working[0].address : null;
    r.space = r.active ? (homes.length === 1 ? homes[0] : null) : (r.spaces.length === 1 ? r.spaces[0] : null);
  }
  return out;
}

/**
 * Applies a repo's plan entry `p` to its record `c`. `by` and `space` follow the working agents
 * and are kept after the turn ends, so the last pass is credited too (a new record takes them at
 * once). Returns "started" or "stopped" when the record's working state changed, else null.
 */
export function applyPlan(c, p) {
  if (p.active || c.fresh) { c.by = p.by; c.space = p.space; c.fresh = false; }
  c.spaces = p.spaces;
  if (p.active === !!c.active) return null;
  c.active = p.active;
  if (!p.active) c.after = true;
  return p.active ? "started" : "stopped";
}

/**
 * One capture pass for a repo's record `c` ({ capture, active, after, by, space, last }). With no
 * saved snapshot: take one while active, else nothing is left to do. With one, and not starting:
 * adopt files changed since it, and clear it once nobody works on the repo. The snapshot lives in
 * capture.json, so a new leader or a reloaded pane carries on where it was. On another machine a
 * pass whose snapshot is the last one's adopts nothing new: skipped (c.last).
 */
export async function capturePass(c, starting = false, log = () => {}) {
  const remote = !!c.capture.store?.on;
  const st = await c.capture.state();
  if (!st.tree) {
    if (c.active) { const tree = await c.capture.snapshot(); await c.capture.setState({ tree, since: Date.now() }); c.last = tree; log(`snapshot ${tree}`); }
    else c.after = false;
  } else if (!starting) {
    const now = await c.capture.snapshot();
    if (!(remote && now === c.last)) {
      const added = await c.capture.adopt(st.tree, now, c.by, c.space);
      if (added) log(`adopted ${added} files${remote ? ` on ${c.capture.store.on}` : ""}`);
    }
    c.last = now;
    if (!c.active) { await c.capture.setState({ tree: null }); c.after = false; }
  }
}

// ---- failing repos ------------------------------------------------------------------------------
// A record whose pass throws gets `fail` ({ message, since, at, count }): retried on a slower
// schedule (retryMs) so a broken repo doesn't cost a snapshot every 3 s, and reported once when it
// starts failing and once when it recovers. Other records' passes never wait for it.

export const RETRY_MIN = 3000, RETRY_MAX = 60000;

/** How long after its `count`th failure in a row a repo is tried again: 3 s, doubling, at most 60 s. */
export const retryMs = (count) => Math.min(RETRY_MAX, RETRY_MIN * 2 ** Math.max(0, count - 1));

/** Whether a record with failure state `fail` (`at`: when the last failed pass started) is due a
 *  pass at `now`, less a second so a timer tick that comes a little early isn't missed. A turn start
 *  (`starting`) always is: a missed snapshot loses the turn's baseline. */
export const passDue = (fail, now, starting = false) => !fail || starting || now - fail.at >= retryMs(fail.count) - 1000;

/**
 * capturePass for record `c`, isolated: an error is kept on `c.fail` (message capped by tailText)
 * rather than thrown, and cleared by the next pass that succeeds. A failing record not yet due
 * (passDue) is skipped. `clock()` gives the time. Returns "skipped", "failed" or "ok".
 */
export async function tryPass(c, starting = false, log = () => {}, clock = Date.now) {
  if (!passDue(c.fail, clock(), starting)) return "skipped";
  const root = c.capture.store?.root ?? "repo", start = clock();
  try { await capturePass(c, starting, log); }
  catch (e) {
    const message = tailText(e?.message ?? e) || "unknown error";
    if (!c.fail) { c.fail = { message, since: start, at: start, count: 1 }; log(`${root}: capture failing: ${message}`); }
    else c.fail = { ...c.fail, message, at: start, count: c.fail.count + 1 };
    return "failed";
  }
  if (c.fail) { log(`${root}: capture recovered after ${c.fail.count} failed pass${c.fail.count === 1 ? "" : "es"}`); c.fail = null; }
  return "ok";
}

/** The failing records of `records` (Map key -> record), as the leader shares them: key -> { root, on, spaces, message, since, count }. */
export function captureErrors(records) {
  const out = {};
  for (const [k, c] of records) if (c.fail) {
    const st = c.capture.store ?? {};
    out[k] = { root: st.root ?? null, on: st.on ?? null, spaces: [...(c.spaces ?? [])], message: c.fail.message, since: c.fail.since, count: c.fail.count };
  }
  return out;
}

/** Shared capture errors older than this are from a leader that's gone (the leader renews them every ERRORS_RENEW ms). */
export const ERRORS_STALE = 45000, ERRORS_RENEW = 15000;

/**
 * The one-line notices a panel copy shows for the space it shows (`space`, its repos' keys `keys`):
 * one per failing repo the space includes, from the leader's shared value ({ by, at, repos }).
 * Nothing when the value is older than ERRORS_STALE.
 */
export function captureNotices(shared, space, keys, now) {
  if (!shared?.repos || !(now - (shared.at ?? 0) <= ERRORS_STALE)) return [];
  const out = [];
  for (const [k, e] of Object.entries(shared.repos)) {
    if (!(e.spaces ?? []).includes(space) && !keys.includes(k)) continue;
    const name = String(e.root ?? k).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    const last = String(e.message ?? "").split(/\r?\n/).filter((l) => l.trim()).pop() ?? "";
    out.push({ key: k, text: `${name}${e.on ? ` on ${e.on}` : ""}: capture failing${last ? ` \u2014 ${last}` : ""} (retrying)` });
  }
  return out;
}
