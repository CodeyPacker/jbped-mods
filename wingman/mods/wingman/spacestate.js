// Where an async result lands. Pure. A copy shows one space at a time on its own fields and keeps
// every other space's state in `views` (main.js snapshotView). Work started for one space (a load,
// a refresh, a write, an editor launch) reports into that space's state when it ends, shown or
// kept, never into whichever space is shown by then: a failing repo in one space must never show
// its error in another.

/** The state of `space`: the copy itself while it's shown, else its kept view (null when gone). */
export function stateFor(copy, space) {
  return space === copy.spaceId ? copy : copy.views?.get(space) ?? null;
}

/** Puts `msg` as the error line of `space`'s state; nothing when the space is gone. */
export function failIn(copy, space, msg) {
  const s = stateFor(copy, space);
  if (s) s.error = msg;
  return s;
}

/**
 * A failed load or refresh of a space's lists: shown as its error, and remembered as the load's own
 * (loadError) so the next pass that succeeds takes it away again. Any other message stays.
 */
export function loadFailed(copy, space, msg) {
  const s = failIn(copy, space, msg);
  if (s) s.loadError = msg;
  return s;
}

/** A load or refresh of the shown space succeeded: its load error, if still shown, goes. True when it went. */
export function loadOk(s) {
  if (!s?.loadError) return false;
  const shown = s.error === s.loadError;
  if (shown) s.error = null;
  s.loadError = null;
  return shown;
}
