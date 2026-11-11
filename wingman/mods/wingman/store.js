// Review store on disk: <git-dir>/wingman/{index.json, baselines/*}, on the machine the repo is on.
// Every write is compare-and-swap (fsx.writeText's `expected`), so a file that
// changed since it was read is never overwritten; the action fails instead.
import { readTextFile } from "herdr";
import { git, hostOf } from "./git.js";
import { splitLines, parseHunks, wholeHunk } from "./model.js";
import { writeText, removeFile, makeDir, fingerprints, readOn } from "./fsx.js";
import { sha256Hex } from "./sha256.js";
import { REMOTE, mapLimit } from "./remote.js";

const isWindows = (p) => /^[A-Za-z]:/.test(p);
export const norm = (p) => { const s = p.replace(/\\/g, "/").replace(/^\/\/\?\//, ""); return isWindows(s) ? s.toLowerCase() : s; };

/** Creates a folder and its parents, on machine `on` (null: this computer). */
export const ensureDir = (path, on = null) => makeDir(path, { on });

/** Writes `after` (null: deletes) over a file whose content must still be `before` (null = absent), on machine `on`. */
export async function swap(path, before, after, on = null) {
  if (after === null) await removeFile(path, before, { on });
  else await writeText(path, after, before, { on });
  return { path, before, after };
}

const lf = (t) => (t == null ? null : t.replace(/\r\n/g, "\n"));

/** The most a text Herdr reads may have (1 MiB): a bigger file is never reviewed. */
export const MAX_TEXT = 1048576;

/** What a version of a file is, for telling whether a commit holds it: the SHA-256 of its text
 *  with CRLF read as LF, or "-" for no file. */
export const sumOf = async (t) => (t == null ? "-" : await sha256Hex(lf(t)));

/** The branch a HEAD file names ("ref: refs/heads/x" -> "x"), or "@<sha>" when detached. */
export function branchOf(headText) {
  const t = (headText ?? "").trim(), m = /^ref:\s*refs\/heads\/(.+)$/.exec(t);
  return m ? m[1] : t ? `@${t.slice(0, 12)}` : null;
}

/**
 * Whether a review entry shows in a space on a branch: entries recorded on another branch, or by
 * an agent of another space, don't. Entries from before they were recorded (no branch, no space)
 * take the current branch, and the space of the agent that made them when it's still known.
 */
export function shows(entry, branch, space, spaceOf = () => null) {
  if (entry.branch && branch && entry.branch !== branch) return false;
  const from = entry.space ?? spaceOf(entry.by);
  return !(from && space && from !== space);
}

/** Moves an entry for `rel` recorded on another branch aside (index.parked), so `rel` can start a new one. */
export function parkStale(index, rel, branch) {
  const e = index.files[rel];
  if (!e?.branch || e.branch === branch) return false;
  (index.parked ??= {})[`${e.branch}|${rel}`] = e;
  delete index.files[rel];
  return true;
}

export class Store {
  /** The repo holding folder `root`, on machine `on` (null: this computer). Every git and file call
   *  of the store runs there, its review store's writes included. */
  static async open(root, on = null) {
    // Any folder inside the repo works: the store opens at the top level, where git's paths start.
    const r = await git(["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd: root, on });
    if (r.code !== 0) throw new Error(`not a git repository: ${root}`);
    const [top, gitDir] = r.stdout.trim().split(/\r?\n/);
    return new Store(await hostOf(top, root, on), await hostOf(gitDir, root, on), on);
  }

  constructor(root, gitDir, on = null) {
    this.root = root; this.gitDir = gitDir; this.dir = `${gitDir}/wingman`; this.on = on;
  }

  /** git in the repo, where it lives. */
  git(args, opts = {}) { return git(args, { cwd: this.root, on: this.on, ...opts }); }

  /** A file's text (null when absent). On another machine with a time limit (fsx.readOn). */
  read(path) { return this.on ? readOn(path, { on: this.on }) : readTextFile(path); }

  /**
   * What a batch of watched paths means: "all" (the index changed or the batch
   * overflowed to the root), else the set of reviewed files (relative paths) touched.
   */
  touched(paths) {
    const root = norm(this.root), git = norm(this.gitDir) + "/", index = norm(`${this.dir}/index.json`);
    const rels = new Set();
    for (const p of paths) {
      const n = norm(p);
      if (n === index || n === root) return "all";
      if (!n.startsWith(git) && n.startsWith(root + "/")) rels.add(n.slice(root.length + 1));
    }
    return rels;
  }

  /** The repo's branch now, read from its HEAD file (no git run). */
  async branch() { return branchOf(await this.read(`${this.gitDir}/HEAD`)); }

  /** HEAD's commit, or null in a repo with no commits. */
  async head() {
    const r = await this.git(["rev-parse", "-q", "--verify", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** What a pane compares to notice review changes: the index and the branch. */
  async stamp() {
    const [i, h] = await Promise.all([this.read(`${this.dir}/index.json`), this.read(`${this.gitDir}/HEAD`)]);
    return `${i}\0${h}`;
  }

  /** A file's text in a commit, or null when the commit doesn't have it. */
  async blobAt(commit, rel) {
    const r = await this.git(["cat-file", "blob", `${commit}:${rel}`]);
    return r.code === 0 ? r.stdout : null;
  }

  /**
   * Whether the agent's change to `rel` is committed: the file on disk is what HEAD has, and HEAD
   * has the agent's change, `sum` (sumOf of the file as last seen differing from HEAD, see
   * observe). So a change put aside (git stash, a discard) while HEAD moves is never taken for
   * committed. Entries from before sums were kept (no `sum`): a commit since the entry was
   * recorded changed the file (before the entry recorded HEAD: HEAD differs from the baseline).
   * A file that can't be read (over 1 MiB, gone meanwhile) isn't committed.
   */
  async committed(rel, e, head, sum = e.sum ?? null) {
    let c, h;
    try { [c, h] = await Promise.all([this.read(`${this.root}/${rel}`), this.blobAt(head, rel)]); } catch { return false; }
    if (lf(c) !== lf(h)) return false;
    if (sum) return (await sumOf(h)) === sum;
    if (e.head) return e.head !== head && lf(await this.blobAt(e.head, rel)) !== lf(h);
    const b = await this.read(`${this.dir}/baselines/${e.baseline}`).catch(() => null);
    return lf(e.created ? null : b ?? "") !== lf(h);
  }

  /**
   * Each file's sumOf on disk now (undefined when it can't be read). Here the texts are read (one
   * that didn't change since the last look isn't hashed again); on another machine one call hashes
   * them all there and only contents not seen before are read.
   */
  async diskSums(rels) {
    const out = new Map(), seen = (this.seenSums ??= new Map());
    if (seen.size > 2000) seen.clear();
    if (!this.on) {
      for (const rel of rels) {
        const t = await this.read(`${this.root}/${rel}`).catch(() => undefined);
        if (t === undefined) continue;
        const k = seen.get(rel);
        if (k?.text === t) { out.set(rel, k.sum); continue; }
        const sum = await sumOf(t);
        seen.set(rel, { text: t, sum }); out.set(rel, sum);
      }
      return out;
    }
    // Hashed in calls of at most about 20 KB of paths (a call's safe size is 30 KB in all).
    const paths = rels.map((r) => `${this.root}/${r}`), fp = {}, groups = [[]];
    let size = 0;
    for (const p of paths) {
      if (size + p.length > 20000 && groups.at(-1).length) { groups.push([]); size = 0; }
      groups.at(-1).push(p); size += p.length + 1;
    }
    for (const g of groups) if (g.length) Object.assign(fp, await fingerprints(g, { on: this.on }));
    await mapLimit(rels, REMOTE.parallel, async (rel, i) => {
      const raw = fp[paths[i]];
      if (raw === undefined) return;
      if (raw === null) { out.set(rel, "-"); return; }
      if (!seen.has(raw)) {
        const t = await this.read(paths[i]).catch(() => null);
        if (t == null) return;
        seen.set(raw, await sumOf(t));
      }
      out.set(rel, seen.get(raw));
    });
    return out;
  }

  /** HEAD's sumOf for `rel`, kept while HEAD stays. */
  async headSum(head, rel) {
    if (this.sumsHead !== head) { this.sumsHead = head; this.headSums = new Map(); }
    if (!this.headSums.has(rel)) this.headSums.set(rel, head ? await sumOf(await this.blobAt(head, rel)) : "-");
    return this.headSums.get(rel);
  }

  /**
   * Remembers what each reviewed file (`entries`: [rel, entry]) has while it differs from HEAD:
   * the agent's change, and any edit after it, as it would be committed. Kept in sums.json
   * (baseline name -> sum), apart from the index so the panes aren't reloaded for it; only names
   * in `keep` stay. Returns the sums. Compare-and-swap: when the write loses, the next look retries.
   */
  async observe(entries, head, keep = null) {
    const path = `${this.dir}/sums.json`;
    const before = this.on && this.sumsText !== undefined ? this.sumsText : await this.read(path).catch(() => null);
    let sums = {};
    try { sums = before ? JSON.parse(before) : {}; } catch {}
    const next = { ...sums }, disk = await this.diskSums(entries.map(([rel]) => rel));
    for (const [rel, e] of entries) {
      const d = disk.get(rel);
      if (d !== undefined && d !== (await this.headSum(head, rel))) next[e.baseline] = d;
    }
    if (keep) for (const k of Object.keys(next)) if (!keep.has(k)) delete next[k];
    const text = JSON.stringify(next);
    if (text !== (before ?? "{}")) {
      try { await writeText(path, text, before, { on: this.on }); this.sumsText = text; }
      catch { this.sumsText = undefined; return sums; }
    } else this.sumsText = before;
    return next;
  }

  /** observe for the files `rels` that are under review, before a commit (the leader looks only every few seconds). */
  async remember(rels) {
    const files = await this.index(), entries = rels.filter((r) => files[r]).map((r) => [r, files[r]]);
    if (entries.length) await this.observe(entries, await this.head());
  }

  /**
   * The capture leader's pass over the index: entries get their branch and space (old ones),
   * entries of another branch are parked and come back when the repo is on it again, each file's
   * content is remembered while it differs from HEAD (observe), and committed changes leave the
   * review for index.done (the Changes view marks them as AI's). Committed changes are looked for
   * when HEAD moved since the last pass. Compare-and-swap: when someone else wrote the index
   * first, the next pass tries again. A pass still running when the next is due skips that one.
   */
  async reconcile(spaceOf = () => null) {
    if (this.reconciling) return;
    this.reconciling = true;
    try { await this.reconcileOnce(spaceOf); } finally { this.reconciling = false; }
  }

  async reconcileOnce(spaceOf) {
    const path = `${this.dir}/index.json`, before = await this.read(path);
    if (!before) return;
    const index = JSON.parse(before), branch = await this.branch(), head = await this.head();
    index.files ??= {};
    let changed = false;
    for (const [rel, e] of Object.entries(index.files)) {
      if (!e.branch && branch) { e.branch = branch; changed = true; }
      if (!e.space) { const sp = spaceOf(e.by); if (sp) { e.space = sp; changed = true; } }
      if (parkStale(index, rel, branch)) changed = true;
    }
    for (const [k, e] of Object.entries(index.parked ?? {})) {
      const rel = k.slice(e.branch.length + 1);
      if (e.branch === branch && !index.files[rel]) { index.files[rel] = e; delete index.parked[k]; changed = true; }
    }
    const live = Object.entries(index.files), keep = new Set([...live, ...Object.entries(index.parked ?? {})].map(([, e]) => e.baseline));
    const sums = live.length || before.includes('"parked"') ? await this.observe(live, head, keep) : {};
    if (head && head !== this.checkedHead) {
      for (const [rel, e] of live) {
        if (!(await this.committed(rel, e, head, sums[e.baseline] ?? e.sum ?? null))) continue;
        (index.done ??= {})[`${branch}|${rel}`] = { by: e.by ?? null, space: e.space ?? null, created: !!e.created, head, at: Date.now() };
        delete index.files[rel]; changed = true;
      }
    }
    if (changed) await writeText(path, JSON.stringify(index, null, 2) + "\n", before, { on: this.on });
    this.checkedHead = head;
  }

  async index() {
    const text = await this.read(`${this.dir}/index.json`);
    return text ? JSON.parse(text).files ?? {} : {};
  }

  /** Loads one file: baseline B, current C (null if deleted), and its hunks. */
  async load(rel, entry) {
    const basePath = `${this.dir}/baselines/${entry.baseline}`, path = `${this.root}/${rel}`;
    const [b, c] = await Promise.all([this.read(basePath), this.read(path)]);
    const Btext = b ?? "", B = splitLines(Btext), C = splitLines(c ?? "");
    let hunks;
    if (!B.length || !C.length) hunks = wholeHunk(B, C);
    else if (Btext === c) hunks = [];
    else {
      const d = await this.git(["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "-U0",
        "--diff-algorithm=minimal", "--", basePath, path]);
      if (d.code > 1) throw new Error(d.stderr.trim());
      hunks = parseHunks(d.stdout);
    }
    return { rel, path, basePath, created: !!entry.created, by: entry.by ?? null, as: entry.as ?? null, store: this, key: `${this.root}|${rel}`, Btext, Ctext: c, B, C, hunks };
  }

  /** The review's files; `keep(entry)` picks which entries (default: all). */
  async files(keep = () => true) {
    const index = await this.index(), out = [];
    for (const [rel, entry] of Object.entries(index)) {
      if (!keep(entry)) continue;
      try { out.push(await this.load(rel, entry)); }
      catch (e) { out.push({ rel, store: this, key: `${this.root}|${rel}`, error: String(e.message ?? e), hunks: [] }); }
    }
    return out;
  }

  /** A fresh path for a temp file in the review store (on the repo's machine), `kind` its suffix. */
  tempPath(kind) { return `${this.dir}/tmp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${kind}`; }

  /** Writes `text` to `path` (tempPath's), runs `run()`, and removes the file afterwards, whatever happened. */
  async withTemp(path, text, run) {
    await makeDir(this.dir, { on: this.on });
    await writeText(path, text, null, { on: this.on });
    try { return await run(); }
    finally { await removeFile(path, text, { on: this.on }).catch(() => {}); }
  }

  /** Applies one model write ({ target, before, after }) to disk; returns it with its path. */
  async apply(f, w) {
    const path = w.target === "baseline" ? f.basePath : f.path;
    await swap(path, w.before, w.after, this.on);
    return { path, before: w.before, after: w.after };
  }

  /** Reverts writes made by `apply`, newest first. */
  async undo(writes) {
    for (const w of [...writes].reverse()) await swap(w.path, w.after, w.before, this.on);
  }
}

/**
 * A folder outside any git repo, shown in the Edit tree as a plain root: its files open, edit and
 * save like a repo's (keys "<root>|<rel>", `apply`), and nothing else applies to it (no review,
 * capture, git status or Changes). `plain` tells it apart from a Store.
 */
export class PlainRoot {
  /** `on`: the machine the folder is on (null: this computer). */
  constructor(root, on = null) { this.root = root; this.asked = root; this.plain = true; this.label = null; this.on = on; }

  /** Saves a file's text (compare-and-swap, like Store.apply). There is no baseline to write. */
  async apply(f, w) {
    if (w.target !== "current") throw new Error(`${f.rel} has no review baseline outside a git repo`);
    await swap(f.path, w.before, w.after, this.on);
    return { path: f.path, before: w.before, after: w.after };
  }

  async undo(writes) {
    for (const w of [...writes].reverse()) await swap(w.path, w.after, w.before, this.on);
  }
}
