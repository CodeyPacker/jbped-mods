import { segments, segmentOf } from "../mods/wingman/wrap.js";
import assert from "node:assert/strict";
const join = (t, w) => segments(t, w).map((x) => t.slice(x.from, x.to));
assert.deepEqual(segments("short", 20), [{ from: 0, to: 5, ind: 0 }]);
assert.deepEqual(join("hello world foo bar", 11), ["hello ", "world foo ", "bar"]);
assert.deepEqual(join("abcdefghijklmnop", 8), ["abcdefgh", "ijklmnop"]);
const ind = "    const x = something + other";
const s = segments(ind, 16);
assert.deepEqual(join(ind, 16), ["    const x = ", "something + ", "other"]);
assert.equal(s[1].ind, 4);
for (const [t, w] of [["a b c d e f g h i j k l m n o p", 9], ["\tfoo\tbar baz qux", 8], ["x".repeat(100), 10], ["   ", 8], ["", 8]]) {
  const g = segments(t, w);
  assert.equal(g.map((x) => t.slice(x.from, x.to)).join(""), t, "covers: " + t);
  for (let i = 1; i < g.length; i++) assert.equal(g[i].from, g[i - 1].to);
}
const g = segments("hello world foo bar", 11);
assert.equal(segmentOf(g, 0), 0); assert.equal(segmentOf(g, 6), 1); assert.equal(segmentOf(g, 19), 2); assert.equal(segmentOf(g, 5), 0);
console.log("wrap tests pass");
