// Which root of a space owns a path, so a file has one identity (root + relative path) however it
// was reached. A space's roots can nest: a plain folder holding the space's worktrees (a ticket
// folder), a worktree folder inside another repo's tree, two terminals in T and T/sub. The deepest
// root holding a path owns it, a repo before a plain folder at the same path; the folders of the
// other roots inside a root show in its tree as links to them (linkRows). Pure: no Herdr imports.

const slash = (p) => String(p ?? "").replace(/\\/g, "/");
/** A folder path without its trailing "/" ("/" and "C:/" stay). */
const trim = (p) => { const s = slash(p); return /^(?:\/|[A-Za-z]:\/)$/.test(s) ? s : s.replace(/\/+$/, ""); };
/** Drive and share paths compare without case, as Windows does; others exactly. */
const caseless = (p) => /^(?:[A-Za-z]:|\/\/)/.test(p);
const same = (a, b) => (caseless(a) || caseless(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** `path` relative to folder `root` ("" for the root itself), or null when it isn't inside it. */
export function relUnder(path, root) {
  const p = trim(path), r = trim(root);
  if (!p || !r) return null;
  if (same(p, r)) return "";
  const cut = r.endsWith("/") ? r.length : r.length + 1;
  if (p.length <= cut || (!r.endsWith("/") && p[r.length] !== "/") || !same(p.slice(0, r.length), r)) return null;
  return p.slice(cut);
}

/**
 * The root that owns `path` on machine `on`: { root, rel } for the deepest root (of `roots`, each
 * { root, on, plain }) holding it, a repo before a plain folder of the same path, or null.
 */
export function ownerOf(roots, path, on = null) {
  let best = null;
  for (const r of roots) {
    if ((r.on ?? null) !== (on ?? null)) continue;
    const rel = relUnder(path, r.root);
    if (rel == null) continue;
    const len = trim(r.root).length;
    if (!best || len > best.len || (len === best.len && best.root.plain && !r.plain)) best = { root: r, rel, len };
  }
  return best && { root: best.root, rel: best.rel };
}

/** The roots strictly inside `root` (same machine), as [{ rel, root }], outermost first. */
export function nestedIn(roots, root) {
  const out = [];
  for (const r of roots) {
    if (r === root || (r.on ?? null) !== (root.on ?? null)) continue;
    const rel = relUnder(r.root, root.root);
    if (rel) out.push({ rel, root: r });
  }
  return out.sort((a, b) => a.rel.split("/").length - b.rel.split("/").length);
}

/** Whether `rel` of `root` is another root of the space or holds one (never renamed or deleted from `root`'s tree). */
export function holdsRoot(roots, root, rel) {
  const ci = caseless(trim(root.root)), k = ci ? rel.toLowerCase() : rel;
  return nestedIn(roots, root).some((n) => { const x = ci ? n.rel.toLowerCase() : n.rel; return x === k || x.startsWith(`${k}/`); });
}

/**
 * A root's tree rows (filetree.rows) with the other roots inside it as links: the row at a nested
 * root's folder gets `link` (that root) and shows closed, and rows under it are left out, so no path
 * of the nested root is reachable through this one. `nested`: nestedIn's list; `ci`: names compare
 * without case (a Windows drive or share root).
 */
export function linkRows(rows, nested, ci = false) {
  if (!nested.length) return rows;
  const k = (s) => (ci ? s.toLowerCase() : s), at = new Map(nested.map((n) => [k(n.rel), n.root]));
  const out = [];
  let skip = null;
  for (const row of rows) {
    const rel = k(row.rel ?? "");
    if (skip != null && (row.more ? rel === skip || rel.startsWith(`${skip}/`) : rel.startsWith(`${skip}/`))) continue;
    skip = null;
    const link = row.more ? null : at.get(rel);
    if (link) { out.push({ ...row, link, dir: true, open: false, loading: false, mark: undefined, n: 0, dirty: false }); skip = rel; continue; }
    out.push(row);
  }
  return out;
}

/** Whether a root's folder names compare without case (a Windows drive or share). */
export const caselessRoot = (root) => caseless(trim(root.root ?? root));
