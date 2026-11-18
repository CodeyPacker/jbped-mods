import { edit, check, linesOf, body, wordMove, wordAt, textBetween, indentUnit, visualCol, charAt, expandTabs } from "../mods/wingman/edit.js";
import { splitLines, acceptAt, rejectAt, segmentHunks } from "../mods/wingman/model.js";
import assert from "node:assert";

const mk = (Bt, Ct) => {
  const B = splitLines(Bt), C = splitLines(Ct);
  return { B, C, Btext: Bt, Ctext: Ct, hunks: segmentHunks(B, C, 0, 0), oldTok: B.map(() => []), newTok: C.map(() => []) };
};
const tok = (ls) => ls.map(() => []);
// 1. typing on an unchanged line goes into B too
let s = mk("a\nb\nc\n", "a\nB\nc\n");
let r = edit(s, { line: 0, col: 1 }, { line: 0, col: 1 }, "x", tok);
check(r.state); assert.equal(r.state.Btext, "ax\nb\nc\n"); assert.equal(r.state.Ctext, "ax\nB\nc\n"); assert.equal(r.state.hunks.length, 1);
// 2. typing in an added line: C only, change stays one hunk
r = edit(s, { line: 1, col: 1 }, { line: 1, col: 1 }, "2", tok);
check(r.state); assert.equal(r.state.Btext, s.Btext); assert.equal(r.state.Ctext, "a\nB2\nc\n"); assert.deepEqual(r.state.hunks, [{ o: 1, oc: 1, n: 1, nc: 1 }]);
// 3. Enter at end of unchanged line: new line accepted
r = edit(s, { line: 2, col: 1 }, { line: 2, col: 1 }, "\nnew", tok);
check(r.state); assert.equal(r.state.Btext, "a\nb\nc\nnew\n"); assert.deepEqual(r.cursor, { line: 3, col: 3 });
// 4. Enter at end of added line: part of the change
r = edit(s, { line: 1, col: 1 }, { line: 1, col: 1 }, "\nmore", tok);
check(r.state); assert.deepEqual(r.state.hunks, [{ o: 1, oc: 1, n: 1, nc: 2 }]);
// 5. join across change and unchanged line: re-diffed
r = edit(s, { line: 1, col: 1 }, { line: 2, col: 0 }, "", tok);
check(r.state); assert.equal(r.state.Ctext, "a\nBc\n"); assert.equal(r.state.Btext, s.Btext);
// 6. CRLF kept
s = mk("a\r\nb\r\n", "a\r\nb\r\n");
r = edit(s, { line: 0, col: 1 }, { line: 0, col: 1 }, "\n", tok); check(r.state); assert.equal(r.state.Ctext, "a\r\n\r\nb\r\n");
// 7. pure deletion between edited unchanged lines -> mixed
s = mk("a\nX\nb\n", "a\nb\n");
r = edit(s, { line: 0, col: 1 }, { line: 1, col: 0 }, "", tok); check(r.state); assert.equal(r.state.Ctext, "ab\n");
// helpers
const L = ["  foo.bar(x)\n", "\tbaz\n"];
assert.deepEqual(wordMove(L, { line: 0, col: 12 }, -1), { line: 0, col: 11 });
assert.deepEqual(wordMove(L, { line: 0, col: 2 }, 1), { line: 0, col: 5 });
assert.deepEqual(wordMove(L, { line: 1, col: 0 }, -1), { line: 0, col: 12 });
assert.deepEqual(wordAt(L, { line: 0, col: 3 }), [{ line: 0, col: 2 }, { line: 0, col: 5 }]);
assert.equal(textBetween(L, { line: 0, col: 6 }, { line: 1, col: 2 }), "bar(x)\n\tb");
assert.equal(indentUnit(L), "\t"); assert.equal(indentUnit(["    a\n", "        b\n"]), "    ");
assert.equal(visualCol("\tb", 1), 4); assert.equal(charAt("\tb", 4), 1); assert.equal(charAt("\tb", 1), 0);
assert.equal(expandTabs([{ text: "a\tb" }])[0].text, "a   b");

// random walk: hunks stay valid through edits, accepts and rejects
let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
const words = ["x", "\n", "foo", "", "a\nb", "\n\n", "zz"];
let steps = 0;
for (let file = 0; file < 6; file++) {
  const base = Array.from({ length: 12 }, (_, i) => `l${i}\n`).join("");
  let cur = base.split("\n").map((l, i) => (rnd(3) === 0 ? `m${l}` : l)).filter((_, i) => rnd(6) !== 0).join("\n");
  s = mk(base, cur);
  for (let k = 0; k < 120; k++) {
    const op = rnd(10);
    if (op < 1 && s.hunks.length) s = acceptAt(s, rnd(s.hunks.length)).state;
    else if (op < 2 && s.hunks.length) s = rejectAt(s, rnd(s.hunks.length)).state;
    else {
      const lines = linesOf(s), la = rnd(lines.length), lb = Math.min(lines.length - 1, la + rnd(3));
      const a = { line: la, col: rnd(body(lines[la]).length + 1) }, b = { line: lb, col: rnd(body(lines[lb]).length + 1) };
      const t = words[rnd(words.length)];
      const expect = (() => { const ls = linesOf(s); const [x, y] = (a.line < b.line || (a.line === b.line && a.col <= b.col)) ? [a, b] : [b, a];
        const off = (p) => ls.slice(0, p.line).join("").length + p.col; const txt = ls.join(""); return txt.slice(0, off(x)) + t + txt.slice(off(y)); })();
      s = edit(s, a, b, t, tok).state;
      assert.equal(s.Ctext, expect, "edit text");
      assert.equal(s.newTok.length, s.C.length, "tokens per line"); assert.equal(s.oldTok.length, s.B.length, "old tokens per line");
    }
    check(s); steps++;
  }
}
console.log(`edit ok, ${steps} random steps`);
