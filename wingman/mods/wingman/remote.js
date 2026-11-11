// Spaces on another machine (a space's `machine`, reached over ssh through herdr-core). A root
// (Store or PlainRoot) carries its machine as `on` (null: this computer), and every git or file
// call for it passes that on; writes go through fsx.writeText (a compare-and-swap script there).
// What works there: the Edit tree, opening, editing and saving files, Review (capture by any agent,
// Accept, Reject, undo), Changes, Quick Open, Search and Replace All, workspaces and worktrees, and
// the Claude hook once it's installed there from Settings (hooksetup.js; journal.js reads its events
// and writes its notes there). What doesn't: Neovim and the external editor, and saving on a
// Windows machine. Pure: no Herdr imports.

/** How often an idle remote space is polled (about 200 ms per remote call), and how many reads run at once.
 *  watchMs: the outside-change check of Review's index and the open files; captureMs: an adopt pass
 *  while an agent works; reconcileMs: branch parking and committed changes; journalMs: the hook's
 *  events folder (journalIdleMs when the hook isn't installed there), at most journalMax events a pass. */
export const REMOTE = { rootsMs: 5000, changesMs: 5000, treeMs: 10000, watchMs: 5000, captureMs: 5000, reconcileMs: 15000, journalMs: 5000, journalIdleMs: 30000, journalMax: 20, parallel: 6, hashMax: 200 };

export const NVIM_NOTE = "Neovim can't open files on other machines yet";
export const EDITOR_NOTE = "The external editor can't open files on other machines yet";
/** The status line when a note to Claude can't be sent: the hook isn't installed on that machine. */
export const NOTES_NOTE = (on) => `Notes to Claude about rejections and edits aren't sent on ${on}: the Claude hook isn't installed there (⚙ Settings installs it). Comment still reaches the agent`;
/** The status line for Comment last rejection on a machine without the hook. */
export const REASON_NOTE = (on) => `Comments on rejections need the Claude hook, which isn't installed on ${on}: install it in ⚙ Settings, or use Comment`;

/**
 * Herdr's address for terminal `id` of machine `on`, as agents() and terminals() name it
 * ("wsl/t3"). Inside a terminal there, HC_TERMINAL_ID is the bare id ("t3"), which is what the
 * hook writes in its events and names its notes by.
 */
export const addressOn = (on, id) => (!on || !id || String(id).startsWith(`${on}/`) ? id : `${on}/${id}`);

/** The id machine `on`'s own terminals know an address by ("wsl/t3" -> "t3"); others are kept as they are. */
export const idOn = (on, address) => (on && address && String(address).startsWith(`${on}/`) ? String(address).slice(on.length + 1) : address);

/** Whether a root (or a file's store) lives on another machine. */
export const isRemote = (st) => !!st?.on;

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
