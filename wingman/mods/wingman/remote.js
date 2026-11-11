// Spaces on another machine (a space's `machine`, reached over ssh through herdr-core). A root
// (Store or PlainRoot) carries its machine as `on` (null: this computer), and every git or file
// call for it passes that on. What works there for now: the Edit tree, opening files (read-only),
// Changes (diffs, Commit, Discard), Quick Open and workspaces. Review, capture, the Claude hook
// journal and saving edits don't yet. Pure: no Herdr imports.

/** How often an idle remote space is polled (about 200 ms per remote call), and how many reads run at once. */
export const REMOTE = { rootsMs: 5000, changesMs: 5000, treeMs: 10000, parallel: 6, hashMax: 200 };

export const REVIEW_NOTE = "Review isn't available on other machines yet. Changes and the file tree are.";
export const NVIM_NOTE = "Neovim can't open files on other machines yet";
export const EDITOR_NOTE = "The external editor can't open files on other machines yet";
export const WORKTREE_NOTE = "Worktrees can't be made on other machines yet.";

/** Whether a root (or a file's store) lives on another machine. */
export const isRemote = (st) => !!st?.on;

/** The status line for an edit, save or paste in a file on machine `on`. */
export function readOnlyNote(rel, on) {
  return `${String(rel).split("/").pop()} is on ${on}: files on other machines are read-only for now`;
}

/**
 * A path on another machine as Wingman keeps it: the machine's own, never drive-converted or
 * lowercased. A Windows path (C:\x, \\host\share) gets "/" separators; a POSIX path is kept as is.
 * A trailing "/" goes, except on a root ("/", "C:/").
 */
export function remotePath(p) {
  if (p == null || p === "") return null;
  let s = String(p);
  if (/^(?:[A-Za-z]:[\\/]|[A-Za-z]:$|\\\\)/.test(s)) s = s.replace(/\\/g, "/");
  if (/^[A-Za-z]:$/.test(s)) return `${s}/`;
  return /^(?:\/|[A-Za-z]:\/)$/.test(s) ? s : s.replace(/\/+$/, "") || "/";
}

/**
 * What tells a root apart in caches and settings kept across spaces: its path on this computer,
 * "<machine>\0<path>" on another, so the same path on two machines never shares state.
 */
export const rootId = (root, on = null) => (on ? `${on}\u0000${root}` : root);

/** A root's id (see rootId). */
export const idOf = (st) => rootId(st.root, st.on ?? null);

/** `fn` over `items`, at most `limit` at a time, results in order. Limit 1 runs them one after another. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
