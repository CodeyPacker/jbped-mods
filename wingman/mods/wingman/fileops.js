// The Explorer's file operations, the pure part: name validation, where a new or renamed item lands
// (always inside its root, never a root itself, never in .git), the paths Copy Path copies and the
// delete confirm's wording. The file-system calls are fsx.js's. No Herdr imports.

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const WIN_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** "a/b" -> "a", "a" -> "". */
export const parentOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

/** The last name of a relative path. */
export const nameOf = (rel) => rel.slice(rel.lastIndexOf("/") + 1);

/** `rel` under `root` as one path ("C:/" + "a" -> "C:/a", "/" + "a" -> "/a"). */
export const under = (root, rel) => (rel ? `${String(root).replace(/\/+$/, "")}/${rel}` : String(root));

/** Whether names under `root` follow Windows' rules: a drive or share path on this computer (WSL's own files don't). */
export const windowsRoot = (root, on = null) => !on && /^(?:[A-Za-z]:|\/\/(?!wsl\.localhost\/|wsl\$\/)[^/]+\/)/i.test(String(root).replace(/\\/g, "/"));

// head: a drive ("C:") or UNC share ("//host/share"); rest: the names after it.
function parts(p) {
  const m = /^(\/\/[^/]+\/[^/]+|[A-Za-z]:)?(\/?)(.*)$/s.exec(String(p).replace(/\\/g, "/"));
  return { head: m[1] ?? "", rooted: !!(m[1] || m[2]), rest: m[3].split("/").filter(Boolean) };
}

/**
 * Whether `path` is strictly inside folder `root`: same drive or share, every name of `root` first,
 * at least one more name, and no "." or ".." or ".git" among the names after `root`. Drive and share
 * paths compare without case. Paths that aren't absolute never are.
 */
export function inside(path, root) {
  if (!path || !root) return false;
  const a = parts(root), b = parts(path), ci = !!a.head;
  const eq = (x, y) => (ci ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (!a.rooted || !b.rooted || !eq(a.head, b.head) || a.rest.some((s) => s === "." || s === "..")) return false;
  if (b.rest.length <= a.rest.length || !a.rest.every((s, i) => eq(s, b.rest[i]))) return false;
  return b.rest.slice(a.rest.length).every((s) => s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}

/**
 * Why a typed name can't be used, or null. `kind`: "file" or "dir". A name may hold "/" to make or
 * move into folders ("a/b/c.ts"); a folder's name may end in "/". Refused everywhere: empty, a NUL, a
 * backslash, a leading "/" (absolute), an empty name between slashes, "." or "..", ".git", a name
 * over 255 characters, a file name ending in "/". On Windows roots also: < > : " | ? * and control
 * characters, a name ending in a dot or a space, and the reserved device names (CON, NUL, COM1...),
 * with or without an extension.
 */
export function checkName(name, { kind = "file", windows = false } = {}) {
  const s = String(name ?? "");
  if (!s.trim()) return "A file or folder name must be provided.";
  if (s.includes("\0")) return "The name can't contain a NUL character.";
  if (s.includes("\\")) return "The name can't contain a backslash: use / to make folders.";
  if (s.startsWith("/")) return "The name can't start with /: it's relative to the folder.";
  if (kind === "file" && s.endsWith("/")) return "A file name can't end with /.";
  const names = (kind === "dir" ? s.replace(/\/+$/, "") : s).split("/");
  for (const n of names) {
    if (!n) return "The name can't have an empty part between slashes.";
    if (n === "." || n === "..") return `${n} isn't a valid file or folder name.`;
    if (n.toLowerCase() === ".git") return "Wingman doesn't create or change anything named .git.";
    if (n.length > 255) return "A name can be at most 255 characters.";
    if (!n.trim()) return "A name can't be only spaces.";
    if (windows) {
      if (WIN_CHARS.test(n)) return `${n} has a character Windows doesn't allow: < > : " | ? * or a control character.`;
      if (/[. ]$/.test(n)) return `${n} ends with a dot or a space, which Windows drops.`;
      if (RESERVED.test(n.replace(/\..*$/, "").trimEnd())) return `${n} is a name Windows reserves.`;
    }
  }
  return null;
}

/** A relative path inside a root can be acted on: not the root, not .git or anything in it, no "." or "..". */
export function checkRel(rel) {
  if (!rel) return "Wingman doesn't rename or delete a root folder.";
  const names = String(rel).split("/");
  if (names.some((n) => !n || n === "." || n === "..")) return `${rel} isn't a path inside the folder.`;
  if (names.some((n) => n.toLowerCase() === ".git")) return "Wingman doesn't change anything in .git.";
  return null;
}

/**
 * Where New File… or New Folder… named `name` lands in folder `dir` (relative, "" for the root):
 * { rel, path } (`made`: the folders it creates on the way, outermost first), or { error }.
 */
export function newTarget({ root, dir = "", name, kind = "file", windows = false }) {
  const why = checkName(name, { kind, windows }) ?? (dir ? checkRel(dir) : null);
  if (why) return { error: why };
  const clean = String(name).replace(/\/+$/, ""), rel = dir ? `${dir}/${clean}` : clean, path = under(root, rel);
  if (!inside(path, root)) return { error: `${clean} would be outside ${root}.` };
  const segs = rel.split("/"), made = [];
  for (let i = (dir ? dir.split("/").length : 0) + 1; i < segs.length + (kind === "dir" ? 1 : 0); i++) made.push(segs.slice(0, i).join("/"));
  return { rel, path, made };
}

/**
 * Where Rename… of `rel` to `name` lands: the name is taken in the item's own folder, so "lib/a.ts"
 * moves it into lib/ there. { rel, path, from, fromPath, caseOnly, same } or { error }. `same`: the
 * name didn't change (nothing to do). `caseOnly`: only letter case changed (readme.md -> README.md),
 * which a case-insensitive file system sees as the same name.
 */
export function renameTarget({ root, rel, name, isDir = false, windows = false }) {
  const bad = checkRel(rel);
  if (bad) return { error: bad };
  const why = checkName(name, { kind: isDir ? "dir" : "file", windows });
  if (why) return { error: why };
  const dir = parentOf(rel), clean = String(name).replace(/\/+$/, ""), to = dir ? `${dir}/${clean}` : clean;
  const path = under(root, to), fromPath = under(root, rel);
  if (!inside(path, root) || !inside(fromPath, root)) return { error: `${clean} would be outside ${root}.` };
  if (to === rel) return { rel: to, path, from: rel, fromPath, caseOnly: false, same: true };
  if (isDir && to.startsWith(`${rel}/`)) return { error: `Can't move ${nameOf(rel)} into itself.` };
  return { rel: to, path, from: rel, fromPath, caseOnly: to.toLowerCase() === rel.toLowerCase(), same: false };
}

/** The item's relative path after a rename of `from` to `to` (a file, or a folder and everything in it), else null. */
export function remap(rel, from, to) {
  if (rel === from) return to;
  return rel.startsWith(`${from}/`) ? to + rel.slice(from.length) : null;
}

/** Whether `rel` is `top` or inside it. */
export const within = (rel, top) => rel === top || rel.startsWith(`${top}/`);

/**
 * What Copy Path and Copy Relative Path copy: the path as the machine names it. A Windows drive or
 * share root uses backslashes in both (as VS Code does on Windows); every other root uses "/".
 */
export function copyPaths(root, rel, windows = windowsRoot(root)) {
  const path = under(root, rel), relative = rel || ".";
  const win = (p) => p.replace(/\//g, "\\");
  return windows ? { path: win(path), relative: win(relative) } : { path, relative };
}

/** How many files the repo's file list has under folder `rel`. */
export function countUnder(paths, rel) {
  const p = `${rel}/`;
  let n = 0;
  for (const x of paths ?? []) if (x.startsWith(p)) n++;
  return n;
}

/** The delete confirm's question. `count`: the folder's files when known (null: not known). */
export function deleteQuestion({ rel, isDir, count = null }) {
  if (!isDir) return `Delete ${rel}? This can't be undone.`;
  const what = count == null ? "everything in it" : count === 0 ? "everything in it" : `its ${count} file${count === 1 ? "" : "s"}`;
  return `Delete folder ${rel} and ${what}? This can't be undone.`;
}

/** The part of a file name Rename selects: up to the last dot (not a leading one), else all of it. */
export function stemEnd(name, isDir = false) {
  const i = name.lastIndexOf(".");
  return !isDir && i > 0 ? i : name.length;
}
