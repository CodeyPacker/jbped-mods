// zoom.js: measured sizes and pointer positions (screen px, the app's zoom included) become element
// px before they meet columns and x positions, so the caret, marks and clicks agree at zoom 1.2.
import { unitOf, toElem, charWidth, colAtX, xOfCol, wrapColumns } from "../mods/wingman/zoom.js";
import assert from "node:assert/strict";

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

// The probe: w(100) measures 120 at zoom 1.2, 100 at 1.0; unmeasured is 1.
close(unitOf(120), 1.2, "unit at 1.2");
assert.equal(unitOf(100), 1);
assert.equal(unitOf(0), 1);
assert.equal(unitOf(undefined), 1);
close(toElem(1152, 1.2), 960, "a 960 px panel measured at 1.2");
assert.equal(toElem(500, undefined), 500, "unit unknown: as measured");

// The report: 100 characters of the 12 px mono font measure 864.6 at zoom 1.2 (8.65 each); a
// character is 7.2 element px, which is what left() and w() take.
close(charWidth(864.6, 100, 1.2), 7.205, "char width in element px at 1.2");
close(charWidth(720.5, 100, 1), 7.205, "char width at 1.0");
assert.equal(charWidth(0, 100, 1.2), null);
assert.equal(charWidth(undefined, 100, 1.2), null);

// Caret and marks: column 68 sits at the same element x at any zoom (it was 68 * 8.65 = 588 before
// the fix at 1.2, 98 px too far right, growing with the column).
const GUTTER = 58;
for (const unit of [1, 1.2, 1.5]) {
  const cw = charWidth(720.5 * unit, 100, unit);
  close(xOfCol(68, cw), 68 * 7.205, `x of col 68 at ${unit}`);
  // A click: the pointer's local x in screen px, mapped back to the column it is over (the middle of col 68).
  const screenX = (GUTTER + xOfCol(68.5, cw)) * unit;
  assert.equal(Math.floor(colAtX(toElem(screenX, unit), GUTTER, 0, cw)), 68, `click on col 68 at ${unit}`);
  // Scrolled sideways by 300 element px: the same click finds the column 300 px further on.
  const hx = 300, sx = (GUTTER + xOfCol(68.5, cw, hx)) * unit;
  assert.equal(Math.floor(colAtX(toElem(sx, unit), GUTTER, hx, cw)), 68, `scrolled click at ${unit}`);
  // Wrapping: a 960 element px diff holds the same columns at any zoom.
  assert.equal(wrapColumns(toElem(960 * unit, unit), GUTTER, 16, cw), Math.floor((960 - GUTTER - 16) / 7.205), `wrap columns at ${unit}`);
}
assert.equal(wrapColumns(100, GUTTER, 16, 7.2), 20, "at least 20 columns");
