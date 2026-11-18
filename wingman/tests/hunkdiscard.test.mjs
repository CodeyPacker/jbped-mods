// G6: Discard one change in Changes. The lines go back exactly as HEAD has them (CRLF, first and
// last lines, no final newline), selected lines only when picked, and a file under review takes
// the discard as the user's own edit: Review never shows it as the agent's change.
import { discardText, lineSplice, baselineAt, reviewWrites, cantDiscard, discardQuestion, headAsCheckedOut, noteAfterUndo } from "../mods/wingman/hunkdiscard.js";
import { splitLines } from "../mods/wingman/model.js";
import { check } from "../mods/wingman/edit.js";
import { diffHunks } from "../mods/wingman/merge.js";
import { Store, swap } from "../mods/wingman/store.js";
import { Capture } from "../mods/wingman/capture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const row = async (head, disk, rel = "f.txt") => ({ rel, B: splitLines(head), C: splitLines(disk), Btext: head, Ctext: disk, hunks: await diffHunks(head, disk), created: false, inHead: true });

// ctrl-z of a discard takes its "Discarded …" note with it; a newer note (a commit since) stays.
{
  const n = "Discarded change 1 of 1 (line 7) in crlf.txt";
  assert.equal(noteAfterUndo(n, n), null);
  assert.equal(noteAfterUndo("Committed 2 files to r1", n), "Committed 2 files to r1");
  assert.equal(noteAfterUndo(n, undefined), n); // an accept/reject step has no note
  assert.equal(noteAfterUndo(null, n), null);
}

// Several changes: each one alone goes back, the others stay.
{
  const head = "a\nb\nc\nd\ne\nf\ng\n", disk = "A\nb\nc\nD\nD2\ne\nf\n";
  const f = await row(head, disk);
  assert.equal(f.hunks.length, 3);
  assert.equal(discardText(f, 0), "a\nb\nc\nD\nD2\ne\nf\n");
  assert.equal(discardText(f, 1), "A\nb\nc\nd\ne\nf\n");
  assert.equal(discardText(f, 2), "A\nb\nc\nD\nD2\ne\nf\ng\n");
  // All of them, one after the other (re-diffed in between, as the view reloads): HEAD exactly.
  let t = disk;
  while (t !== head) { const g = await row(head, t); t = discardText(g, g.hunks.length - 1); }
  assert.equal(t, head);
  assert.match(discardQuestion(f, 1), /^Discard change 2 of 3 \(lines 4-5\) in f\.txt\? .*Ctrl\+Z/);
}
// Selected lines only (model.partialAt): the picked added line goes, the rest of the change stays.
{
  const head = "a\nb\nc\n", disk = "a\nX\nY\nc\n";
  const f = await row(head, disk);
  assert.equal(f.hunks.length, 1);
  // Pick the added "Y" (current line 2): it goes; "b" stays removed, "X" stays.
  assert.equal(discardText(f, 0, { old: new Set(), new: new Set([2]) }), "a\nX\nc\n");
  // Pick the removed "b" (HEAD line 1) and the added "X": b comes back in X's place.
  assert.equal(discardText(f, 0, { old: new Set([1]), new: new Set([1]) }), "a\nb\nY\nc\n");
}
// CRLF: lines come back with HEAD's own endings; an autocrlf checkout (HEAD LF, file CRLF) gets CRLF.
{
  const head = "a\r\nb\r\nc\r\n", disk = "a\r\nB\r\nc\r\nd\r\n";
  const f = await row(head, disk);
  assert.equal(discardText(f, 0), "a\r\nb\r\nc\r\nd\r\n");
  assert.equal(discardText(f, 1), "a\r\nB\r\nc\r\n");
  assert.equal(headAsCheckedOut("a\nb\n", "a\r\nX\r\n"), "a\r\nb\r\n");
  assert.equal(headAsCheckedOut("a\nb\n", "a\nX\r\n"), "a\nb\n", "mixed endings: as HEAD has them");
  const g = await row("a\nb\nc\n", "a\r\nB\r\nc\r\n");
  assert.equal(discardText(g, 0), "a\r\nb\r\nc\r\n");
}
// The first line, the last line, and a last line without a newline (both ways).
{
  let f = await row("a\nb\nc\n", "Z\nb\nc\n"); assert.equal(discardText(f, 0), "a\nb\nc\n");
  f = await row("a\nb\nc\n", "b\nc\n"); assert.equal(discardText(f, 0), "a\nb\nc\n");
  f = await row("a\nb\nc\n", "X\na\nb\nc\n"); assert.equal(discardText(f, 0), "a\nb\nc\n");
  f = await row("a\nb\nc\n", "a\nb\nc\nd\n"); assert.equal(discardText(f, 0), "a\nb\nc\n");
  f = await row("a\nb\nc", "a\nb\nc\n"); assert.equal(f.hunks.length, 1); assert.equal(discardText(f, 0), "a\nb\nc");
  f = await row("a\nb\nc\n", "a\nb\nC"); assert.equal(discardText(f, 0), "a\nb\nc\n");
  f = await row("a\nb\nc\n", "a\nb\n"); assert.equal(discardText(f, 0), "a\nb\nc\n");
}
// Rows that can't: not loaded, new, deleted, binary, committed.
assert.match(cantDiscard({ lazy: true }), /loaded/);
assert.match(cantDiscard({ rel: "n", Ctext: "x", created: true, hunks: [{}] }), /Discard file/);
assert.match(cantDiscard({ rel: "n", Ctext: null, hunks: [{}] }), /deleted/);
assert.match(cantDiscard({ rel: "n", error: "binary file" }), /binary/);
assert.match(cantDiscard({ rel: "n", committed: true }), /Committed/);
assert.equal(cantDiscard({ rel: "n", Ctext: "x", hunks: [{}], inHead: true }), null);

// lineSplice and baselineAt.
assert.deepEqual(lineSplice("a\nb\nc\n", "a\nX\nc\n"), { l1: 1, l2: 2, lines: ["X\n"] });
assert.deepEqual(lineSplice("a\nc\n", "a\nb\nc\n"), { l1: 1, l2: 1, lines: ["b\n"] });
assert.equal(lineSplice("a\n", "a\n"), null);
// Review hunk: baseline line 1 ("b") became current lines 1-2.
const hs = [{ o: 1, oc: 1, n: 1, nc: 2 }];
assert.equal(baselineAt(hs, 0, 1), 0); assert.equal(baselineAt(hs, 3, 4), 2); assert.equal(baselineAt(hs, 1, 2), null);
assert.equal(baselineAt(hs, 3, 3), 2, "insert after the change"); assert.equal(baselineAt(hs, 2, 2), null, "insert inside it");
assert.equal(baselineAt([{ o: 1, oc: 2, n: 1, nc: 0 }], 1, 2), 3, "after a removal");

// Random edits: reviewWrites keeps the review consistent (hunks recomputed still turn B into C) and
// moves the baseline only where the review shows no change.
{
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pickLines = (n) => Array.from({ length: n }, () => "abcdefgh"[rnd(8)] + "\n").join("");
  for (let k = 0; k < 120; k++) {
    const base = pickLines(4 + rnd(8));
    const mutate = (t) => { const L = splitLines(t); const i = rnd(L.length + 1); const op = rnd(3); if (op === 0) L.splice(i, 0, "N" + rnd(9) + "\n"); else if (op === 1 && L.length > 1) L.splice(Math.min(i, L.length - 1), 1); else L[Math.min(i, L.length - 1)] = "M" + rnd(9) + "\n"; return L.join(""); };
    const cur = mutate(base), after = mutate(cur);
    const rf = { B: splitLines(base), C: splitLines(cur), Btext: base, Ctext: cur, hunks: await diffHunks(base, cur) };
    const ws = reviewWrites(rf, cur, after);
    const nextB = ws.find((w) => w.target === "baseline")?.after ?? base;
    if (ws.length) assert.equal(ws[0].after, after);
    const s = { B: splitLines(nextB), C: splitLines(after), Btext: nextB, Ctext: after, hunks: await diffHunks(nextB, after) };
    check(s);
    // A baseline that moved took exactly the user's lines: the review's changes are as before.
    if (nextB !== base) assert.deepEqual(s.hunks.length, rf.hunks.length, `${JSON.stringify([base, cur, after])}`);
  }
}

// A file under review, end to end: the user's own uncommitted edit (before the agent's turn) and
// the agent's change. Discarding the user's edit leaves Review as it was; discarding the agent's
// lines leaves nothing to review there either way.
const made = [];
try {
  const up = mkdtempSync(`${tmpdir()}/hd-up-`), dir = mkdtempSync(`${tmpdir()}/hd-`);
  made.push(up, dir);
  const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
  const head = "l1\nl2\nl3\nl4\nl5\nl6\n";
  g(up, "init", "-q", "-b", "main"); writeFileSync(`${up}/f.txt`, head); g(up, "add", "."); g(up, "commit", "-qm", "c");
  g(dir, "clone", "-q", up, ".");
  writeFileSync(`${dir}/f.txt`, "l1\nMINE\nl3\nl4\nl5\nl6\n"); // the user's edit, before the turn
  const st = await Store.open(dir), cap = new Capture(st);
  await st.reconcile();
  const t0 = await cap.snapshot();
  writeFileSync(`${dir}/f.txt`, "l1\nMINE\nl3\nl4\nAGENT\nl6\n");
  assert.equal(await cap.adopt(t0, await cap.snapshot()), 1);
  const load = async () => st.load("f.txt", (await st.index())["f.txt"]);
  let rf = await load();
  assert.deepEqual(rf.hunks, [{ o: 4, oc: 1, n: 4, nc: 1 }], "Review: the agent's line only");
  const disk = () => readFileSync(`${dir}/f.txt`, "utf8");
  // Discard the user's edit (Changes' change 1 of 2): file and baseline both take l2.
  let f = await row(head, disk());
  assert.equal(f.hunks.length, 2);
  let after = discardText(f, 0), ws = reviewWrites(rf, disk(), after);
  assert.deepEqual(ws.map((w) => w.target), ["current", "baseline"]);
  for (const w of ws) await st.apply(rf, w);
  rf = await load();
  assert.equal(disk(), "l1\nl2\nl3\nl4\nAGENT\nl6\n");
  assert.deepEqual(rf.hunks, [{ o: 4, oc: 1, n: 4, nc: 1 }], "Review still shows only the agent's line");
  assert.equal(rf.Btext, head);
  // Compare-and-swap: a file that changed since it was read isn't written.
  await assert.rejects(swap(`${dir}/f.txt`, "stale\n", "x\n"));
  assert.throws(() => reviewWrites(rf, "other\n", head), /changed since/);
  // Discard the agent's line: the file alone changes, and Review has nothing left.
  f = await row(head, disk());
  after = discardText(f, 0); ws = reviewWrites(rf, disk(), after);
  assert.deepEqual(ws.map((w) => w.target), ["current"]);
  for (const w of ws) await st.apply(rf, w);
  rf = await load();
  assert.equal(disk(), head); assert.deepEqual(rf.hunks, []);
  // Undo (store.undo, as ctrl-z does) puts both back.
  const applied = [];
  f = await row(head, "l1\nl2\nl3\nl4\nl5\nl6\nTAIL\n");
  writeFileSync(`${dir}/f.txt`, f.Ctext); rf = await load();
  for (const w of reviewWrites(rf, f.Ctext, discardText(f, 0))) applied.push(await st.apply(rf, w));
  assert.equal(disk(), head);
  await st.undo(applied);
  assert.equal(disk(), "l1\nl2\nl3\nl4\nl5\nl6\nTAIL\n");
} finally { for (const d of made) rmSync(d, { recursive: true, force: true }); }
