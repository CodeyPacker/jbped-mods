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

// segments() runs inside render(), which Herdr stops after about 50 ms ("This view could not be
// re-rendered", interrupted). Measured in Herdr 0.1.16: wrap.js was about 95x slower there than in
// Node, so a long line must wrap in linear time. The quadratic version took about 2 s in Node here.
{
  const long = "const answer = someFunction(argumentNumberOne, argumentNumberTwo); ".repeat(400); // ~27,000 chars
  const t0 = performance.now();
  const g = segments(long, 90);
  const ms = performance.now() - t0;
  assert.equal(g.map((x) => long.slice(x.from, x.to)).join(""), long);
  assert.ok(ms < 30, `a 27,000 character line wraps in ${ms.toFixed(1)} ms (want < 30)`);
  const noSpace = "x".repeat(30000), t1 = performance.now();
  assert.equal(segments(noSpace, 90).length, Math.ceil(30000 / 90));
  assert.ok(performance.now() - t1 < 30, "a 30,000 character line without spaces wraps in linear time");
}

// Same segments as the straightforward (quadratic) definition, on lines with tabs, spaces and indents.
{
  const TAB = 4;
  const vcol = (text, col) => { let v = 0; for (let i = 0; i < col && i < text.length; i++) v = text[i] === "\t" ? v + TAB - (v % TAB) : v + 1; return v + Math.max(0, col - text.length); };
  const reference = (text, width) => {
    width = Math.max(8, Math.floor(width));
    const len = text.length;
    if (vcol(text, len) <= width) return [{ from: 0, to: len, ind: 0 }];
    const lead = vcol(text, /^\s*/.exec(text)[0].length), ind = lead < width / 2 ? lead : 0, out = [];
    let from = 0;
    while (from < len) {
      const room = out.length ? width - ind : width, v0 = vcol(text, from);
      let to = from;
      while (to < len && vcol(text, to + 1) - v0 <= room) to++;
      if (to === from) to = from + 1;
      if (to < len) { const sp = text.lastIndexOf(" ", to - 1); if (sp >= from && sp + 1 > from && text.slice(from, sp).trim()) to = sp + 1; }
      out.push({ from, to, ind: out.length ? ind : 0 });
      from = to;
    }
    return out;
  };
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const alphabet = "ab cd\tef  gh";
  for (let k = 0; k < 2000; k++) {
    const n = rnd(200), lead = " \t".repeat(rnd(4));
    let text = lead;
    for (let i = 0; i < n; i++) text += alphabet[rnd(alphabet.length)];
    const w = 8 + rnd(60);
    assert.deepEqual(segments(text, w), reference(text, w), `width ${w}: ${JSON.stringify(text)}`);
  }
}
console.log("wrap tests pass");
