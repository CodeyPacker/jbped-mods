import assert from "node:assert/strict";
const { typed, inEmptyPair, betweenBrackets } = await import("../mods/wingman/pairs.js");
assert.deepEqual(typed("(", "foo", 3), { insert: "()" });
assert.deepEqual(typed("(", "foo bar", 3), { insert: "()" });   // before space
assert.equal(typed("(", "foobar", 3), null);                     // before a word
assert.deepEqual(typed("(", "a)", 1), { insert: "()" });         // before a closer
assert.deepEqual(typed(")", "f()", 2), { skip: true });          // step over
assert.deepEqual(typed('"', "x = ", 4), { insert: '""' });
assert.equal(typed("'", "don", 3), null);                         // apostrophe
assert.deepEqual(typed("'", "'a'", 2), { skip: true });
assert.equal(typed("a", "", 0), null);
assert.deepEqual(typed("{", "if (x) ", 7), { insert: "{}" });
assert.equal(inEmptyPair("f()", 2), true);
assert.equal(inEmptyPair("f(x)", 2), false);
assert.equal(inEmptyPair('""', 1), true);
assert.equal(betweenBrackets("{}", 1), true);
assert.equal(betweenBrackets('""', 1), false);
console.log("pairs tests pass");
