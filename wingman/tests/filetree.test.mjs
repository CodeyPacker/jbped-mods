import { PER_FOLDER, TOTAL, createTree, setFolder, toggle, reveal, loaded, rows, STATUS_TREE, parseStatus, ignoredMatcher, folderMarks } from "../mods/wingman/filetree.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const E = (...n) => n.map((x) => (x.endsWith("/") ? { name: x.slice(0, -1), dir: true } : { name: x, dir: false }));
const names = (t, d) => rows(t, d).map((r) => (r.more ? "+more" : "  ".repeat(r.depth) + r.name + (r.dir ? "/" : "")));

// sorting: folders first, case-insensitive, numeric-aware
let t = createTree();
setFolder(t, "", E("b.js", "File10.js", "file2.js", "Zed/", "alpha/", "A.js"));
assert.deepEqual(names(t), ["alpha/", "Zed/", "A.js", "b.js", "file2.js", "File10.js"]);

// limits
t = createTree();
setFolder(t, "", Array.from({ length: PER_FOLDER + 5 }, (_, i) => ({ name: `f${String(i).padStart(4, "0")}`, dir: false })));
assert.equal(t.entries.get("").list.length, PER_FOLDER); assert.equal(t.entries.get("").more, true); assert.equal(t.limited, false);
let r = rows(t); assert.deepEqual(r.at(-1), { more: true, depth: 0, rel: "" }); assert.equal(r.length, PER_FOLDER + 1);
setFolder(t, "x", E("a")); assert.equal(t.entries.get("x").more, false);
t = createTree();
for (let i = 0; i < 12; i++) setFolder(t, `d${i}`, Array.from({ length: PER_FOLDER }, (_, j) => ({ name: `n${j}`, dir: false })));
const sum = () => [...t.entries.values()].reduce((a, v) => a + v.list.length, 0);
assert.equal(sum(), TOTAL); assert.equal(t.limited, true); assert.equal(t.entries.get("d10").list.length, 0); assert.equal(t.entries.get("d10").more, true);
setFolder(t, "d0", E("only")); // replacing frees room
assert.equal(t.entries.get("d0").list.length, 1);
setFolder(t, "q", E("a", "b", "c", "d")); assert.equal(t.entries.get("q").list.length, 4);
const small = createTree(); setFolder(small, "", E("a"), true); assert.equal(small.entries.get("").more, true); assert.equal(small.limited, false);

// toggle, nested state forgotten
t = createTree(); setFolder(t, "", E("a/", "b/"));
assert.equal(toggle(t, "a"), true); setFolder(t, "a", E("c/", "f.js"));
assert.equal(toggle(t, "a/c"), true); setFolder(t, "a/c", E("g.js"));
assert.equal(toggle(t, "b"), true); setFolder(t, "b", E("h.js"));
assert.deepEqual(names(t), ["a/", "  c/", "    g.js", "  f.js", "b/", "  h.js"]);
assert.equal(toggle(t, "a"), false);
assert.ok(!t.open.has("a/c")); assert.ok(!t.entries.has("a/c")); assert.ok(t.entries.has("a")); assert.ok(t.entries.has("b")); assert.ok(t.entries.has(""));
assert.deepEqual(names(t), ["a/", "b/", "  h.js"]);
assert.equal(toggle(t, "a"), false); // listing kept, reopen needs no load
assert.deepEqual(names(t).slice(0, 3), ["a/", "  c/", "  f.js"]);
assert.ok(!t.open.has("a/c"));

// reveal and loaded
t = createTree(); setFolder(t, "", E("a/"));
assert.deepEqual(reveal(t, "a/b/c/x.js"), ["a", "a/b", "a/b/c"]);
setFolder(t, "a", E("b/")); assert.deepEqual(reveal(t, "a/b/c"), ["a/b"]);
assert.deepEqual(reveal(t, "top.js"), []);
setFolder(t, "a/b", E("c/"));
assert.deepEqual(loaded(t), ["", "a", "a/b"]);
toggle(t, "a"); assert.deepEqual(loaded(t), [""]);
assert.deepEqual(rows(t).map((x) => [x.name, x.open, x.loading]), [["a", false, false]]);

// rows: depth, loading
t = createTree(); setFolder(t, "", E("a/")); toggle(t, "a");
let rr = rows(t); assert.equal(rr.length, 1); assert.equal(rr[0].open, true); assert.equal(rr[0].loading, true);
assert.deepEqual(rr[0], { rel: "a", name: "a", dir: true, depth: 0, open: true, loading: true, mark: undefined, ignored: false, n: 0, dirty: false, deleted: false, more: false });
setFolder(t, "a", E("b.js", "c/", "d/")); toggle(t, "a/c"); toggle(t, "a/d"); setFolder(t, "a/c", E("e.js"), true);
rr = rows(t);
assert.deepEqual(rr.map((x) => [x.rel, x.depth, !!x.loading]), [["a", 0, false], ["a/c", 1, false], ["a/c/e.js", 2, false], ["a/c", 2, false], ["a/d", 1, true], ["a/b.js", 1, false]]);
assert.equal(rr[3].more, true);

// marks, folder badges
const M = (o) => new Map(Object.entries(o));
const mk = (files, extra = {}) => {
  const tr = createTree(); setFolder(tr, "", E("d/", "z.js"));
  toggle(tr, "d"); setFolder(tr, "d", E(...files)); return rows(tr, { ...extra, marks: M(extra.marks) });
};
const folderMark = (marks) => mk(["x"], { marks }).find((x) => x.rel === "d").mark;
assert.equal(folderMark({ "d/a": "A" }), "A");
assert.equal(folderMark({ "d/a": "D" }), "D");
assert.equal(folderMark({ "d/a": "A", "d/b": "D" }), "M");
assert.equal(folderMark({ "d/a": "A", "d/b": "M" }), "M");
assert.equal(folderMark({ "d/a": "D", "d/b": "M" }), "M");
assert.equal(folderMark({ "d/a": "A", "d/b": "M", "d/c": "U" }), "U");
assert.equal(folderMark({ "d/a": "D", "d/b": "U" }), "U");
assert.equal(folderMark({ "d/s/a": "A", "d/s/t/b": "A" }), "A");
assert.equal(folderMark({ "other/a": "M" }), undefined);
assert.deepEqual([...folderMarks(M({ "a/b/c": "A", "a/d": "M", "top": "M" }))].sort(), [["a", "M"], ["a/b", "A"]]);
let m = mk(["x.js", "y.js"], { marks: { "d/x.js": "M" } });
assert.deepEqual(m.map((x) => [x.rel, x.mark]), [["d", "M"], ["d/x.js", "M"], ["d/y.js", undefined], ["z.js", undefined]]);

// deleted rows
m = mk(["x.js"], { marks: { "d/b.js": "D", "d/x.js": "M", "gone/q.js": "D", "z2.js": "D" } });
assert.deepEqual(m.map((x) => [x.rel, x.mark, x.deleted]), [["d", "M", false], ["d/b.js", "D", true], ["d/x.js", "M", false], ["z.js", undefined, false], ["z2.js", "D", true]]);
// a listed file marked D (recreated untracked is "A", but be safe) is not duplicated
m = mk(["b.js"], { marks: { "d/b.js": "D" } }); assert.equal(m.filter((x) => x.name === "b.js").length, 1); assert.equal(m.find((x) => x.name === "b.js").deleted, false);
// deleted in a closed folder: no row
t = createTree(); setFolder(t, "", E("d/")); assert.equal(rows(t, { marks: M({ "d/b.js": "D" }) }).length, 1);
// sorted among files
m = mk(["a.js", "c.js"], { marks: { "d/b.js": "D" } }); assert.deepEqual(m.slice(1, 4).map((x) => x.name), ["a.js", "b.js", "c.js"]);

// ignored, with a folder ignored (dimmed) and rows under it
t = createTree(); setFolder(t, "", E("node_modules/", "src/", ".env", "a.js")); toggle(t, "node_modules"); setFolder(t, "node_modules", E("p/", "x.js")); toggle(t, "node_modules/p"); setFolder(t, "node_modules/p", E("i.js"));
const st = parseStatus("!! node_modules/\0!! .env\0");
const ig = ignoredMatcher(st.ignored);
assert.deepEqual(rows(t, { ignored: ig }).map((x) => [x.rel, x.ignored]), [["node_modules", true], ["node_modules/p", true], ["node_modules/p/i.js", true], ["node_modules/x.js", true], ["src", false], [".env", true], ["a.js", false]]);
// inheritance in rows even if the matcher says no
assert.equal(rows(t, { ignored: (p) => p === "node_modules" }).find((x) => x.rel === "node_modules/p/i.js").ignored, true);

// prefix: tree root is a subfolder of the repo
t = createTree(); setFolder(t, "", E("lib/", "k.js")); toggle(t, "lib"); setFolder(t, "lib", E("a.js"));
const pm = M({ "pkg/lib/a.js": "M", "pkg/k.js": "A", "pkg/gone.js": "D", "elsewhere/q.js": "D", "pkg2/lib/b.js": "D" });
const seen = [];
const pr = rows(t, { prefix: "pkg", marks: pm, ignored: (p, d) => (seen.push([p, d]), p === "pkg/lib/a.js"), counts: M({ "lib/a.js": { n: 3, dirty: true }, lib: { n: 3, dirty: false } }) });
assert.deepEqual(pr.map((x) => [x.rel, x.mark, x.ignored, x.n, x.dirty, x.deleted]), [
  ["lib", "M", false, 3, false, false], ["lib/a.js", "M", true, 3, true, false], ["gone.js", "D", false, 0, false, true], ["k.js", "A", false, 0, false, false]]);
assert.ok(seen.some(([p, d]) => p === "pkg/lib" && d === true));

// parseStatus letters
const ps = (xy) => parseStatus(`${xy} f\0`).marks.get("f");
for (const [xy, l] of [["??", "A"], [" M", "M"], ["M ", "M"], ["MM", "M"], ["A ", "A"], ["AM", "A"], [" D", "D"], ["D ", "D"], ["UU", "U"], ["AA", "U"], ["DD", "U"], ["DU", "U"], ["UD", "U"], ["AU", "U"]]) assert.equal(ps(xy), l, xy);
const parsed = parseStatus(" M a b.js\0?? n/x.js\0!! node_modules/\0!! logs/app.log\0");
assert.deepEqual([...parsed.marks], [["a b.js", "M"], ["n/x.js", "A"]]); assert.deepEqual(parsed.ignored, ["node_modules/", "logs/app.log"]);
assert.deepEqual(parseStatus(""), { marks: new Map(), ignored: [] });

// ignoredMatcher
const im = ignoredMatcher(["node_modules/", "a/b/build/", "logs/app.log", ".env"]);
assert.ok(im("node_modules", true)); assert.ok(im("node_modules/x/y.js", false)); assert.ok(im("a/b/build/o.js", false)); assert.ok(im("a/b/build/sub", true));
assert.ok(im("logs/app.log", false)); assert.ok(im(".env", false));
assert.ok(!im("a/b", true)); assert.ok(!im("a/b/src.js", false)); assert.ok(!im("node_modules2/x", false)); assert.ok(!im("logs/other.log", false)); assert.ok(!im("src/node_modules.js", false));
assert.ok(!ignoredMatcher([])("a", false));
const big = ignoredMatcher(Array.from({ length: 20000 }, (_, i) => `dir${i}/`)); const t0 = performance.now();
for (let i = 0; i < 20000; i++) big(`src/deep/path/file${i}.js`, false);
assert.ok(performance.now() - t0 < 500, "matcher is fast");

// real git
const d = mkdtempSync(tmpdir() + "/wm-ft-"), git = (...a) => execFileSync("git", a, { cwd: d, encoding: "utf8" });
const put = (p, c = "x\n") => { mkdirSync(d + "/" + p.split("/").slice(0, -1).join("/"), { recursive: true }); writeFileSync(d + "/" + p, c); };
try {
  git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  put(".gitignore", "node_modules/\n*.log\n.env\n"); put("mod.txt", "1\n"); put("del.txt", "1\n"); put("logs/keep.txt", "1\n");
  git("add", "."); git("commit", "-qm", "init");
  put("mod.txt", "2\n"); rmSync(d + "/del.txt"); put("new/deep/er/f.txt"); put("new/deep/g.txt"); put("logs/app.log"); put(".env", "S=1\n");
  for (let i = 0; i < 300; i++) put(`node_modules/p${i % 10}/lib/s${i % 3}/f${i}.js`);
  const t1 = performance.now();
  const out = git(...STATUS_TREE), ms = performance.now() - t1;
  const lines = out.split("\0").filter(Boolean);
  assert.equal(lines.filter((l) => l.includes("node_modules")).length, 1); assert.ok(lines.includes("!! node_modules/"));
  assert.ok(ms < 2000, `status took ${ms}ms`);
  const { marks, ignored } = parseStatus(out);
  assert.deepEqual([...marks].sort(), [["del.txt", "D"], ["mod.txt", "M"], ["new/deep/er/f.txt", "A"], ["new/deep/g.txt", "A"]]);
  assert.deepEqual(ignored.sort(), [".env", "logs/app.log", "node_modules/"]);
  assert.equal(folderMarks(marks).get("new"), "A");
  const m2 = ignoredMatcher(ignored); assert.ok(m2("node_modules/p1/lib/s1/f1.js", false)); assert.ok(m2("logs/app.log", false)); assert.ok(!m2("logs/keep.txt", false));
  console.log(`filetree git: ${lines.length} entries, ${ms.toFixed(0)}ms`);
} finally { rmSync(d, { recursive: true, force: true }); }
console.log("filetree ok");
