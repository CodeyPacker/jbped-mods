import { test } from "node:test";
import assert from "node:assert/strict";
import { isSideFile, groupFiles, viewedKey, applyViewed, threadsOn, unplacedThreads } from "../mods/wayfindr/prfiles.js";
import { diffRows } from "../mods/wayfindr/prdiff.js";

test("isSideFile: tests, docs and generated files", () => {
  for (const p of ["test/a.js", "src/__tests__/x.js", "a.test.ts", "b.spec.js", "FooTests.cs", "x_test.go", "pkg/test_y.py",
    "README.md", "docs/guide.html", "package-lock.json", "yarn.lock", "app.min.js", "dist/x.js", "Form.designer.cs", "__snapshots__/a.snap"]) {
    assert.equal(isSideFile(p), true, p);
  }
  for (const p of ["src/main.js", "lib/testing.js", "contest/x.js", "Makefile", "src/build.js"]) assert.equal(isSideFile(p), false, p);
});

test("groupFiles keeps the detail's order in each group", () => {
  const files = ["b.js", "README.md", "a.js", "test/a.js", "c.js"].map((path) => ({ path }));
  const g = groupFiles(files);
  assert.deepEqual(g.code.map((f) => f.path), ["b.js", "a.js", "c.js"]);
  assert.deepEqual(g.side.map((f) => f.path), ["README.md", "test/a.js"]);
  assert.deepEqual(groupFiles(undefined), { code: [], side: [] });
});

test("viewedKey is path-safe and names the repo and number", () => {
  assert.equal(viewedKey({ repo: "o/web", id: "web#12" }), "o_web-pr-12");
  assert.equal(viewedKey({ repo: "Proj X/repo", id: "repo!345" }), "Proj_X_repo-pr-345");
  assert.ok(!/[\\/:]/.test(viewedKey({ repo: "../../etc", id: "x#1" })));
});

test("applyViewed keeps the marks only for the same head", () => {
  const saved = { head: "abc", files: { "a.js": true, "b.js": false } };
  assert.deepEqual(applyViewed(saved, "abc"), { "a.js": true });
  assert.deepEqual(applyViewed(saved, "def"), {});
  assert.deepEqual(applyViewed(null, "abc"), {});
  assert.deepEqual(applyViewed({ head: "abc", files: [] }, "abc"), {});
});

const rows = diffRows("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file");

test("threadsOn: same path and line, old side for removed rows, new side for the rest", () => {
  const th = [
    { id: 1, path: "src/a.js", line: 2, side: "old" },
    { id: 2, path: "/src/a.js", line: 2, side: "new" },
    { id: 3, path: "src/a.js", line: 1, side: "new" },
    { id: 4, path: "src/b.js", line: 1, side: "new" },
    { id: 5, path: "src/a.js", line: null, side: "new" },
  ];
  const on = (r) => threadsOn(th, "src/a.js", r).map((x) => x.id);
  assert.deepEqual(on(rows[0]), []); // the hunk header
  assert.deepEqual(on(rows[1]), [3]); // " a", new line 1
  assert.deepEqual(on(rows[2]), [1]); // "-b", old line 2
  assert.deepEqual(on(rows[3]), [2]); // "+B", new line 2; Azure's leading "/" doesn't matter
  assert.deepEqual(on(rows[5]), []); // "\ No newline"
  assert.deepEqual(threadsOn(th, "/src/a.js", rows[1]).map((x) => x.id), [3]);
});

test("unplacedThreads: no line, a file not listed, or a line on no row", () => {
  const files = [{ path: "/src/a.js" }, { path: "bin.png" }];
  const rowsOf = (f) => (f.path === "/src/a.js" ? rows : []);
  const th = [
    { id: 1, path: "src/a.js", line: 2, side: "new" },
    { id: 2, path: "src/a.js", line: null, side: "new" },
    { id: 3, path: "gone.js", line: 1, side: "new" },
    { id: 4, path: "src/a.js", line: 90, side: "new" },
    { id: 5, path: "bin.png", line: 1, side: "new" },
  ];
  assert.deepEqual(unplacedThreads(th, files, rowsOf).map((x) => x.id), [2, 3, 4, 5]);
});
