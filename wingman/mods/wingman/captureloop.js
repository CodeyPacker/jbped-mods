// The capture loop, run by whichever Review copy leads (main.js): the lease, the 500 ms lead pass
// (each reviewed space's repos, one capture record per repo, capturePlan / applyPlan, snapshots at
// a turn's start), the 3 s collectAll pass (adopt, then store.reconcile), and the failing repos
// shared with the other copies. No UI: Herdr's state comes through the "herdr" module, the copy's
// id, log and clock through the constructor, so a test can drive it under node.
import { spaces, panes, agents, terminals, layout, hc, appHome, readTextFile, writeTextFile, shared, setShared } from "herdr";
import { Store } from "./store.js";
import { Capture, tailText } from "./capture.js";
import { capturePlan, applyPlan, capturePass, tryPass, captureErrors, ERRORS_RENEW } from "./captureplan.js";
import { layoutHasWingman, reviewedSpaces } from "./panelview.js";
import { pathKind } from "./fsx.js";
import { spaceRoots, isHome, pathFor } from "./workspace.js";
import { REMOTE, rootId, idOf } from "./remote.js";
import { Journal, drainOutbox, hookKnown } from "./journal.js";
import { crumb, ALIVE_MS } from "./crumbs.js";

// Agents count as working while they are in a turn, including while blocked on a question.
export const ACTIVE = new Set(["working", "blocked"]);

// Outside mods/: any write under a mod folder (even a hidden file) hot-reloads every copy.
export const LEADER_FILE = () => `${appHome()}/data/wingman-leader.json`;
export const LEASE_MS = 5000;

// The capture leader's failing repos, { by: leader copy, at, repos: captureErrors }, for every copy's
// one-line notice (captureNotices). Written when it changes, renewed every ERRORS_RENEW ms while a repo
// fails; a new leader overwrites it, and a value past ERRORS_STALE (a leader that's gone) isn't shown.
export const CAPTURE_ERRORS = "wingman.captureErrors";

/** Folders an agent in `space` works in, as this machine's git sees them (on another machine: as it names them). */
export function agentFolders(space) {
  const at = pathFor(space);
  return agents().filter((a) => a.space === space.id).map((a) => at(panes().find((p) => p.pane === a.pane)?.cwd
    ?? terminals().find((t) => t.address === a.address)?.cwd)).filter(Boolean);
}

/** Folders of every terminal in `space`, agents' first (Q18), as this machine's git sees them (see agentFolders). */
export function termFolders(space) {
  const tabs = new Set(space.tabs.map((t) => t.id)), at = pathFor(space);
  const all = [...agentFolders(space), ...panes().filter((p) => p.terminal && tabs.has(p.tab)).map((p) => at(p.cwd))];
  return [...new Set(all.filter(Boolean))];
}

/** The space of the agent in terminal `by`, while it's still there. */
export const spaceOfAgent = (by) => (by && agents().find((a) => a.address === by)?.space) || null;

/**
 * Spaces Wingman reviews, on this computer or another machine: every space while the layout has a
 * Wingman block (panel blocks are not in panes()), else the spaces holding a Wingman pane in a tab.
 */
export function reviewSpaces() {
  let inLayout = false;
  try { inLayout = layoutHasWingman(layout()); } catch {}
  return reviewedSpaces(spaces(), panes(), inLayout);
}

export class CaptureLoop {
  /** `id`: the copy's id (the lease's holder). `log(line)`: the capture log. `now()`: the clock. */
  constructor({ id, log, now = Date.now }) {
    this.id = id; this.log = log; this.now = now;
    this.captures = new Map();
  }

  /** A repo's store (on machine `on`), or null when the folder isn't (or isn't yet) a repo: retried after 30 s. */
  async openStore(root, on = null) {
    const id = rootId(root, on), miss = (this.misses ??= new Map()), at = miss.get(id);
    if (at && this.now() - at < 30000) return null;
    const st = await Store.open(root, on).catch(() => null);
    if (!st) { miss.set(id, this.now()); return null; }
    miss.delete(id); st.asked = root;
    return st;
  }

  /**
   * What a folder is, cached: { root } (the repo it's in), { dir: true } (a folder outside any repo)
   * or neither (gone). A home folder is never searched for a repo. Misses are checked again after 30 s.
   */
  async folderKind(folder, on = null) {
    const id = rootId(folder, on), cache = (this.resolved ??= new Map()), c = cache.get(id);
    if (c && (c.root || this.now() - c.at < 30000)) return c;
    // On another machine git's "not a repository" answer means the folder is there (a missing
    // folder can't be a git's working folder: the call rejects), which saves a second call.
    let there = false;
    const st = isHome(folder) ? null : await Store.open(folder, on).catch((e) => { there = !!on && /^not a git repository/.test(e?.message ?? ""); return null; });
    const r = { at: this.now(), root: st?.root ?? null, dir: !st && (there || (await pathKind(folder, { on })) === "dir") };
    cache.set(id, r);
    return r;
  }

  /** The space's terminal folders as repo roots and plain folders. */
  async folderRoots(sp) {
    const repos = [], plain = [];
    for (const dir of termFolders(sp)) {
      const r = await this.folderKind(dir, sp.machine ?? null);
      if (r.root) { if (!repos.includes(r.root)) repos.push(r.root); } else if (r.dir) plain.push(dir);
    }
    return { repos, plain };
  }

  /** Renews or takes the capture lease; true while this copy holds it. */
  async leader() {
    const path = LEADER_FILE(), text = await readTextFile(path), now = this.now();
    const lease = text ? JSON.parse(text) : null;
    if (lease && lease.id !== this.id && now - lease.at < LEASE_MS) return false;
    try { await writeTextFile(path, JSON.stringify({ id: this.id, at: now }), text); return true; }
    catch { return false; } // another copy renewed or took it first
  }

  /**
   * Sets isLeader from the lease. Runs at the start of each lead() and every second on its own: a
   * lead() pass can outlast LEASE_MS (store opens, snapshots), and a lease left unrenewed meanwhile
   * would let another copy lead while this one still runs its pass and collectAll. One call at a
   * time, so this copy's own renewals never fail each other's compare-and-swap.
   */
  async lease() {
    if (this.leasing) return this.isLeader;
    this.leasing = true;
    try { this.isLeader = await this.leader(); this.logStep("lease", null); }
    catch (e) { this.isLeader = false; this.logStep("lease", e); }
    finally { this.leasing = false; }
    return this.isLeader;
  }

  /**
   * A capture step's error that isn't a repo's (lease, hook events, outbox, a space's lookup): logged
   * when it starts or changes and once when it clears (`e` null), never shown as the panel's error.
   */
  logStep(key, e) {
    const m = (this.stepErrors ??= new Map()), msg = e == null ? null : tailText(e.message ?? e) || "error";
    if (msg === (m.get(key) ?? null)) return;
    if (msg) { m.set(key, msg); this.log(`${key} error ${msg}`); } else { m.delete(key); this.log(`${key} ok again`); }
  }

  /**
   * Every 500 ms: agent status is cheap, and a snapshot must land before the first edit. Each step
   * and each space's lookup is caught on its own: one failing never stops the rest of the pass.
   */
  async lead(cx) {
    if (this.leading) return;
    this.leading = true;
    const log = this.log;
    try {
      if (!(await this.lease())) return;
      this.journal ??= new Journal(log);
      try { await this.journal.drain(); this.logStep("hook events", null); } catch (e) { this.logStep("hook events", e); }
      try {
        await drainOutbox((t) => agents().some((a) => a.address === t && ACTIVE.has(a.status)),
          (t, text) => hc(["send", t, text]), log);
        this.logStep("outbox", null);
      } catch (e) { this.logStep("outbox", e); }
      const reviewed = reviewSpaces(), groups = (this.groups ??= new Map());
      for (const id of [...groups.keys()]) if (!reviewed.some((sp) => sp.id === id)) groups.delete(id);
      for (const sp of reviewed) {
        if (!this.isLeader) return; // the lease was lost during this pass
        // W1: capture follows every repo of the space's workspace. Its repos are looked up again
        // every 5 s (cached stores are reused), never while an agent is starting a turn. A group
        // holds the space's repos (keys into this.captures) and whether an agent there works.
        const g = groups.get(sp.id) ?? { active: false, at: 0, keys: [] };
        groups.set(sp.id, g);
        const active = agents().some((a) => a.space === sp.id && ACTIVE.has(a.status));
        // Another machine: nothing is looked up there for a space that isn't shown and has no agent
        // working (every call there costs about 200 ms). Its repos stay as last looked up, and
        // captures already made finish their last pass.
        if (sp.machine && !active && !g.active && !sp.active) continue;
        // Any space: with no agent at all, nothing is looked up or opened unless it is shown.
        if (!active && !g.active && !sp.active && !agents().some((a) => a.space === sp.id)) continue;
        if (!g.at || (active === g.active && this.now() - g.at > 5000)) try {
          g.at = this.now();
          const on = sp.machine ?? null, { repos } = await this.folderRoots(sp);
          const { roots } = await spaceRoots(sp, repos);
          const keys = [], alias = (this.capAlias ??= new Map());
          for (const root of roots) {
            // One record per repo (its store's id), whichever space or path found it first.
            let key = alias.get(rootId(root, on));
            if (!key || !this.captures.has(key)) {
              const store = await this.openStore(root, on);
              if (!store) continue;
              key = idOf(store); alias.set(rootId(root, on), key);
              if (!this.captures.has(key)) {
                log(`${sp.name}: capturing ${store.root}${store.on ? ` on ${store.on}` : ""}`);
                // after: a capture on another machine checks its saved state once (a pass may be left over).
                this.captures.set(key, { capture: new Capture(store, log), spaces: [], active: false, busy: false, by: null, space: null, fresh: true, after: !!store.on });
              }
            }
            if (!keys.includes(key)) keys.push(key);
          }
          g.keys = keys;
          if (!keys.length && !this.noRepo?.has(sp.id)) { (this.noRepo ??= new Set()).add(sp.id); log(`${sp.name}: no repo in ${JSON.stringify(agentFolders(sp))}`); }
          this.logStep(`${sp.name}: repo lookup`, null);
        } catch (e) { this.logStep(`${sp.name}: repo lookup`, e); } // its repos stay as last looked up; tried again in 5 s
        if (active !== g.active) {
          g.active = active;
          log(`${sp.name}: agent ${active ? "working" : "stopped"} (${g.keys.map((k) => this.captures.get(k)?.capture.store.root).filter(Boolean).join(", ")})`);
        }
      }
      // Each repo's record from every space that includes it: working while an agent works in any
      // of them, so one space's idle agent never clears the snapshot another's turn depends on.
      const plan = capturePlan([...groups].map(([id, g]) => ({ id, roots: g.keys })), agents(), ACTIVE);
      // A repo that left every space (removed, its space gone or no longer reviewed) ends its working
      // period: one last pass (adopts what changed since the previous one, clears the saved snapshot),
      // so adding it again later starts a new period instead of adopting what changed while it was out.
      for (const [k, c] of this.captures) if (!plan.has(k)) {
        this.captures.delete(k); log(`stopped capturing ${c.capture.store.root}`);
        c.active = false; (this.ending ??= new Set()).add(c);
      }
      const started = [];
      for (const [k, p] of plan) {
        const c = this.captures.get(k);
        if (!c) continue;
        const change = applyPlan(c, p);
        if (change === "started") started.push(c);
        if (change) { log(`${c.capture.store.root}: ${change === "started" ? "working" : "idle"}`); cx.notify(); }
      }
      // Every repo's snapshot at once: a turn waits for the slowest, not the sum.
      if (started.length) await Promise.all(started.map((c) => this.collect(c, cx, true)));
      // A record whose pass is running ends at a later tick.
      const ends = [...(this.ending ?? [])].filter((c) => !c.busy);
      for (const c of ends) this.ending.delete(c);
      if (ends.length) await Promise.all(ends.map((c) => this.end(c)));
    } catch (e) { this.logStep("lead", e); }
    finally { this.leading = false; }
  }

  async collectAll(cx) {
    if (!this.isLeader) return;
    const now = this.now();
    // On another machine: a pass only while an agent works and once after, at most every REMOTE.captureMs.
    const due = (c) => !c.capture.store.on || ((c.active || c.after) && now - (c.at ?? 0) >= REMOTE.captureMs);
    // Grouped by machine: a machine's hook events are applied before its captures' passes, so the
    // two never write a review index at once (the journal adds `by` to what capture already took).
    const byOn = new Map([[null, []]]);
    for (const c of this.captures.values()) {
      if (!due(c)) continue;
      c.at = now;
      const on = c.capture.store.on ?? null;
      if (!byOn.has(on)) byOn.set(on, []);
      byOn.get(on).push(c);
    }
    const journals = this.journalsDue(now);
    for (const on of journals) if (!byOn.has(on)) byOn.set(on, []);
    await Promise.all([...byOn].map(async ([on, caps]) => {
      if (on && journals.has(on)) await this.drainMachine(on, cx);
      await Promise.all(caps.map((c) => this.collect(c, cx)));
    }));
    // Each repo's index once: branch parking and committed changes (store.reconcile). On another
    // machine every REMOTE.reconcileMs, and only for a space that's shown or has an agent working.
    const seen = new Set();
    for (const c of this.captures.values()) {
      const st = c.capture.store, id = idOf(st);
      if (seen.has(id)) continue;
      seen.add(id);
      if (st.on) {
        if (!(c.active || spaces().some((s) => s.active && c.spaces.includes(s.id))) || now - (st.reconciledAt ?? 0) < REMOTE.reconcileMs) continue;
        st.reconciledAt = now;
      }
      await st.reconcile(spaceOfAgent).catch((e) => this.log(`reconcile ${st.root}: ${e.message ?? e}`));
    }
  }

  /**
   * Machines whose Claude hook events are due: those with a reviewed space (reviewSpaces) that has an
   * agent, while such a space is shown or an agent there works, and once after. At most every
   * REMOTE.journalMs (REMOTE.journalIdleMs while the hook isn't installed there); an idle hidden
   * machine costs nothing.
   */
  journalsDue(now) {
    const out = new Set(), want = new Map();
    for (const sp of reviewSpaces()) {
      if (!sp.machine) continue;
      const here = agents().filter((a) => a.space === sp.id);
      if (!here.length) continue;
      want.set(sp.machine, want.get(sp.machine) || sp.active || here.some((a) => ACTIVE.has(a.status)));
    }
    this.journals ??= new Map();
    for (const [on, live] of want) {
      const j = this.journals.get(on) ?? { at: 0, after: false, busy: false };
      this.journals.set(on, j);
      if (live) j.after = true;
      else if (!j.after) continue;
      if (j.busy || now - j.at < (hookKnown(on) === false ? REMOTE.journalIdleMs : REMOTE.journalMs)) continue;
      if (!live) j.after = false; // the pass after the space was left or its agents stopped
      j.at = now;
      out.add(on);
    }
    for (const on of [...this.journals.keys()]) if (!want.has(on)) this.journals.delete(on);
    return out;
  }

  /** One pass over machine `on`'s hook events (journal.drainOn). */
  async drainMachine(on, cx) {
    const j = this.journals.get(on);
    if (!j || j.busy) return;
    j.busy = true;
    try {
      this.journal ??= new Journal(this.log);
      const r = await this.journal.drainOn(on);
      if (r.events) this.log(`hook events on ${on}: ${r.events} read, ${r.adopted} files added`);
    } catch (e) { this.log(`hook events on ${on}: ${e.message ?? e}`); }
    finally { j.busy = false; }
  }

  /**
   * One capture pass for a repo's record, one at a time per record. A failing repo keeps its error on
   * the record and is retried on its own slower schedule (captureplan.tryPass); the other copies see
   * it through publishCaptureErrors.
   */
  async collect(c, cx, starting = false) {
    if (c.busy) return;
    c.busy = true;
    crumb(`capture: before pass ${c.capture.store.root} starting=${starting}`, null, ALIVE_MS);
    try { await tryPass(c, starting, this.log, this.now); }
    finally { c.busy = false; crumb(`capture: after pass ${c.capture.store.root}`, null, ALIVE_MS); }
  }

  /** A dropped record's last pass, failing or not (a failure is logged; the record is gone either way). */
  async end(c) {
    c.busy = true;
    crumb(`capture: before last pass ${c.capture.store.root}`, null, ALIVE_MS);
    try { await capturePass(c, false, this.log); crumb(`capture: after last pass ${c.capture.store.root}`, null, ALIVE_MS); }
    catch (e) { this.log(`${c.capture.store.root}: last pass failed: ${tailText(e?.message ?? e) || "unknown error"}`); }
    finally { c.busy = false; }
  }

  /** The leader's failing repos for every copy (CAPTURE_ERRORS): written when they change, renewed while any. */
  publishCaptureErrors() {
    const repos = captureErrors(this.captures), sig = JSON.stringify(repos), now = this.now(), cur = shared(CAPTURE_ERRORS);
    const mine = cur?.by === this.id;
    if (mine && sig === this.errorsSig && (sig === "{}" || now - (cur.at ?? 0) < ERRORS_RENEW)) return;
    if (!cur && sig === "{}") return; // nothing shared and nothing failing
    this.errorsSig = sig;
    setShared(CAPTURE_ERRORS, { by: this.id, at: now, repos });
  }
}
