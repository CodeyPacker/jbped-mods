// Capture's decisions, one record per repo (store identity: machine + root), shared by every
// reviewed space that includes the repo. Pure: no Herdr imports; capturePass takes the Capture.

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
