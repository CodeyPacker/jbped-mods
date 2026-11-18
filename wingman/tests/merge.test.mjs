import assert from "node:assert/strict";
const M = "../mods/wingman/merge.js";
const { merge3, diffHunks, changedRanges, mapLine } = await import(M);
const L = (...a) => a.map((x) => x + "\n").join("");
const base = L("a", "b", "c", "d", "e");
// clean merge: mine edits b, agent edits d
let r = await merge3(base, L("a", "B", "c", "d", "e"), L("a", "b", "c", "D", "e"));
assert.deepEqual(r, { text: L("a", "B", "c", "D", "e"), conflicts: 0 });
// overlap
r = await merge3(base, L("a", "b", "MINE", "d", "e"), L("a", "b", "AGENT", "d", "e"));
assert.equal(r.conflicts, 1); assert.match(r.text, /<<<<<<</);
assert.equal((await merge3(base, L("a", "b", "MINE", "d", "e"), L("a", "b", "AGENT", "d", "e"), "theirs")).text, L("a", "b", "AGENT", "d", "e"));
assert.equal((await merge3(base, L("a", "b", "MINE", "d", "e"), L("a", "b", "AGENT", "d", "e"), "ours")).text, L("a", "b", "MINE", "d", "e"));
// CRLF kept
const crlf = (s) => s.replace(/\n/g, "\r\n");
r = await merge3(crlf(base), crlf(L("a", "B", "c", "d", "e")), crlf(L("a", "b", "c", "D", "e")));
assert.equal(r.text, crlf(L("a", "B", "c", "D", "e")));
// shortcuts
assert.equal((await merge3(base, base, "x\n")).text, "x\n");
assert.equal((await merge3(base, "m\n", base)).text, "m\n");
// diff
assert.deepEqual(await diffHunks(base, L("a", "X", "c", "d", "e", "f")), [{ o: 1, oc: 1, n: 1, nc: 1 }, { o: 5, oc: 0, n: 5, nc: 1 }]);
// ranges and cursor mapping
assert.deepEqual(changedRanges(base, L("a", "b", "c", "d", "e")), []);
assert.deepEqual(changedRanges(base, L("new", "a", "b", "c", "d", "e")), [{ o: 0, oc: 0, n: 0, nc: 1 }]);
assert.equal(mapLine(3, base, L("new", "new2", "a", "b", "c", "d", "e")), 5);
assert.equal(mapLine(0, base, L("a", "b", "c", "d", "e", "z")), 0);
assert.equal(mapLine(4, base, L("a", "e")), 1);
assert.equal(mapLine(2, base, L("a", "e")), 1);
console.log("merge tests pass");
