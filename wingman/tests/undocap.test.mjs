// The undo history's bound: steps and text, oldest dropped first, the newest always kept.
import { UNDO, stepCost, capSteps } from "../mods/wingman/undocap.js";
import assert from "node:assert/strict";

const edit = (n) => ({ edit: true, state: { Btext: "b".repeat(1000), Ctext: "c".repeat(n) } });
const review = (b, c) => ({ snaps: [{ Btext: "x".repeat(b), Ctext: c == null ? null : "y".repeat(c) }], writes: [] });

assert.equal(stepCost(edit(10)), 11); // the shared baseline isn't counted
assert.equal(stepCost(review(5, 7)), 13);
assert.equal(stepCost(review(5, null)), 6);
assert.ok(UNDO.steps === 200 && UNDO.bytes === 24e6);

// Under both limits: untouched.
let h = [edit(1), edit(2), edit(3)];
assert.equal(capSteps(h, { steps: 3, bytes: 100 }), 0);
assert.equal(h.length, 3);
// Over the step count: oldest go.
h.push(edit(4));
assert.equal(capSteps(h, { steps: 3, bytes: 100 }), 1);
assert.deepEqual(h.map((s) => s.state.Ctext.length), [2, 3, 4]);
// Over the text budget: oldest go until it fits.
h = [edit(40), edit(40), edit(40)];
assert.equal(capSteps(h, { steps: 200, bytes: 90 }), 1);
assert.equal(h.length, 2);
// One step larger than the whole budget stays: it's the only way back.
h = [edit(10), edit(1000)];
assert.equal(capSteps(h, { steps: 200, bytes: 100 }), 1);
assert.equal(h.length, 1);
// Costs are measured once and kept on the step.
assert.equal(h[0].cost, 1001);
// The default limits: 250 small steps keep the newest 200, in order.
h = Array.from({ length: 250 }, (_, i) => ({ ...edit(1), i }));
assert.equal(capSteps(h), 50);
assert.equal(h[0].i, 50); assert.equal(h.at(-1).i, 249);
