// filetree.navMove (P9: Explorer keyboard movement) and filetree.relistAfter (P4: folders to read again after a file operation).
import { navMove, relistAfter, createTree, setFolder, toggle, rows } from "../mods/wingman/filetree.js";
import { remap, within } from "../mods/wingman/fileops.js";
import assert from "node:assert/strict";

// ---- navMove ----------------------------------------------------------------------------------------
// Two roots with headers: repo (open) with src/ (open) holding a.ts, and README; plain root (closed).
const items = [
  { depth: -1, dir: true, open: true },  // 0 header repo
  { depth: 0, dir: true, open: true },   // 1 src
  { depth: 1, dir: false, open: false }, // 2 src/a.ts
  { depth: 1, dir: true, open: false },  // 3 src/lib (closed)
  { depth: 0, dir: false, open: false }, // 4 README
  { depth: -1, dir: true, open: false }, // 5 header plain (closed)
];
const m = (at, key) => navMove(items, at, key);
assert.deepEqual(m(2, "up"), { at: 1, toggle: false });
assert.deepEqual(m(0, "up"), { at: 0, toggle: false }, "no wrap at the top");
assert.deepEqual(m(4, "down"), { at: 5, toggle: false }, "down crosses into the next root");
assert.deepEqual(m(5, "down"), { at: 5, toggle: false }, "no wrap at the bottom");
assert.deepEqual(m(3, "home"), { at: 0, toggle: false });
assert.deepEqual(m(1, "end"), { at: 5, toggle: false });
assert.deepEqual(m(-1, "down"), { at: 0, toggle: false }, "nothing selected: the first row");
assert.deepEqual(m(-1, "up"), { at: 5, toggle: false }, "nothing selected, Up: the last row");
assert.deepEqual(m(3, "right"), { at: 3, toggle: true }, "Right opens a closed folder");
assert.deepEqual(m(1, "right"), { at: 2, toggle: false }, "Right on an open folder: its first child");
assert.deepEqual(m(0, "right"), { at: 1, toggle: false }, "Right on an open root header: its first row");
assert.deepEqual(m(5, "right"), { at: 5, toggle: true }, "Right opens a closed root");
assert.deepEqual(m(2, "right"), { at: 2, toggle: false }, "Right on a file does nothing");
assert.deepEqual(m(1, "left"), { at: 1, toggle: true }, "Left closes an open folder");
assert.deepEqual(m(2, "left"), { at: 1, toggle: false }, "Left on a file: its folder");
assert.deepEqual(m(3, "left"), { at: 1, toggle: false }, "Left on a closed folder: its parent");
assert.deepEqual(m(4, "left"), { at: 0, toggle: false }, "Left on a top-level row: its root header");
assert.deepEqual(m(0, "left"), { at: 0, toggle: true }, "Left closes an open root");
assert.deepEqual(m(5, "left"), { at: 5, toggle: false }, "Left on a closed root: nothing above");
assert.deepEqual(navMove([], 0, "down"), { at: -1, toggle: false });
// One root without a header: top-level rows have nothing above them.
const flat = [{ depth: 0, dir: true, open: true }, { depth: 1, dir: false }, { depth: 0, dir: false }];
assert.deepEqual(navMove(flat, 2, "left"), { at: 2, toggle: false });
assert.deepEqual(navMove(flat, 1, "left"), { at: 0, toggle: false });
// An open empty folder: Right stays.
assert.deepEqual(navMove([{ depth: 0, dir: true, open: true }, { depth: 0, dir: false }], 0, "right"), { at: 0, toggle: false });

// ---- relistAfter --------------------------------------------------------------------------------------
const E = (...n) => n.map((x) => (x.endsWith("/") ? { name: x.slice(0, -1), dir: true } : { name: x, dir: false }));
/** What applyFileOp does to the tree before listing: open folders follow, listings under `gone` go. */
function follow(t, gone, to) {
  for (const k of [...t.open]) if (within(k, gone)) { t.open.delete(k); const n = to != null ? remap(k, gone, to) : null; if (n) t.open.add(n); }
  for (const k of [...t.entries.keys()]) if (k && within(k, gone)) t.entries.delete(k);
}
// A plain root: src/ open with lib/ open inside; rename src -> app.
let t = createTree();
setFolder(t, "", E("src/", "x.txt")); toggle(t, "src"); setFolder(t, "src", E("lib/", "a.ts")); toggle(t, "src/lib"); setFolder(t, "src/lib", E("b.ts"));
follow(t, "src", "app");
assert.deepEqual([...t.open].sort(), ["app", "app/lib"]);
assert.deepEqual(relistAfter(t, { gone: "src", now: "app" }), ["", "app", "app/lib"], "the root, the renamed folder and its open subfolder");
setFolder(t, "", E("app/", "x.txt")); // the root, listed again
assert.ok(rows(t).some((r) => r.rel === "app" && r.loading), "until it's listed the renamed folder shows Loading…");
// Move into a folder that isn't listed or open: only the root (the destination is read when opened, or revealed).
t = createTree(); setFolder(t, "", E("a.txt", "dst/"));
assert.deepEqual(relistAfter(t, { gone: "a.txt", now: "dst/a.txt" }), [""]);
// Into an open folder: that folder too.
toggle(t, "dst"); setFolder(t, "dst", E());
assert.deepEqual(relistAfter(t, { gone: "a.txt", now: "dst/a.txt" }), ["", "dst"]);
// Delete of an expanded folder: its parent; nothing under it stays open.
t = createTree(); setFolder(t, "", E("d/")); toggle(t, "d"); setFolder(t, "d", E("e/")); toggle(t, "d/e"); setFolder(t, "d/e", E("f"));
follow(t, "d", null);
assert.deepEqual([...t.open], []); assert.deepEqual([...t.entries.keys()], [""]);
assert.deepEqual(relistAfter(t, { gone: "d" }), [""]);
// New folder with made parents inside an open folder.
t = createTree(); setFolder(t, "", E("a/")); toggle(t, "a"); setFolder(t, "a", E());
assert.deepEqual(relistAfter(t, { now: "a/b/c", made: ["a/b", "a/b/c"] }), ["a"], "a/b isn't open: read when it opens");
// Renamed folder under a closed parent: nothing open there, nothing extra.
t = createTree(); setFolder(t, "", E("p/"));
assert.deepEqual(relistAfter(t, { gone: "p/q", now: "p/r" }), [], "p is closed and isn't the root");
assert.deepEqual(relistAfter(t, {}), []);
console.log("treenav ok");
