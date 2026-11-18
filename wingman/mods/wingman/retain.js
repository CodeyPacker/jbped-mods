// How much of each visited space's view a copy keeps. Pure. A copy keeps a view per space it
// showed; the most recent HEAVY_VIEWS keep their loaded files, the rest keep only what restores
// the view (selection, opened files, search, commit box) and load again when shown.

export const HEAVY_VIEWS = 3;

/**
 * The views to make light: `views` is [key, { pinned, light }] from least to most recently left
 * (a Map's order); pinned ones (unsaved edits, undo steps) and the newest `n` stay as they are.
 */
export function toLighten(views, n = HEAVY_VIEWS) {
  const heavy = views.filter(([, v]) => !v.light);
  const out = [];
  for (let i = 0; i < heavy.length - n; i++) if (!heavy[i][1].pinned) out.push(heavy[i][0]);
  return out;
}
