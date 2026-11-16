// panelview.viewShown (P2): whether the Changes copy's block is on screen, from layout().
import { viewShown, viewPath, copyView } from "../mods/wingman/panelview.js";
import assert from "node:assert/strict";

const block = (id, view) => ({ id, type: "block", content: { mod: "wingman", props: { view } } });
const layout = (active, panelHidden = false) => ({
  id: "root", type: "row", children: [
    { id: "main", type: "block", content: { tab: "active" } },
    { id: "panel", type: "column", hidden: panelHidden, children: [
      { id: "tabs", type: "block", content: { mod: "tabs-plus" } },
      { id: "panel-body", type: "stack", active, children: [{ id: "files", type: "block", content: { mod: "files" } }, block("wingman-review", "review"), block("wingman-changes", "changes")] },
    ] },
  ],
});
assert.equal(viewShown(layout("wingman-changes"), "changes"), true);
assert.equal(viewShown(layout("wingman-review"), "changes"), false, "another tab of the stack is shown");
assert.equal(viewShown(layout("wingman-review"), "review"), true);
assert.equal(viewShown(layout("wingman-changes", true), "changes"), false, "the panel is hidden");
assert.equal(viewShown(layout(undefined), "changes"), false, "a stack without active shows its first child");
assert.equal(viewShown(layout(undefined), "edit"), null, "no such block: unknown");
assert.equal(viewShown(null, "changes"), null);
assert.equal(viewShown(undefined, "changes"), null);
assert.deepEqual(viewPath(layout("x"), "changes").map((n) => n.id), ["root", "panel", "panel-body", "wingman-changes"]);
// Nested stacks: every one on the path must show it.
const nested = { id: "s1", type: "stack", active: "s2", children: [{ id: "s2", type: "stack", active: "c", children: [block("c", "changes")] }, block("e", "edit")] };
assert.equal(viewShown(nested, "changes"), true);
assert.equal(viewShown({ ...nested, active: "e" }, "changes"), false);
// copyView (X5): a panel copy keeps its one view; a tab opened with props.view outside the panel
// layout starts in that view as a pane copy (it takes the dialogs' jumps); Changes stays Changes.
const plain = { id: "root", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }] };
assert.deepEqual(copyView("review", layout("wingman-review")), { view: "review", mode: "review" });
assert.deepEqual(copyView("review", plain), { view: null, mode: "review" });
assert.deepEqual(copyView("edit", plain), { view: null, mode: "edit" });
assert.deepEqual(copyView("edit", layout("wingman-review")), { view: null, mode: "edit" }, "this layout has no Edit block");
assert.deepEqual(copyView("changes", plain), { view: "changes", mode: "changes" });
assert.deepEqual(copyView(undefined, layout("x")), { view: null, mode: "review" });
assert.deepEqual(copyView("bogus", plain), { view: null, mode: "review" });
assert.deepEqual(copyView("review", null), { view: null, mode: "review" });
console.log("panelview ok");
