// Review store on disk: <git-dir>/wingman/{index.json, baselines/*}, on the machine the repo is on.
// Every write is compare-and-swap (fsx.writeText's `expected`), so a file that
// changed since it was read is never overwritten; the action fails instead.
import { readTextFile } from "herdr";
import { git, hostOf } from "./git.js";
import { splitLines, parseHunks, wholeHunk } from "./model.js";
import { writeText, removeFile, makeDir } from "./fsx.js";

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

  read(path) { return readTextFile(path, { on: this.on }); }

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
   * Whether the agent's change to `rel` is committed: the file on disk is what HEAD has, and a
   * commit since the entry was recorded changed it (before the entry recorded HEAD: HEAD differs
   * from the baseline).
   */
  async committed(rel, e, head) {
    const [c, h] = await Promise.all([this.read(`${this.root}/${rel}`), this.blobAt(head, rel)]);
    if (lf(c) !== lf(h)) return false;
    if (e.head) return e.head !== head && lf(await this.blobAt(e.head, rel)) !== lf(h);
    const b = await this.read(`${this.dir}/baselines/${e.baseline}`);
    return lf(e.created ? null : b ?? "") !== lf(h);
  }

  /**
   * The capture leader's pass over the index: entries get their branch and space (old ones),
   * entries of another branch are parked and come back when the repo is on it again, and
   * committed changes leave the review for index.done (the Changes view marks them as AI's).
   * Committed changes are looked for when HEAD moved since the last pass. Compare-and-swap:
   * when someone else wrote the index first, the next pass tries again.
   */
  async reconcile(spaceOf = () => null) {
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
    if (head && head !== this.checkedHead) {
      for (const [rel, e] of Object.entries(index.files)) {
        if (!(await this.committed(rel, e, head))) continue;
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
