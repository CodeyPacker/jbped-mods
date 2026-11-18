// Herdr's app zoom (Settings › zoom, 1.2 by default on some screens). What Wingman draws is laid out
// in element px: w(), left(), h() and the font size are all scaled by the zoom. What Herdr reports
// back is in screen px, the zoom included: on_size_change sizes (w(100) measures 120 at zoom 1.2),
// a text's measured width, and the pointer's local_position and wheel deltas. Every measured value
// is turned into element px here before it meets a column, a row or an x position, so the caret,
// selections, find and Problems marks, clicks and sideways scrolling agree at any zoom.
// Pure: no Herdr imports.

/** The zoom: a 100 element px probe's measured width / 100 (1 until measured). */
export const unitOf = (probeWidth) => (probeWidth > 0 ? probeWidth / 100 : 1);

/** A measured length (screen px) in element px. */
export const toElem = (measured, unit) => measured / (unit > 0 ? unit : 1);

/** One character's width in element px, from the measured width of `chars` characters (null until measured). */
export const charWidth = (measured, chars, unit) => (measured > 0 && chars > 0 ? toElem(measured, unit) / chars : null);

/** The visual column under element x in a text area that starts at `gutter` and is scrolled `hx` sideways. */
export const colAtX = (x, gutter, hx, cw) => (x - gutter + hx) / cw;

/** The element x of visual column `vcol`. */
export const xOfCol = (vcol, cw, hx = 0) => vcol * cw - hx;

/** With line wrap on, the columns a row of `width` element px holds (at least 20). */
export const wrapColumns = (width, gutter, pad, cw) => Math.max(20, Math.floor((width - gutter - pad) / cw));
