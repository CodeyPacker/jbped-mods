import { test } from "node:test";
import assert from "node:assert/strict";
import { parseComments, commentsOn, coveredRows, rangeOf, openAt, extendOpen, saveComment, removeComment, linesOf,
  verdictsFor, canPost, toReview, confirmText, COMMENTS_DIR } from "../mods/wayfindr/prcomments.js";
import { diffRows } from "../mods/wayfindr/prdiff.js";

// Rows: 0 @@, 1 " "10, 2 "-"11(old), 3 "+"11, 4 "+"12, 5 "\ No newline", 6 @@, 7 " "40, 8 "+"41
const rows = diffRows("@@ -10,2 +10,3 @@\n ctx\n-old\n+new\n+more\n\\ No newline at end of file\n@@ -38,1 +40,2 @@\n tail\n+last\n");

test("the save path is under data/wayfindr/comments", () => {
  assert.equal(COMMENTS_DIR, "data/wayfindr/comments");
});

test("parseComments keeps well-formed entries and drops a leading /", () => {
  const text = JSON.stringify([
    { id: "a", path: "/src/x.js", line: 3, side: "new", text: "hi", code: "x" },
    { id: "b", path: "y.js", line: 5, side: "old", startLine: 2, startSide: "old", text: "range" },
    { id: "c", path: "y.js", line: 5, side: "left", text: "bad side" },
    { id: "d", path: "y.js", line: 5, side: "new", text: "  " },
    null,
  ]);
  assert.deepEqual(parseComments(text), [
    { id: "a", path: "src/x.js", line: 3, side: "new", text: "hi", code: "x" },
    { id: "b", path: "y.js", line: 5, side: "old", startLine: 2, startSide: "old", text: "range", code: "" },
  ]);
  assert.deepEqual(parseComments("not json"), []);
  assert.deepEqual(parseComments("{}"), []);
  assert.deepEqual(parseComments(null), []);
});

test("commentsOn: a comment sits under its last line on its side", () => {
  const list = [
    { id: "1", path: "a.js", line: 11, side: "new", text: "n" },
    { id: "2", path: "/a.js", line: 11, side: "old", text: "o" },
    { id: "3", path: "b.js", line: 11, side: "new", text: "other file" },
  ];
  assert.deepEqual(commentsOn(list, "a.js", rows[3]).map((c) => c.id), ["1"]);
  assert.deepEqual(commentsOn(list, "/a.js", rows[2]).map((c) => c.id), ["2"]);
  assert.deepEqual(commentsOn(list, "a.js", rows[0]), []);
  assert.deepEqual(commentsOn(list, "a.js", rows[5]), []);
});

test("rangeOf stops at a hunk header and skips unnumbered rows", () => {
  assert.deepEqual(rangeOf(rows, 1, 4), [1, 4]);
  assert.deepEqual(rangeOf(rows, 4, 1), [1, 4]);
  assert.deepEqual(rangeOf(rows, 3, 8), [3, 4]); // cut at the second hunk's header
  assert.deepEqual(rangeOf(rows, 8, 1), [7, 8]);
});

test("openAt and extendOpen: a click opens one line, a shift-click a range under its last row", () => {
  assert.equal(openAt(rows, "a.js", 0), null);
  assert.equal(openAt(rows, "a.js", 5), null);
  const one = openAt(rows, "/a.js", 1);
  assert.deepEqual(one, { path: "a.js", line: 10, side: "new" });
  const range = extendOpen(rows, { ...one, editId: "x" }, 4);
  assert.deepEqual(range, { path: "a.js", line: 12, side: "new", startLine: 10, startSide: "new", editId: "x" });
  // Cut at the hunk header: the range ends at 12, the last row of the first hunk.
  assert.deepEqual(extendOpen(rows, one, 8), { path: "a.js", line: 12, side: "new", startLine: 10, startSide: "new" });
  // Back to the first row: one line again.
  assert.deepEqual(extendOpen(rows, range, 1), { path: "a.js", line: 10, side: "new", editId: "x" });
  // A removed row as an end keeps its old side.
  assert.deepEqual(extendOpen(rows, one, 2), { path: "a.js", line: 11, side: "old", startLine: 10, startSide: "new" });
  assert.equal(extendOpen(rows, one, 0), one);
});

test("coveredRows: saved ranges on the file and the open box's range", () => {
  const list = [{ id: "1", path: "a.js", line: 12, side: "new", startLine: 10, startSide: "new", text: "r" }, { id: "2", path: "a.js", line: 41, side: "new", text: "one" }];
  assert.deepEqual([...coveredRows(rows, list, "a.js", null)].sort(), [1, 2, 3, 4]);
  assert.deepEqual([...coveredRows(rows, [], "a.js", { path: "a.js", line: 41, side: "new", startLine: 40, startSide: "new" })].sort(), [7, 8]);
  assert.equal(coveredRows(rows, list, "b.js", null).size, 0);
  assert.equal(coveredRows(rows, [], "a.js", { reply: "t1" }).size, 0);
});

test("saveComment adds, edits, and ignores empty text; removeComment drops one", () => {
  const open = { path: "a.js", line: 12, side: "new", startLine: 10, startSide: "new" };
  let list = saveComment([], open, "  look  ", "more", "c1");
  assert.deepEqual(list, [{ id: "c1", path: "a.js", line: 12, side: "new", startLine: 10, startSide: "new", text: "look", code: "more" }]);
  assert.equal(saveComment(list, open, "   ", "x", "c2"), list);
  list = saveComment(list, { path: "a.js", line: 12, side: "new", editId: "c1" }, "changed", undefined, "c3");
  assert.deepEqual(list, [{ id: "c1", path: "a.js", line: 12, side: "new", text: "changed", code: "more" }]);
  assert.equal(linesOf(list[0]), "12");
  assert.equal(linesOf({ line: 12, startLine: 10 }), "10-12");
  assert.deepEqual(removeComment(list, "c1"), []);
});

test("verdicts, the post rule, the review shape and the confirm words", () => {
  assert.deepEqual(verdictsFor(true).map((v) => v.event), ["comment"]);
  assert.deepEqual(verdictsFor(false).map((v) => v.event), ["comment", "approve", "changes"]);
  assert.equal(canPost([], "comment", ""), false);
  assert.equal(canPost([], "changes", " "), false);
  assert.equal(canPost([], "approve", ""), true);
  assert.equal(canPost([], "comment", "sum"), true);
  assert.equal(canPost([{}], "comment", ""), true);
  const list = [{ id: "1", path: "a.js", line: 12, side: "new", startLine: 10, startSide: "new", text: "r", code: "x" }, { id: "2", path: "b.js", line: 3, side: "old", text: "o", code: "" }];
  assert.deepEqual(toReview(list, "changes", " fix "), { event: "changes", body: "fix", comments: [
    { path: "a.js", line: 12, side: "new", startLine: 10, startSide: "new", body: "r" },
    { path: "b.js", line: 3, side: "old", body: "o" },
  ] });
  assert.equal(confirmText("changes", "web#4", "Jo", 2), "Post Request changes to web#4 as Jo with 2 comments? Everyone on the PR will see it.");
  assert.equal(confirmText("approve", "web#4", "Jo", 1), "Post Approve to web#4 as Jo with 1 comment? Everyone on the PR will see it.");
});
