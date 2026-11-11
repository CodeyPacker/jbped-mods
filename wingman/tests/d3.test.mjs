import { rows as mkRows, partialAt, acceptAt, rejectAt } from "../mods/wingman/model.js";
import assert from "node:assert";
// picks() copied from main.js logic
function picks(f, sel) {
  const pick = { old: new Set(), new: new Set() }, all = mkRows(f.B, f.C, f.hunks), picked = [];
  for (const r of all.slice(sel[0], sel[1] + 1)) if (r.kind === "+") { pick.new.add(r.line); picked.push(r); }
  for (const [i, h] of f.hunks.entries()) {
    const added = picked.filter((r) => r.hunk === i);
    if (added.length === h.nc && added.length) for (const r of all) if (r.hunk === i && r.kind === "-") pick.old.add(r.line);
  }
  return { pick, any: pick.new.size > 0 };
}
const B = ["a\n","b\n","c\n","d\n","e\n"], C = ["a\n","B1\n","B2\n","c\n","e\n"];
const s = { B, C, Btext: B.join(""), Ctext: C.join(""), hunks: [{o:1,oc:1,n:1,nc:2},{o:3,oc:1,n:4,nc:0}], created:false };
const R = mkRows(B, C, s.hunks); console.log(R.map((r,i)=>i+":"+r.kind).join(" "));
// all added lines of hunk 0 selected (rows 1..3 incl removed row) -> whole-change accept
let p = picks(s, [1,3]); assert.deepEqual([...p.pick.old],[1]);
assert.deepEqual(partialAt(s,"accept",p.pick).state.Btext, acceptAt(s,0).state.Btext);
assert.deepEqual(partialAt(s,"reject",p.pick).state.Ctext, rejectAt(s,0).state.Ctext);
// one added line -> removed stay pending
p = picks(s, [2,2]); assert.equal(p.pick.old.size, 0);
const r1 = partialAt(s,"reject",p.pick).state; assert.equal(r1.Ctext, "a\nB2\nc\ne\n"); assert.equal(r1.hunks.length, 2);
// selection of only context/removed -> nothing
assert.equal(picks(s,[5,7]).any, false);
console.log("d3 ok");
