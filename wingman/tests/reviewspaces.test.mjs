// panelview.layoutHasWingman / reviewedSpaces: which spaces are reviewed.
import { layoutHasWingman, reviewedSpaces } from "../mods/wingman/panelview.js";
import assert from "node:assert/strict";

const wing = (id, view) => ({ id, type: "block", content: { mod: "wingman", props: { view } } });
const withPanel = {
  id: "root", type: "row", children: [
    { id: "side", type: "column", children: [{ id: "sp", type: "block", content: { mod: "space-folders" } }] },
    { id: "work", type: "column", children: [
      { id: "main", type: "block", content: { tab: "active" } },
      { id: "panel", type: "stack", children: [{ id: "f", type: "block", content: { mod: "files" } }, { id: "r", type: "row", children: [wing("w", "review")] }] },
    ] },
  ],
};
const without = { id: "root", type: "row", children: [{ id: "a", type: "block", content: { mod: "files" } }, { id: "b", type: "block", content: { tab: "active" } }] };
assert.equal(layoutHasWingman(withPanel), true, "nested in column, stack, row");
assert.equal(layoutHasWingman(without), false);
assert.equal(layoutHasWingman(null), false);
assert.equal(layoutHasWingman(undefined), false);

const spaces = [{ id: "s1", tabs: [{ id: "t1" }] }, { id: "s2", tabs: [{ id: "t2" }] }, { id: "s3", tabs: [] }];
const panes = [{ mod: "wingman", tab: "t2" }, { mod: "other", tab: "t1" }, { tab: "t1" }];
assert.deepEqual(reviewedSpaces(spaces, panes, true).map((s) => s.id), ["s1", "s2", "s3"], "layout block: every space");
assert.deepEqual(reviewedSpaces(spaces, panes, false).map((s) => s.id), ["s2"], "no layout block: spaces with a Wingman pane");
assert.deepEqual(reviewedSpaces(spaces, [], false), [], "no layout block, no pane");
