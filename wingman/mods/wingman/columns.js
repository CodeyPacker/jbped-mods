// The left column of the Changes and Edit views (the file list and commit box; the tree, Search,
// Problems) beside the diff or editor, in a pane or panel of any width. The content side keeps
// CONTENT_MIN; the column gives way to it down to LEFT_MIN; below that the view shows one side at
// a time (Changes: the list, or a file's diff with "‹ Files"; Edit: the editor, or the column in its
// place with ctrl-b). Element px throughout (zoom.js). Pure: no Herdr imports.

/** What the diff or editor keeps beside the column: the file bar's must-stay buttons fit in it. */
export const CONTENT_MIN = 220;
/** The narrowest the column gets before the view shows one side at a time. */
export const LEFT_MIN = 180;
/** The column's own width when there's room: Changes', Edit's (Explorer, Agent files), Edit's with Search or Problems. */
export const WANT = { changes: 320, edit: 260, editWide: 300 };

/**
 * The column's width beside the content in a view `width` element px wide: `want` when the content
 * keeps CONTENT_MIN, else what leaves the content CONTENT_MIN (at least LEFT_MIN), else 0: one side
 * at a time. An unmeasured width (0 or less) gives `want`.
 */
export function leftWidth(width, want) {
  if (!(width > 0) || width - want >= CONTENT_MIN) return want;
  if (width - LEFT_MIN >= CONTENT_MIN) return Math.floor(width - CONTENT_MIN);
  return 0;
}

/**
 * Which sides show: { left, content } booleans and the column's width. `side`: the side picked
 * while one side shows at a time ("left" or "content"; Changes starts on its list, Edit on the editor).
 */
export function layoutOf(width, want, side) {
  const left = leftWidth(width, want);
  if (left > 0) return { left: true, content: true, leftW: left, single: false };
  const showLeft = side === "left";
  return { left: showLeft, content: !showLeft, leftW: showLeft ? Math.max(0, Math.floor(width)) : 0, single: true };
}
