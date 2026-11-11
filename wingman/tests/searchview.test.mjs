import assert from "node:assert/strict";
import { fmt, resultRows, occurrences, summaryOf, matchPieces, lineEdits, replaceState, MAX_RESULTS } from "../mods/wingman/searchview.js";
import { tokenSkip, matchBracket } from "../mods/wingman/brackets.js";
import { splitLines } from "../mods/wingman/model.js";
import { replacePlan } from "../mods/wingman/search.js";
import { check } from "../mods/wingman/edit.js";

// ---- numbers and rows ------------------------------------------------------------------------------
assert.equal(fmt(2000), "2,000");
assert.equal(fmt(12), "12");
assert.equal(fmt(1234567), "1,234,567");
assert.equal(MAX_RESULTS, 2000);

const files = [
  { key: "r|a.js", rel: "a.js", matches: [{ line: 1, col: 0, text: "foo foo", ranges: [[0, 3], [4, 7]] }, { line: 3, col: 2, text: "  foo", ranges: [[2, 5]] }] },
  { key: "r|b.js", rel: "b.js", matches: [{ line: 9, col: 0, text: "foo", ranges: [[0, 3]] }] },
];
const rows = resultRows(files);
assert.deepEqual(rows.map((r) => r.kind), ["file", "match", "match", "file", "match"]);
assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "row keys are unique");
assert.deepEqual(resultRows(files, new Set(["r|a.js"])).map((r) => r.kind), ["file", "file", "match"]);
assert.equal(occurrences(files), 4);

// ---- summary line ----------------------------------------------------------------------------------
assert.deepEqual(summaryOf({ repos: 0, plain: 2 }), { text: "Search covers git repos", error: false });
assert.equal(summaryOf({ repos: 1, running: true }).text, "Searching…");
assert.equal(summaryOf({ repos: 1, results: { files: [], total: 0 } }).text, "No results");
assert.equal(summaryOf({ repos: 1, results: { files, total: 12 } }).text, "12 results in 2 files");
assert.equal(summaryOf({ repos: 1, results: { files: [files[1]], total: 1 } }).text, "1 result in 1 file");
assert.equal(summaryOf({ repos: 2, results: { files, total: 2000, truncated: true } }).text, "Showing the first 2,000 results");
assert.deepEqual(summaryOf({ repos: 1, results: { files: [], total: 0, error: "Bad" } }), { text: "Bad", error: true });

// ---- match pieces ----------------------------------------------------------------------------------
assert.deepEqual(matchPieces("  let foo = foo;", [[6, 9], [12, 15]]), [
  { text: "let ", kind: "plain" }, { text: "foo", kind: "hit" }, { text: " = ", kind: "plain" }, { text: "foo", kind: "hit" }, { text: ";", kind: "plain" },
]);
// A match far into the line: "…" and a few characters before it.
const far = matchPieces("x".repeat(60) + "foo", [[60, 63]]);
assert.equal(far[0].text, "…");
assert.equal(far[far.length - 1].text, "foo");
assert.ok(far[1].text.length <= 12);
// Replace preview: old then new; in regex mode groups expand per match.
assert.deepEqual(matchPieces("a foo b", [[2, 5]], { opts: { query: "foo" }, replace: "bar" }), [
  { text: "a ", kind: "plain" }, { text: "foo", kind: "old" }, { text: "bar", kind: "new" }, { text: " b", kind: "plain" },
]);
assert.deepEqual(matchPieces("x(1) y(2)", [[0, 4], [5, 9]], { opts: { query: "(\\w)\\((\\d)\\)", regex: true }, replace: "$2$1" }).filter((p) => p.kind === "new").map((p) => p.text), ["1x", "2y"]);
// An empty replacement shows only the struck-through text.
assert.deepEqual(matchPieces("foo", [[0, 3]], { opts: { query: "foo" }, replace: "" }), [{ text: "foo", kind: "old" }]);

// ---- line edits ------------------------------------------------------------------------------------
assert.deepEqual(lineEdits("a\nb\r\nc", "a\nB\r\nc"), [{ line: 1, text: "B" }]);
assert.equal(lineEdits("a\nb", "a\nb\nc"), null);

// ---- replaceState keeps the review right -------------------------------------------------------------
// Baseline "one foo\ntwo\nthree foo\n"; the agent changed line 2 into "TWO foo" (a pending change).
const mk = (Btext, Ctext, hunks, plain = false) => ({ Btext, Ctext, B: splitLines(Btext), C: splitLines(Ctext), hunks, plain });
const f = mk("one foo\ntwo\nthree foo\n", "one foo\nTWO foo\nthree foo\n", [{ o: 1, oc: 1, n: 1, nc: 1 }]);
const [plan] = replacePlan([{ rel: "x", matches: [{ line: 1 }, { line: 2 }, { line: 3 }] }], { x: f.Ctext }, { query: "foo" }, "bar");
assert.equal(plan.count, 3);
const r = replaceState(f, plan.text);
assert.equal(r.state.Ctext, "one bar\nTWO bar\nthree bar\n");
// Unchanged lines took the edit in the baseline too; the agent's line stays its pending change.
assert.equal(r.state.Btext, "one bar\ntwo\nthree bar\n");
assert.deepEqual(r.state.hunks, [{ o: 1, oc: 1, n: 1, nc: 1 }]);
check(r.state);
assert.deepEqual(r.writes, [
  { target: "current", before: f.Ctext, after: "one bar\nTWO bar\nthree bar\n" },
  { target: "baseline", before: f.Btext, after: "one bar\ntwo\nthree bar\n" },
]);
// A file outside the review: only the file is written.
const p = mk("foo\r\nx\r\n", "foo\r\nx\r\n", [], true);
const rp = replaceState(p, "bar\r\nx\r\n");
assert.deepEqual(rp.writes, [{ target: "current", before: "foo\r\nx\r\n", after: "bar\r\nx\r\n" }]);
// No line terminator at the end, and a replacement that empties the last line.
const q = mk("a\nfoo", "a\nfoo", [], true);
assert.equal(replaceState(q, "a\n").state.Ctext, "a\n");
assert.equal(replaceState(q, "a\nb\nc"), null);

// ---- tokenSkip: brackets in strings and comments don't count -----------------------------------------
const lines = ['f("(", x) // )', "g(y)"];
const tok = [
  [{ text: "f", type: "function" }, { text: "(", type: "punctuation" }, { text: '"("', type: "string" }, { text: ", x", type: null }, { text: ")", type: "punctuation" }, { text: " ", type: null }, { text: "// )", type: "comment" }],
  [{ text: "g", type: null }, { text: "(y)", type: null }],
];
const skip = tokenSkip(tok, lines);
assert.equal(skip(0, 3), true); // the "(" inside the string
assert.equal(skip(0, 13), true); // the ")" in the comment
assert.equal(skip(0, 1), false);
assert.deepEqual(matchBracket(lines, { line: 0, col: 1 }, { skip }), { open: { line: 0, col: 1 }, close: { line: 0, col: 8 } });
// Spans that don't add up to the line (stale after an edit) hide nothing.
const stale = tokenSkip([[{ text: '"("', type: "string" }]], ['"(" more']);
assert.equal(stale(0, 1), false);
// No tokens at all: nothing is hidden.
assert.equal(tokenSkip(undefined)(0, 0), false);

console.log("searchview tests pass");
