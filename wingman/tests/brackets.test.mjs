import assert from "node:assert/strict";
const { matchBracket } = await import("../mods/wingman/brackets.js");

// Cursor before an opener: pair starts at the cursor.
assert.deepEqual(matchBracket(["f(x)"], { line: 0, col: 1 }), {
  open: { line: 0, col: 1 }, close: { line: 0, col: 3 },
});
// Cursor after a closer: pair found by scanning backward.
assert.deepEqual(matchBracket(["f(x)"], { line: 0, col: 4 }), {
  open: { line: 0, col: 1 }, close: { line: 0, col: 3 },
});
// Between ")(": the bracket after the cursor wins.
assert.deepEqual(matchBracket([")()"], { line: 0, col: 1 }), {
  open: { line: 0, col: 1 }, close: { line: 0, col: 2 },
});
// Nested pairs of the same kind.
assert.deepEqual(matchBracket(["((a)(b))"], { line: 0, col: 0 }), {
  open: { line: 0, col: 0 }, close: { line: 0, col: 7 },
});
assert.deepEqual(matchBracket(["((a)(b))"], { line: 0, col: 3 }), {
  open: { line: 0, col: 1 }, close: { line: 0, col: 3 },
});
// Mixed kinds: matches by kind only.
assert.deepEqual(matchBracket(["([)]"], { line: 0, col: 0 }), {
  open: { line: 0, col: 0 }, close: { line: 0, col: 2 },
});
assert.deepEqual(matchBracket(["([)]"], { line: 0, col: 1 }), {
  open: { line: 0, col: 1 }, close: { line: 0, col: 3 },
});
// Across several lines, backward from a closer.
assert.deepEqual(matchBracket(["fn {", "  if (x) {", "  }", "}"], { line: 3, col: 1 }), {
  open: { line: 0, col: 3 }, close: { line: 3, col: 0 },
});
assert.deepEqual(matchBracket(["fn {", "  if (x) {", "  }", "}"], { line: 2, col: 3 }), {
  open: { line: 1, col: 9 }, close: { line: 2, col: 2 },
});
// Unmatched gives null.
assert.equal(matchBracket(["f(x"], { line: 0, col: 1 }), null);
assert.equal(matchBracket(["x)"], { line: 0, col: 2 }), null);
// No bracket at the cursor.
assert.equal(matchBracket(["abc"], { line: 0, col: 1 }), null);
assert.equal(matchBracket([""], { line: 0, col: 0 }), null);
// skip hides a bracket inside a string literal.
const line = 's = ")" + (1)';
const inString = (l, c) => c >= 4 && c <= 6;
assert.deepEqual(matchBracket([line], { line: 0, col: 10 }, { skip: inString }), {
  open: { line: 0, col: 10 }, close: { line: 0, col: 12 },
});
assert.deepEqual(matchBracket(['f("(")'], { line: 0, col: 1 }, { skip: (l, c) => c === 3 }), {
  open: { line: 0, col: 1 }, close: { line: 0, col: 5 },
});
assert.equal(matchBracket(['f("(")'], { line: 0, col: 1 }), null);
// maxLines: the scan covers 3 lines including the cursor's line.
const near = ["(", "", ")"];
const far = ["(", "", "", ")"];
assert.deepEqual(matchBracket(near, { line: 0, col: 0 }, { maxLines: 3 }), {
  open: { line: 0, col: 0 }, close: { line: 2, col: 0 },
});
assert.equal(matchBracket(far, { line: 0, col: 0 }, { maxLines: 3 }), null);
assert.deepEqual(matchBracket(far, { line: 3, col: 1 }, { maxLines: 3 }), null);
assert.deepEqual(matchBracket(far, { line: 3, col: 1 }, { maxLines: 4 }), {
  open: { line: 0, col: 0 }, close: { line: 3, col: 0 },
});
console.log("brackets tests pass");
