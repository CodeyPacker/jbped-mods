// panelview.viewShown (P2): whether the Changes copy's block is on screen, from layout().
import { viewShown, viewPath } from "../mods/wingman/panelview.js";
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
console.log("panelview ok");
