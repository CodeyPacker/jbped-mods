// retain.js (F3): which kept space views let their loaded files go.
import { toLighten, HEAVY_VIEWS } from "../mods/wingman/retain.js";
import assert from "node:assert/strict";

const v = (light = false, pinned = false) => ({ light, pinned });
assert.equal(HEAVY_VIEWS, 3);
// Oldest first: only those beyond the newest three heavy ones.
assert.deepEqual(toLighten([["s1", v()], ["s2", v()], ["s3", v()], ["s4", v()], ["s5", v()]], 3), ["s1", "s2"]);
assert.deepEqual(toLighten([["s1", v()], ["s2", v()], ["s3", v()]], 3), []);
// Unsaved edits or undo steps pin a view: it's never made light.
assert.deepEqual(toLighten([["s1", v(false, true)], ["s2", v()], ["s3", v()], ["s4", v()], ["s5", v()]], 3), ["s2"]);
// Views already light don't count toward the heavy ones.
assert.deepEqual(toLighten([["s1", v(true)], ["s2", v()], ["s3", v(true)], ["s4", v()], ["s5", v()]], 3), []);
assert.deepEqual(toLighten([["s1", v()], ["s2", v()]], 0), ["s1", "s2"]);
console.log("retain ok");
