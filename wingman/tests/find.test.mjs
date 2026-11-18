import assert from "node:assert/strict";
const F = await import("../mods/wingman/find.js");
const T = ["foo bar foo", "Foo", "", "barfoo"];
let c = F.compile("foo");
assert.deepEqual(F.findAll(T, c.re), [{ line: 0, from: 0, to: 3 }, { line: 0, from: 8, to: 11 }, { line: 1, from: 0, to: 3 }, { line: 3, from: 3, to: 6 }]);
assert.equal(F.findAll(T, F.compile("foo", { cased: true }).re).length, 3);
assert.equal(F.findAll(T, F.compile("foo", { word: true }).re).length, 3);
assert.equal(F.findAll(T, F.compile("a.", { regex: false }).re).length, 0);
assert.equal(F.findAll(T, F.compile("^", { regex: true }).re).length, 0); // empty matches skipped
assert.ok(F.compile("(", { regex: true }).error);
assert.equal(F.compile(""), null);
const ms = F.findAll(T, c.re);
assert.equal(F.nextMatch(ms, { line: 0, col: 0 }), 1);
assert.equal(F.nextMatch(ms, { line: 0, col: 0 }, true), 0);
assert.equal(F.nextMatch(ms, { line: 3, col: 3 }), 0); // wraps
assert.equal(F.prevMatch(ms, { line: 1, col: 0 }), 1);
assert.equal(F.prevMatch(ms, { line: 0, col: 0 }), 3); // wraps
const r = F.compile("(\\w+)@(\\w+)", { regex: true }).re;
assert.equal(F.replacement("a@b", r, "$2@$1", true), "b@a");
assert.equal(F.replacement("a@b", r, "$2", false), "$2");
assert.deepEqual(F.parseLine("12"), { line: 11, col: 0 });
assert.deepEqual(F.parseLine(" 3:7 "), { line: 2, col: 6 });
assert.equal(F.parseLine("x"), null);
console.log("find tests pass");
