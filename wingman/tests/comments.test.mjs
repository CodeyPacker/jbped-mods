// comments.js: review comments' model, anchoring after edits, and compare-and-swap persistence.
import { sanitize, makeComment, addComment, editComment, deleteComment, clearComments, undoClear, relocate, relocateFile,
  parseState, emptyState, updateComments, loadComments, commentsPath, fileName, spansOn, checkText, MAX_TEXT, MAX_BATCH } from "../mods/wingman/comments.js";
import assert from "node:assert/strict";

// ---- sanitize and validation ----
assert.equal(sanitize("a\x1b[31mred\x1b[0m\r\nb\tc\x07\x9b2J\x7f"), "a[31mred[0m\nb\tc2J");
assert.equal(sanitize(null), "");
assert.equal(checkText("   ").error, "The comment is empty");
assert.ok(checkText("x".repeat(MAX_TEXT + 1)).error.includes(`limit is ${MAX_TEXT}`));
assert.equal(checkText("x".repeat(MAX_TEXT)).text.length, MAX_TEXT);

const draft = { space: "s1", path: "C:/dev/app/src/a.js", root: "C:/dev/app", rel: "src/a.js", key: "C:/dev/app|src/a.js", start: 3, end: 4,
  snippet: ["  const x = 1;\x1b]0;evil\x07", "  return x;", "}", "extra"], by: "t2", kind: "hunk" };
const made = makeComment(draft, "  rename x \x1b[2J ", 1000, "c1").comment;
assert.equal(made.text, "rename x [2J");
assert.deepEqual(made.snippet, ["  const x = 1;]0;evil", "  return x;", "}"]); // 3 lines, escapes gone
assert.equal(made.stale, false);
assert.equal(made.created, 1000);
assert.ok(makeComment({ ...draft, start: 0 }, "x").error);
assert.ok(makeComment({ ...draft, end: 2 }, "x").error);
assert.ok(makeComment(draft, "").error);

// ---- add, edit, delete, clear and undo ----
const c = (id, start = 1, extra = {}) => makeComment({ ...draft, start, end: start, ...extra }, `note ${id}`, 1, id).comment;
let s = addComment(emptyState(), c("a"));
s = addComment(s, c("b", 5));
assert.deepEqual(s.comments.map((x) => x.id), ["a", "b"]);
s = editComment(s, "b", "changed\x1b");
assert.equal(s.comments[1].text, "changed");
assert.throws(() => editComment(s, "b", ""), /empty/);
assert.throws(() => editComment(s, "zz", "x"), /gone/);
assert.equal(deleteComment(s, "zz"), s);
s = deleteComment(s, "a");
assert.deepEqual(s.comments.map((x) => x.id), ["b"]);
// Clear keeps the batch for one undo; undo puts it back.
const cleared = clearComments(s, "cleared", 50);
assert.deepEqual(cleared.comments, []);
assert.deepEqual(cleared.undo, { comments: s.comments, why: "cleared", at: 50 });
assert.equal(clearComments(cleared), cleared); // nothing to clear: unchanged, undo kept
assert.deepEqual(undoClear(cleared).comments.map((x) => x.id), ["b"]);
assert.equal(undoClear(cleared).undo, null);
// Adding a comment ends the chance to undo.
assert.equal(addComment(cleared, c("n")).undo, null);
// A sent batch: only those ids go; comments added meanwhile stay.
let t = addComment(addComment(addComment(emptyState(), c("x")), c("y")), c("z"));
t = clearComments(t, "sent", 9, ["x", "y"]);
assert.deepEqual(t.comments.map((x) => x.id), ["z"]);
assert.deepEqual(t.undo.comments.map((x) => x.id), ["x", "y"]);
assert.equal(t.undo.why, "sent");
assert.deepEqual(undoClear(t).comments.map((x) => x.id), ["x", "y", "z"]);
// At most MAX_BATCH.
let full = emptyState();
for (let i = 0; i < MAX_BATCH; i++) full = addComment(full, c(`k${i}`));
assert.throws(() => addComment(full, c("over")), /at most 50/);

// ---- anchoring after edits ----
const lines = ["a", "b", "  const x = 1;", "  return x;", "}", "z"];
const at3 = makeComment({ ...draft, start: 3, end: 4, snippet: lines.slice(2, 5) }, "n", 1, "m").comment;
// Unchanged file: the same object.
assert.equal(relocate(at3, lines), at3);
// Lines inserted above: it follows (start and end shift together).
const moved = relocate(at3, ["new1", "new2", ...lines]);
assert.deepEqual([moved.start, moved.end, moved.stale], [5, 6, false]);
// Lines removed above.
const up = relocate(at3, lines.slice(1));
assert.deepEqual([up.start, up.end], [2, 3]);
// Several matches: the nearest to the old line wins.
const twice = ["  const x = 1;", "  return x;", "}", "q", "  const x = 1;", "  return x;", "}"];
const near = relocate({ ...at3, start: 4, end: 5 }, twice);
assert.deepEqual([near.start, near.end], [5, 6]);
// Trailing spaces and CRLF don't count as a change.
assert.equal(relocate(at3, ["a", "b", "  const x = 1;   \r", "  return x;", "}", "z"]).start, 3);
// The snippet is gone: old numbers stay, marked stale; found again later: not stale.
const gone = relocate(at3, ["a", "b", "  const y = 2;", "  return y;", "}"]);
assert.deepEqual([gone.start, gone.end, gone.stale], [3, 4, true]);
assert.equal(relocate(gone, ["a", "b", "  const y = 2;"]), gone); // still gone: same object
const back = relocate(gone, ["x", ...lines]);
assert.deepEqual([back.start, back.stale], [4, false]);
// A rejected change's comment locates by its anchor (the restored lines), not its snippet.
const rej = makeComment({ ...draft, start: 2, end: 2, snippet: ["agent's line"], anchor: ["original"], kind: "rejected" }, "why", 1, "r").comment;
assert.equal(relocate(rej, ["top", "original", "end"]), rej);
assert.equal(relocate(rej, ["top", "more", "original"]).start, 3);
// No anchor lines: never moves.
const bare = { ...rej, anchor: [], snippet: [] };
assert.equal(relocate(bare, []), bare);
// relocateFile: only that file's comments; nothing moved -> same state.
const other = c("o", 1, { key: "C:/dev/app|other.js" });
let fs = { ...emptyState(), comments: [at3, other] };
assert.equal(relocateFile(fs, at3.key, lines.join("\n")), fs);
const fs2 = relocateFile(fs, at3.key, ["x", ...lines].join("\r\n"));
assert.equal(fs2.comments[0].start, 4);
assert.equal(fs2.comments[1], other);
assert.deepEqual(spansOn(fs2.comments, at3.key), [{ a: 3, b: 4, stale: false, id: "m" }]);

// ---- persistence with compare-and-swap ----
assert.equal(fileName("vps/s1"), "vps~2fs1");
assert.equal(commentsPath("/d", "vps/s1"), "/d/comments/vps~2fs1.json");
assert.deepEqual(parseState("not json"), emptyState());
assert.deepEqual(parseState(null), emptyState());

// An in-memory disk: write fails unless the file is what the writer read.
function memIo() {
  const files = new Map(), io = { files, writes: 0, beforeWrite: null };
  io.read = async (p) => files.get(p) ?? null;
  io.mkdir = async () => {};
  io.write = async (p, text, expected) => {
    if (io.beforeWrite) { const f = io.beforeWrite; io.beforeWrite = null; await f(); }
    io.writes++;
    if ((files.get(p) ?? null) !== expected) throw new Error("stale snapshot");
    files.set(p, text);
  };
  return io;
}
const io = memIo();
let r = await updateComments(io, "/d", "s1", (st) => addComment(st, c("p1")));
assert.equal(r.changed, true);
assert.deepEqual((await loadComments(io, "/d", "s1")).comments.map((x) => x.id), ["p1"]);
// An op that changes nothing writes nothing.
const writes = io.writes;
r = await updateComments(io, "/d", "s1", (st) => st);
assert.equal(r.changed, false);
assert.equal(io.writes, writes);
// Conflict: another copy adds a comment between our read and write. We read again and keep both.
io.beforeWrite = async () => { await updateComments(io, "/d", "s1", (st) => addComment(st, c("other"))); };
r = await updateComments(io, "/d", "s1", (st) => addComment(st, c("mine")));
assert.deepEqual((await loadComments(io, "/d", "s1")).comments.map((x) => x.id), ["p1", "other", "mine"]);
// A refused op throws as is and writes nothing.
await assert.rejects(updateComments(io, "/d", "s1", (st) => editComment(st, "nope", "x")), /gone/);
// A write that always conflicts gives up after a few tries.
const bad = memIo();
bad.write = async () => { throw new Error("stale snapshot"); };
await assert.rejects(updateComments(bad, "/d", "s1", (st) => addComment(st, c("q"))), /Comments not saved: stale snapshot/);
// Spaces have their own files.
await updateComments(io, "/d", "vps/s2", (st) => addComment(st, c("v")));
assert.deepEqual((await loadComments(io, "/d", "vps/s2")).comments.map((x) => x.id), ["v"]);
assert.equal((await loadComments(io, "/d", "s1")).comments.length, 3);
console.log("comments ok");
