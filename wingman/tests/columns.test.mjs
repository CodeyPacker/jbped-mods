// columns.js: the Changes and Edit left column beside the diff or editor at any width. At half a
// panel the Changes column used to stay 320 px and leave the diff 80-140 px, with the file bar's
// Discard spilling out.
import assert from "node:assert/strict";
import { leftWidth, layoutOf, CONTENT_MIN, LEFT_MIN, WANT } from "../mods/wingman/columns.js";
import { fitBar } from "../mods/wingman/barfit.js";

// Room for both: the column keeps its width.
assert.equal(leftWidth(1000, WANT.changes), 320);
assert.equal(leftWidth(320 + CONTENT_MIN, WANT.changes), 320);
// Less: the column gives way, the content keeps CONTENT_MIN.
assert.equal(leftWidth(480, WANT.changes), 480 - CONTENT_MIN);
assert.equal(leftWidth(LEFT_MIN + CONTENT_MIN, WANT.edit), LEFT_MIN);
// Too narrow for both: one side at a time.
assert.equal(leftWidth(LEFT_MIN + CONTENT_MIN - 1, WANT.edit), 0);
// Not measured yet: as wanted.
assert.equal(leftWidth(0, WANT.editWide), 300);

// Every width from a 300 px panel (250 element px at zoom 1.2) up: nothing beside the column is
// narrower than CONTENT_MIN, the column never wider than wanted, the sides fill the width.
for (const want of [WANT.changes, WANT.edit, WANT.editWide]) {
  for (let w = 250; w <= 1400; w++) {
    for (const side of ["left", "content"]) {
      const c = layoutOf(w, want, side);
      if (!c.single) {
        assert.ok(c.left && c.content && c.leftW >= LEFT_MIN && c.leftW <= want, `${want}@${w}`);
        assert.ok(w - c.leftW >= CONTENT_MIN, `${want}@${w}: content ${w - c.leftW}`);
      } else {
        assert.ok(c.left !== c.content, `${want}@${w}: one side`);
        assert.equal(c.left, side === "left");
        if (c.left) assert.equal(c.leftW, w);
      }
    }
  }
}
// Changes at half a 1280 px window's panel (~560 screen px at zoom 1.2: 466 element px): both sides,
// the diff keeps CONTENT_MIN; at a 300 px panel: one side at a time.
assert.deepEqual(layoutOf(466, WANT.changes, "left"), { left: true, content: true, leftW: 246, single: false });
assert.equal(layoutOf(250, WANT.changes, "left").single, true);

// The file bar's buttons that always stay fit in CONTENT_MIN (main.js fileBar; its file-tabs area,
// flex_1 with min_w 0, gives way first): Discard with Cancel while it asks, and "‹ Files" when one
// side shows, at their labels for that width, with the bar's padding.
{
  const items = [
    { id: "back", labels: ["‹ Files", "‹"], drop: Infinity, size: 11, pad: 20 },
    { id: "discard-yes", labels: ["Discard all changes to this file", "Discard all changes", "Discard"], drop: Infinity, size: 11, pad: 20 },
    { id: "discard-no", labels: ["Cancel"], drop: Infinity, size: 11, pad: 20 },
  ];
  const fit = fitBar(CONTENT_MIN, items, 16);
  const used = [...fit.values()].length;
  assert.equal(used, 3);
}
console.log("columns ok");
