// Discard file on a file under review: the file goes back to HEAD (or is deleted, or brought back)
// and Review shows nothing for it afterwards, never the user's discard as the agent's change.
import { fileDiscardWrite } from "../mods/wingman/hunkdiscard.js";
import { discardCommands } from "../mods/wingman/changes.js";
import { Store } from "../mods/wingman/store.js";
import { Capture } from "../mods/wingman/capture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const made = [];
const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const head = "l1\nl2\nl3\nl4\nl5\nl6\n";

// A clone with f.txt and gone.txt in HEAD, `mine` as the user's edit before the turn (or none),
// then `turn(dir)` as the agent's work. Returns the store with the review built.
async function fixture(mine, turn) {
  const up = mkdtempSync(`${tmpdir()}/fd-up-`), dir = mkdtempSync(`${tmpdir()}/fd-`);
  made.push(up, dir);
  g(up, "init", "-q", "-b", "main");
  writeFileSync(`${up}/f.txt`, head); writeFileSync(`${up}/gone.txt`, head);
  g(up, "add", "."); g(up, "commit", "-qm", "c");
  g(dir, "clone", "-q", up, ".");
  if (mine) writeFileSync(`${dir}/f.txt`, mine);
  const st = await Store.open(dir), cap = new Capture(st);
  await st.reconcile();
  const t0 = await cap.snapshot();
  turn(dir);
  await cap.adopt(t0, await cap.snapshot());
  return { st, dir };
}

const gitDiscard = (dir, rel, inHead) => { for (const args of discardCommands(rel, inHead)) execFileSync("git", args, { cwd: dir }); };

// What Discard file does (main.js): git puts the file back (or removes it), then the review's baseline follows.
async function discardFile(st, dir, rel, inHead) {
  gitDiscard(dir, rel, inHead);
  const e = (await st.index())[rel];
  assert.ok(e, `${rel} is under review`);
  const rf = await st.load(rel, e), w = fileDiscardWrite(rf);
  if (w) await st.apply(rf, w);
  return st.load(rel, e);
}

try {
  // The agent's changes only: the file is HEAD again, nothing to review.
  {
    const { st, dir } = await fixture(null, (d) => writeFileSync(`${d}/f.txt`, "l1\nA\nl3\nl4\nB\nl6\nC\n"));
    assert.ok((await st.load("f.txt", (await st.index())["f.txt"])).hunks.length > 0);
    const rf = await discardFile(st, dir, "f.txt", true);
    assert.equal(readFileSync(`${dir}/f.txt`, "utf8"), head);
    assert.deepEqual(rf.hunks, []);
  }
  // The user's own edit plus the agent's: HEAD again, and the user's edit going away is not the agent's work.
  {
    const { st, dir } = await fixture("l1\nMINE\nl3\nl4\nl5\nl6\n", (d) => writeFileSync(`${d}/f.txt`, "l1\nMINE\nl3\nl4\nAGENT\nl6\n"));
    const e = (await st.index())["f.txt"];
    assert.equal((await st.load("f.txt", e)).hunks.length, 1, "Review: the agent's line only");
    gitDiscard(dir, "f.txt", true);
    assert.ok((await st.load("f.txt", e)).hunks.length > 0, "without the baseline write, Review shows the user's discard as changes");
    const rf = await discardFile(st, dir, "f.txt", true);
    assert.equal(readFileSync(`${dir}/f.txt`, "utf8"), head);
    assert.deepEqual(rf.hunks, []);
    assert.equal(rf.Btext, head);
  }
  // A file the agent created: Discard file deletes it, nothing to review.
  {
    const { st, dir } = await fixture(null, (d) => writeFileSync(`${d}/new.txt`, "a\nb\nc\n"));
    assert.ok((await st.load("new.txt", (await st.index())["new.txt"])).hunks.length > 0);
    const rf = await discardFile(st, dir, "new.txt", false);
    assert.equal(existsSync(`${dir}/new.txt`), false);
    assert.deepEqual(rf.hunks, []);
  }
  // A file the agent deleted: Discard file brings it back, nothing to review.
  {
    const { st, dir } = await fixture(null, (d) => unlinkSync(`${d}/gone.txt`));
    assert.ok((await st.load("gone.txt", (await st.index())["gone.txt"])).hunks.length > 0);
    const rf = await discardFile(st, dir, "gone.txt", true);
    assert.equal(readFileSync(`${dir}/gone.txt`, "utf8"), head);
    assert.deepEqual(rf.hunks, []);
  }
  // The user's edit was in the baseline and the agent deleted the file: back as HEAD, baseline follows.
  {
    const { st, dir } = await fixture("l1\nMINE\nl3\nl4\nl5\nl6\n", (d) => unlinkSync(`${d}/f.txt`));
    const rf = await discardFile(st, dir, "f.txt", true);
    assert.equal(readFileSync(`${dir}/f.txt`, "utf8"), head);
    assert.deepEqual(rf.hunks, []);
  }
  assert.equal(fileDiscardWrite({ Btext: "a\n", Ctext: "a\n" }), null);
  assert.deepEqual(fileDiscardWrite({ Btext: "a\n", Ctext: null }), { target: "baseline", before: "a\n", after: "" });
} finally { for (const d of made) rmSync(d, { recursive: true, force: true }); }
