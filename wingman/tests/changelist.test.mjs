// changelist.js: the Changes view's virtual list rows, clicks by x, and what stays loaded (F1, F4, F5).
import { listRows, rowSizes, clickTarget, shownCommitted, neighbours, toUnload, parseBlobSize, sizeError, binaryError, FILE_H, CHECK_X } from "../mods/wingman/changelist.js";
import assert from "node:assert/strict";

const a = { root: "/a" }, b = { root: "/b" }, idOf = (st) => st.root;
const file = (st, rel, extra = {}) => ({ key: `${st.root}|${rel}`, rel, store: st, ...extra });
const done = (st, rel, extra = {}) => ({ key: `${st.root}|${rel}#committed`, rel, store: st, committed: true, ...extra });
const files = [file(a, "x"), file(b, "y")];
const committed = [done(a, "c1", { ai: true }), done(a, "c2"), done(b, "c3")];

// Collapsed by default: one header per repo with its count and AI count, no committed files.
{
  const rows = listRows(files, committed, new Set(), idOf);
  assert.deepEqual(rows.map((r) => r.key), ["/a|x", "/b|y", "#committed|/a", "#committed|/b"]);
  assert.deepEqual(rows.slice(2).map((r) => [r.count, r.ai, r.open]), [[2, 1, false], [1, 0, false]]);
  assert.equal(rowSizes(rows), FILE_H, "one height: a single number");
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, "keys are unique");
}
// One repo expanded: its files follow its header, the other stays shut.
{
  const rows = listRows(files, committed, new Set(["/a"]), idOf);
  assert.deepEqual(rows.map((r) => r.key), ["/a|x", "/b|y", "#committed|/a", "/a|c1#committed", "/a|c2#committed", "#committed|/b"]);
  assert.deepEqual(shownCommitted(committed, new Set(["/a"]), idOf).map((f) => f.rel), ["c1", "c2"]);
  assert.deepEqual(listRows([], [], new Set(), idOf), []);
}
// Clicks: the checkbox by x on an uncommitted row only; headers toggle; unknown x picks.
{
  const [up, , head] = listRows(files, committed, new Set(), idOf);
  assert.equal(clickTarget(up, 10), "check");
  assert.equal(clickTarget(up, CHECK_X + 1), "pick");
  assert.equal(clickTarget(up, null), "pick");
  assert.equal(clickTarget(head, 5), "toggle");
  assert.equal(clickTarget({ kind: "file", f: committed[0] }, 10), "pick", "a committed row has no checkbox");
}
// Look-ahead: the files either side of the picked one.
assert.deepEqual(neighbours(files.concat(file(a, "z")), "/b|y").map((f) => f.rel), ["z", "x"]);
assert.deepEqual(neighbours(files, "/a|x").map((f) => f.rel), ["y"]);
assert.deepEqual(neighbours(files, "nope"), []);
// Unloading: least recently used first, never the kept one unless it alone is over the cap.
{
  const L = [{ key: "old", chars: 50, usedAt: 1 }, { key: "mid", chars: 50, usedAt: 2 }, { key: "sel", chars: 50, usedAt: 0 }];
  assert.deepEqual(toUnload(L, 200, "sel"), []);
  assert.deepEqual(toUnload(L, 100, "sel"), ["old"]);
  assert.deepEqual(toUnload(L, 50, "sel"), ["old", "mid"]);
  assert.deepEqual(toUnload(L, 40, "sel"), ["old", "mid", "sel"], "the kept row alone is over the cap");
  assert.deepEqual(toUnload([{ key: "big", chars: 9, usedAt: 1 }], 5, null), ["big"]);
}
// Sizes before reading a committed file's sides.
assert.equal(parseBlobSize({ code: 0, stdout: "15728640\n" }), 15728640);
assert.equal(parseBlobSize({ code: 128, stdout: "", stderr: "fatal: path not in commit" }), null);
assert.equal(parseBlobSize({ code: 0, stdout: "garbage" }), null);
assert.equal(sizeError([10, null], 1048576), null);
assert.equal(sizeError([null, 1048577], 1048576), "too large to show (over 1 MiB)");
assert.equal(binaryError({ add: 0, del: 0, binary: true }), "binary file");
assert.equal(binaryError({ add: 1, del: 0, binary: false }), null);
assert.equal(binaryError(undefined), null);
console.log("changelist ok");
