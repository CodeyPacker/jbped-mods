// When an agent's change counts as committed (Store.reconcile -> index.done): only when HEAD holds
// what the file had while it differed from HEAD (F2). Real repos, deterministic.
import { Store, sumOf } from "../mods/wingman/store.js";
import { Capture } from "../mods/wingman/capture.js";
import { execCalls, fake } from "herdr";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const made = [];
async function setup(lines = "l1\nl2\nl3\nl4\nl5\nl6\n", config = [], on = null) {
  const up = mkdtempSync(`${tmpdir()}/cm-up-`), dir = mkdtempSync(`${tmpdir()}/cm-`);
  made.push(up, dir);
  const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
  g(up, "init", "-q", "-b", "main"); writeFileSync(`${up}/f.txt`, lines); writeFileSync(`${up}/other.txt`, "o\n"); g(up, "add", "."); g(up, "commit", "-qm", "c");
  g(dir, "clone", "-q", up, ".");
  for (const [k, v] of config) g(dir, "config", k, v);
  const st = await Store.open(dir, on), cap = new Capture(st);
  await st.reconcile();
  const t0 = await cap.snapshot();
  return { up, dir, st, cap, t0, g: (...a) => g(dir, ...a), gu: (...a) => g(up, ...a), put: (rel, t) => writeFileSync(`${dir}/${rel}`, t) };
}
const ix = (st) => JSON.parse(readFileSync(`${st.dir}/index.json`, "utf8"));
const inReview = (st) => Object.keys(ix(st).files);
const done = (st) => Object.keys(ix(st).done ?? {});
const agent = async (s, text) => { s.put("f.txt", text); assert.equal(await s.cap.adopt(s.t0, await s.cap.snapshot()), 1); };

try {
  // 1. The agent's change, committed: it leaves Review.
  {
    const s = await setup();
    await agent(s, "l1\nAGENT\nl3\nl4\nl5\nl6\n");
    assert.equal(ix(s.st).files["f.txt"].sum, await sumOf("l1\nAGENT\nl3\nl4\nl5\nl6\n"));
    await s.st.reconcile();
    s.g("commit", "-qam", "agent");
    await s.st.reconcile();
    assert.deepEqual(inReview(s.st), []); assert.deepEqual(done(s.st), ["main|f.txt"]);
  }
  // 2. The user edits further, a pass sees it, then commits: it leaves Review.
  {
    const s = await setup();
    await agent(s, "l1\nAGENT\nl3\nl4\nl5\nl6\n");
    s.put("f.txt", "l1\nAGENT\nl3\nUSER\nl5\nl6\n");
    await s.st.reconcile();
    s.g("commit", "-qam", "both");
    await s.st.reconcile();
    assert.deepEqual(inReview(s.st), []);
  }
  // 2b. The same without a pass in between, through Changes' Commit (Store.remember first).
  {
    const s = await setup();
    await agent(s, "l1\nAGENT\nl3\nl4\nl5\nl6\n");
    await s.st.reconcile();
    s.put("f.txt", "l1\nAGENT\nl3\nUSER\nl5\nl6\n");
    await s.st.remember(["f.txt", "other.txt"]);
    s.g("commit", "-qam", "both");
    await s.st.reconcile();
    assert.deepEqual(inReview(s.st), []);
  }
  // 3. git stash, pull (upstream changed the same file), stash pop: the change stays in Review throughout.
  // Here and as machine "vps" (one call hashes the files there).
  for (const on of [null, "vps"]) {
    const s = await setup(undefined, [], on);
    await agent(s, "l1\nAGENT\nl3\nl4\nl5\nl6\n");
    await s.st.reconcile();
    writeFileSync(`${s.up}/f.txt`, "l1\nl2\nl3\nl4\nl5\nUPSTREAM\n"); s.gu("commit", "-qam", "u");
    s.g("stash", "-q"); await s.st.reconcile();
    s.g("pull", "-q", "--ff-only"); await s.st.reconcile();
    assert.deepEqual(inReview(s.st), ["f.txt"]); assert.deepEqual(done(s.st), []);
    s.g("stash", "pop", "-q"); await s.st.reconcile();
    assert.equal(readFileSync(`${s.dir}/f.txt`, "utf8"), "l1\nAGENT\nl3\nl4\nl5\nUPSTREAM\n");
    assert.deepEqual(inReview(s.st), ["f.txt"]);
    // Committing it now (with upstream's line in it) still counts.
    s.g("commit", "-qam", "after pop"); await s.st.reconcile();
    assert.deepEqual(inReview(s.st), []); assert.deepEqual(done(s.st), ["main|f.txt"]);
  }
  // 4. Discarded (git checkout -- file), then another file committed: never AI work that was committed.
  {
    const s = await setup();
    await agent(s, "l1\nAGENT\nl3\nl4\nl5\nl6\n");
    await s.st.reconcile();
    s.g("checkout", "--", "f.txt"); await s.st.reconcile();
    s.put("other.txt", "x\n"); s.g("commit", "-qam", "other"); await s.st.reconcile();
    assert.deepEqual(done(s.st), []); assert.deepEqual(inReview(s.st), ["f.txt"]);
  }
  // 5. Amend: committed, then amended before a pass saw the first commit, and with more after.
  {
    const s = await setup();
    await agent(s, "l1\nAGENT\nl3\nl4\nl5\nl6\n");
    await s.st.reconcile();
    s.g("commit", "-qam", "a"); s.g("commit", "-q", "--amend", "-m", "a2");
    await s.st.reconcile();
    assert.deepEqual(inReview(s.st), []);
  }
  // 6. Partly staged: one of the agent's two changes committed. It stays; the rest committed later, it leaves.
  {
    const s = await setup();
    await agent(s, "l1\nAGENT\nl3\nl4\nl5\nAGENT2\n");
    await s.st.reconcile();
    s.put("f.txt", "l1\nAGENT\nl3\nl4\nl5\nl6\n"); s.g("add", "f.txt"); s.put("f.txt", "l1\nAGENT\nl3\nl4\nl5\nAGENT2\n");
    s.g("commit", "-qm", "half"); await s.st.reconcile();
    assert.deepEqual(inReview(s.st), ["f.txt"]);
    s.g("commit", "-qam", "rest"); await s.st.reconcile();
    assert.deepEqual(inReview(s.st), []);
  }
  // 7. An entry with no sum (the hook's, or from before sums): the first pass that sees the file differ remembers it.
  {
    const s = await setup();
    s.put("f.txt", "l1\nHOOK\nl3\nl4\nl5\nl6\n");
    const i = { version: 1 }; i.files = { "f.txt": { baseline: "h.txt", created: false, branch: "main", head: s.g("rev-parse", "HEAD").trim() } };
    writeFileSync(`${s.st.dir}/baselines/h.txt`, "l1\nl2\nl3\nl4\nl5\nl6\n"); writeFileSync(`${s.st.dir}/index.json`, JSON.stringify(i));
    await s.st.reconcile();
    assert.equal(JSON.parse(readFileSync(`${s.st.dir}/sums.json`, "utf8"))["h.txt"], await sumOf("l1\nHOOK\nl3\nl4\nl5\nl6\n"));
    writeFileSync(`${s.up}/f.txt`, "l1\nl2\nl3\nl4\nl5\nUPSTREAM\n"); s.gu("commit", "-qam", "u");
    s.g("stash", "-q"); s.g("pull", "-q", "--ff-only"); await s.st.reconcile();
    assert.deepEqual(inReview(s.st), ["f.txt"]);
  }
  // 8. Line endings: a CRLF working file under core.autocrlf=true (HEAD has LF).
  {
    const s = await setup("l1\nl2\nl3\n", [["core.autocrlf", "true"]]);
    s.put("f.txt", "l1\r\nAGENT\r\nl3\r\n"); assert.equal(await s.cap.adopt(s.t0, await s.cap.snapshot()), 1);
    await s.st.reconcile();
    s.g("commit", "-qam", "crlf"); await s.st.reconcile();
    assert.deepEqual(inReview(s.st), []);
  }
  // 9. F3: a file over 1 MiB can't be read: not committed, and the pass goes on.
  {
    const s = await setup();
    await agent(s, "l1\nAGENT\nl3\nl4\nl5\nl6\n");
    await s.st.reconcile();
    s.put("f.txt", "x".repeat(1100000) + "\n"); s.g("commit", "-qam", "big");
    await s.st.reconcile();
    assert.deepEqual(inReview(s.st), ["f.txt"]);
    assert.equal(await s.st.committed("f.txt", ix(s.st).files["f.txt"], s.g("rev-parse", "HEAD").trim(), "x"), false);
  }
  // 10. F8: a pass that's still running when the next is due skips that one.
  {
    const s = await setup();
    await agent(s, "l1\nAGENT\nl3\nl4\nl5\nl6\n");
    let release; const gate = new Promise((r) => (release = r));
    fake.read = (p) => (p.endsWith("index.json") ? gate.then(() => readFileSync(p, "utf8")) : undefined);
    const first = s.st.reconcile();
    const n = execCalls.length;
    await s.st.reconcile(); await s.st.reconcile();
    assert.equal(execCalls.length, n, "the skipped passes ran nothing");
    fake.read = null; release(); await first;
    assert.equal(s.st.reconciling, false);
  }
} finally { for (const d of made) rmSync(d, { recursive: true, force: true }); }
console.log("committed tests pass");
