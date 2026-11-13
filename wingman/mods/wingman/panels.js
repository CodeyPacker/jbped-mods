// Hides Herdr's own Files and Changes tab-bar buttons, reversibly. The buttons come from the shared
// setting "workspace.panels" (an array of panel names; unset means ["files", "changes"]). Wingman's
// buttons don't come from it, so removing these two doesn't touch them.
//
// Wingman keeps what it took in its own shared key, PANELS_KEY: { on, removed, original }.
//   on        true while the setting is applied
//   removed   the entries Wingman took out (only ones that were in the list at that moment)
//   original  the list as it was then, to put the entries back in their old order
// Another mod (herdr-nvim does this for "files") may edit the list in between: only Wingman's own
// entries are ever added or removed, and anything else in the list is left as it is.
// Pure: no Herdr imports, so it runs under Node tests.

export const PANELS = "workspace.panels";
export const PANELS_KEY = "wingman.panelsHidden";
export const DEFAULT_PANELS = ["files", "changes"];
export const HIDDEN = ["files", "changes"];

const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The list Herdr uses: unset (or not a list of names) is the default. */
export function listOf(value) {
  return strings(value) ? [...value] : [...DEFAULT_PANELS];
}

/** What Wingman recorded, or an "off" record when nothing valid is stored. */
export function stateOf(value) {
  if (value && typeof value === "object" && value.on === true && strings(value.removed) && strings(value.original)) {
    return { on: true, removed: [...value.removed], original: [...value.original] };
  }
  return { on: false, removed: [], original: [] };
}

/** `list` with each of `removed` put back where `original` had it, among the entries still there. */
export function putBack(list, removed, original) {
  const out = [...list];
  for (const name of original.filter((n) => removed.includes(n))) {
    if (out.includes(name)) continue;
    const before = original.slice(0, original.indexOf(name)).reverse().find((n) => out.includes(n));
    out.splice(before === undefined ? 0 : out.indexOf(before) + 1, 0, name);
  }
  return out;
}

/**
 * What to write so the list matches `want` (true: hide Files and Changes). Returns null when the
 * stored record already says so. Otherwise { state, list }: write `state` first, then `list` when it
 * isn't null (the record first, so a second copy reading in between sees the work as done).
 */
export function plan(current, stored, want) {
  const st = stateOf(stored), list = listOf(current);
  if (want && !st.on) {
    const removed = HIDDEN.filter((n) => list.includes(n));
    return {
      state: { on: true, removed, original: list },
      list: removed.length ? list.filter((n) => !removed.includes(n)) : null,
    };
  }
  if (!want && st.on) {
    const back = putBack(list, st.removed, st.original);
    return {
      state: { on: false, removed: [], original: [] },
      list: back.length === list.length ? null : back,
    };
  }
  return null;
}

/** Applies `want` through Herdr's shared(): `get(key)`, `set(key, value)`. Returns whether it wrote. */
export function sync(get, set, want) {
  const p = plan(get(PANELS), get(PANELS_KEY), Boolean(want));
  if (!p) return false;
  set(PANELS_KEY, p.state);
  if (p.list) set(PANELS, p.list);
  return true;
}
