// Which Wingman copy acts on a `wingman.<command>`. Herdr hands a mod command to every SHOWN copy
// (measured: the panel copy on screen, every Wingman pane of the shown tab, an open Wingman dialog;
// a hidden panel copy never gets it). So a command can reach two copies (a pane beside the panel),
// and the copy that should act can be hidden (Problems' owner is the Edit panel). One rule for all:
// - "all": settings and hook reloads, which every copy needs, hidden ones too: the copies that get
//   the command bump a shared stamp, and every copy reloads on its tick (main.js SETTINGS_REV).
// - "one": every other command. The copies that got it wait SETTLE_MS for each other, then only the
//   highest ranked acts (rank, winner). A copy that can't do it itself hands it on (main.js claim).
// - "self": a dialog's own commands (cp*), tree menu commands (only the copy that opened the menu
//   holds its item) and "focus" (sent to one copy by Herdr): each copy decides as before.
// Pure: no Herdr imports.

/** How long a copy that got a command waits for the other shown copies to get it too, in ms. */
export const SETTLE_MS = 60;
/** Copies' entries for the same command within this many ms are one delivery. */
export const WINDOW_MS = 400;
/** Entries older than this are dropped. */
export const KEEP_MS = 5000;

const ALL = new Set(["settings", "hook"]);

/** "all", "one" or "self" for a command name (without "wingman."). */
export function kindOf(c) {
  const name = String(c ?? "");
  if (ALL.has(name)) return "all";
  if (name === "focus" || /^tree[A-Z]/.test(name) || /^cp[A-Z]/.test(name)) return "self";
  return "one";
}

/** The command's name without an argument ("inlineEdit:<text>" -> "inlineEdit"). */
export const nameOf = (c) => String(c ?? "").split(":")[0];

/**
 * A receiving copy's claim to act on `c`, higher first: the copy whose right-click menu sent it (its
 * lines and change), the copy with the keyboard (a keys.json key), the copy the command belongs to
 * (`owner`: Problems and inline edit, the Edit panel's copy), a panel copy over a pane copy.
 */
export function rank({ menu = false, focused = false, owner = false, panel = false } = {}) {
  return (menu ? 8 : 0) + (focused ? 4 : 0) + (owner ? 2 : 0) + (panel ? 1 : 0);
}

/**
 * The id of the copy that acts on the delivery `me` ({ id, c, at, rank }) out of every copy's
 * entries: the same command within WINDOW_MS of it, highest rank, then the lowest id.
 */
export function winner(entries, me) {
  let best = null;
  for (const e of entries) {
    if (e.c !== me.c || Math.abs(e.at - me.at) > WINDOW_MS) continue;
    if (!best || e.rank > best.rank || (e.rank === best.rank && e.id < best.id)) best = e;
  }
  return best?.id ?? me.id;
}

/** Drops entries older than KEEP_MS (in place); returns the list. */
export function prune(entries, now) {
  for (let i = entries.length - 1; i >= 0; i--) if (now - entries[i].at > KEEP_MS) entries.splice(i, 1);
  return entries;
}
