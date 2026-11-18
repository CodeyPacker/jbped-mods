// model.rows (P6): an empty file shows one empty line for the cursor; a deleted file shows none.
import { rows, splitLines, wholeHunk } from "../mods/wingman/model.js";
import { linesOf, edit } from "../mods/wingman/edit.js";
import assert from "node:assert/strict";

const EMPTY = { kind: " ", num: 1, side: "new", line: 0 };
// New empty file, no review: B "" and C "".
assert.deepEqual(rows([], [], []), [EMPTY]);
// Deleted (not live): nothing to put a cursor on.
assert.deepEqual(rows([], [], [], false), []);
// The agent emptied a file: its removed lines, the hunk's buttons, then the empty line.
const B = splitLines("a\nb\n"), h = wholeHunk(B, []);
assert.deepEqual(h, [{ o: 0, oc: 2, n: 0, nc: 0 }]);
const r = rows(B, [], h);
assert.deepEqual(r.map((x) => x.kind), ["-", "-", "@", " "]);
assert.deepEqual(r[3], EMPTY);
assert.deepEqual(r.filter((x) => x.side === "new").map((x) => x.line), [0], "one line for the cursor");
// The agent deleted it (Ctext null): removed lines and buttons only.
assert.deepEqual(rows(B, [], h, false).map((x) => x.kind), ["-", "-", "@"]);
// An empty file the agent created: no hunk (both sides empty), the empty line.
assert.deepEqual(wholeHunk([], []), []);
assert.deepEqual(rows([], [], wholeHunk([], [])), [EMPTY]);
// A file with lines: no extra row.
const C = splitLines("x\n");
assert.deepEqual(rows(C, C, []), [{ kind: " ", num: 1, side: "new", line: 0 }]);
assert.equal(rows(splitLines("x"), splitLines("x\ny"), [{ o: 1, oc: 0, n: 1, nc: 1 }]).length, 3);

// Typing into the empty line starts there: the file gets its first line, still with no review change.
const s = { B: [], C: [], Btext: "", Ctext: "", hunks: [] };
assert.deepEqual(linesOf(s), [""]);
const { state, cursor } = edit(s, { line: 0, col: 0 }, { line: 0, col: 0 }, "hi");
assert.equal(state.Ctext, "hi"); assert.deepEqual(cursor, { line: 0, col: 2 });
assert.deepEqual(state.hunks, [], "an edit to an unreviewed empty file isn't a review change");
assert.deepEqual(rows(state.B, state.C, state.hunks), [EMPTY]);
console.log("rows ok");
