// Lazy file tree for the Edit view, like VS Code's Explorer: pure, no Herdr imports.
// Folders are listed when opened, git-ignored paths are dimmed, files carry their git status letter.
import { READ } from "./changes.js";

export const PER_FOLDER = 500, TOTAL = 5000;

const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
const order = (a, b) => (a.dir === b.dir ? byName(a.name, b.name) : a.dir ? -1 : 1);
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const under = (dir) => (dir ? `${dir}/` : "");
const depthOf = (rel) => (rel ? rel.split("/").length : 0);

/** A new tree: no folders loaded, none open. */
export function createTree() {
  return { entries: new Map(), open: new Set(), limited: false };
}

/** Stores a folder's listing, sorted (folders first, then by name) and cut to PER_FOLDER and to what TOTAL leaves. `more` or `limited` (the TOTAL cut) is set when entries were cut. */
export function setFolder(tree, rel, entries, more = false) {
  let used = 0;
  for (const [k, v] of tree.entries) if (k !== rel) used += v.list.length;
  const room = Math.min(PER_FOLDER, Math.max(0, TOTAL - used));
  const sorted = entries.map(({ name, dir }) => ({ name, dir: !!dir })).sort(order);
  const list = sorted.slice(0, room), cut = sorted.length > room;
  if (cut && sorted.length > Math.max(0, TOTAL - used)) tree.limited = true;
  tree.entries.set(rel, { list, more: !!more || cut });
}

/** Opens or closes a folder. Closing also closes and forgets every folder under it. Returns true when the folder is now open and has no listing yet (the caller must load it). */
export function toggle(tree, rel) {
  if (tree.open.has(rel)) {
    tree.open.delete(rel);
    const p = under(rel);
    for (const k of [...tree.open]) if (k.startsWith(p)) tree.open.delete(k);
    for (const k of [...tree.entries.keys()]) if (k !== "" && k !== rel && k.startsWith(p)) tree.entries.delete(k);
    return false;
  }
  tree.open.add(rel);
  return !tree.entries.has(rel);
}

/** Opens every ancestor folder of `rel` (a file or folder path). Returns the ancestors that still need loading, outermost first. */
export function reveal(tree, rel) {
  const parts = rel.split("/"), need = [];
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join("/");
    tree.open.add(dir);
    if (!tree.entries.has(dir)) need.push(dir);
  }
  return need;
}

/** Folder paths that are loaded (root and open ones), outermost first: what a refresh re-lists. */
export function loaded(tree) {
  return [...tree.entries.keys()].filter((k) => k === "" || tree.open.has(k)).sort((a, b) => depthOf(a) - depthOf(b) || byName(a, b));
}

/** The visible rows in display order: { rel, name, dir, depth, open, loading, mark, ignored, n, dirty, deleted, more }. A folder's mark is the strongest under it; deleted files missing from a listing get a `deleted` row; a cut folder ends with { more: true, depth, rel: folderRel }. `deco`: { prefix, marks, ignored, counts } (see parseStatus, ignoredMatcher). */
export function rows(tree, deco = {}) {
  const { prefix = "", marks = new Map(), ignored = () => false, counts = new Map() } = deco;
  const repo = (rel) => (prefix ? (rel ? `${prefix}/${rel}` : prefix) : rel);
  const fmarks = marks.size ? folderMarks(marks) : new Map();
  const gone = new Map(); // tree folder -> deleted file names
  const base = under(prefix);
  for (const [p, l] of marks) {
    if (l !== "D" || !p.startsWith(base)) continue;
    const rel = p.slice(base.length), i = rel.lastIndexOf("/"), dir = i < 0 ? "" : rel.slice(0, i);
    if (!gone.has(dir)) gone.set(dir, []);
    gone.get(dir).push(rel.slice(i + 1));
  }
  const out = [];
  const walk = (dir, depth, parentIgnored) => {
    const l = tree.entries.get(dir);
    if (!l) return;
    let list = l.list;
    const missing = gone.get(dir);
    if (missing) {
      const have = new Set(list.map((e) => e.name));
      const extra = missing.filter((n) => !have.has(n)).map((name) => ({ name, dir: false, deleted: true }));
      if (extra.length) list = [...list, ...extra].sort(order);
    }
    for (const e of list) {
      const rel = join(dir, e.name), rp = repo(rel), c = counts.get(rel);
      const open = e.dir && tree.open.has(rel);
      out.push({
        rel, name: e.name, dir: e.dir, depth, open, loading: open && !tree.entries.has(rel),
        mark: e.deleted ? "D" : e.dir ? fmarks.get(rp) : marks.get(rp),
        ignored: parentIgnored || !!ignored(rp, e.dir),
        n: c ? c.n : 0, dirty: c ? !!c.dirty : false, deleted: !!e.deleted, more: false,
      });
      if (open) walk(rel, depth + 1, out[out.length - 1].ignored);
    }
    if (l.more) out.push({ more: true, depth, rel: dir });
  };
  walk("", 0, false);
  return out;
}

/**
 * Every folder's entries in a repo, from its file list (`git ls-files`: files, so empty folders are
 * absent) and parseStatus's ignored list (an ignored folder, "node_modules/", is one entry whose
 * content isn't known). Map<folderRel, [{ name, dir }]>, unsorted; "" is the root and always present.
 */
export function folderIndex(paths, ignored = []) {
  const kids = new Map([["", new Map()]]);
  const add = (p, isDir) => {
    const parts = p.split("/").filter(Boolean);
    let dir = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i], d = isDir || i < parts.length - 1;
      let m = kids.get(dir);
      if (!m) kids.set(dir, (m = new Map()));
      if (d) m.set(name, true); else if (!m.has(name)) m.set(name, false);
      dir = join(dir, name);
    }
  };
  for (const p of paths) add(p, false);
  for (const p of ignored) add(p, p.endsWith("/"));
  const out = new Map();
  for (const [dir, m] of kids) out.set(dir, [...m].map(([name, d]) => ({ name, dir: d })));
  return out;
}

/** git arguments for one status call: untracked files one by one, ignored paths collapsed to the topmost ignored folder. */
export const STATUS_TREE = [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored=matching"];

const letter = (xy) => {
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "U";
  if (xy === "??" || xy.includes("A")) return "A";
  return xy.includes("D") ? "D" : "M";
};

/** STATUS_TREE's output as { marks: Map<repoRel, "A"|"M"|"D"|"U">, ignored: string[] } (an ignored folder keeps git's trailing "/"). */
export function parseStatus(out) {
  const marks = new Map(), ignored = [];
  for (const e of out.split("\0")) {
    if (e.length < 4) continue;
    const xy = e.slice(0, 2), p = e.slice(3);
    if (xy === "!!") ignored.push(p); else marks.set(p, letter(xy));
  }
  return { marks, ignored };
}

/** A matcher for parseStatus's ignored list: (repoRel, isDir) -> true for an ignored path and anything under an ignored folder. Constant work per ancestor, no list scan. */
export function ignoredMatcher(ignored) {
  const exact = new Set(), dirs = new Set();
  for (const p of ignored) {
    if (p.endsWith("/")) dirs.add(p.slice(0, -1)); else exact.add(p);
  }
  return (rel) => {
    if (exact.has(rel) || dirs.has(rel)) return true;
    for (let i = rel.indexOf("/"); i >= 0; i = rel.indexOf("/", i + 1)) if (dirs.has(rel.slice(0, i))) return true;
    return false;
  };
}

/** Each folder's mark from the files under it: U beats everything, M beats A and D, A with D gives M. Map<folderRepoRel, letter>. */
export function folderMarks(marks) {
  const bits = new Map(), BIT = { A: 1, M: 2, D: 4, U: 8 };
  for (const [p, l] of marks) {
    for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
      const d = p.slice(0, i);
      bits.set(d, (bits.get(d) || 0) | BIT[l]);
    }
  }
  const out = new Map();
  for (const [d, b] of bits) out.set(d, b & 8 ? "U" : b & 2 || b === 5 ? "M" : b & 1 ? "A" : "D");
  return out;
}
