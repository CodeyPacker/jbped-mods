// Review on another machine (D2, D3): a Store with `on` captures, adopts, accepts, rejects, undoes and
// reconciles with every call on that machine. The shim runs machine "vps" here and records the calls.
import { Store } from "../mods/wingman/store.js";
import { Capture, isWriteTemp } from "../mods/wingman/capture.js";
import { acceptAt, rejectAt, rejectAll } from "../mods/wingman/model.js";
import { remoteCalls } from "herdr";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const on = "vps", dir = mkdtempSync(`${tmpdir()}/rrev-`);
const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
const index = () => JSON.parse(readFileSync(`${dir}/.git/wingman/index.json`, "utf8"));
assert.ok(isWriteTemp(".wingman-abc123.tmp") && isWriteTemp("src/.wingman-x1.tmp") && !isWriteTemp("wingman-a.tmp") && !isWriteTemp("a/.wingman-x.tmpl"));
try {
  g("init", "-q", "-b", "main");
  writeFileSync(`${dir}/a.txt`, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n"); writeFileSync(`${dir}/c.txt`, "c\n");
  g("add", "."); g("commit", "-qm", "1");
  remoteCalls.length = 0;
  const st = await Store.open(dir, on), cap = new Capture(st);
  // The agent starts: a snapshot there, by snapshot.sh's text (the machine doesn't have the file).
  const t0 = await cap.snapshot();
  const snap = remoteCalls.find((c) => c.cmd === "sh");
  assert.ok(snap && snap.args[0] === "-c" && snap.args[1].includes("write-tree") && snap.args.at(-1) === dir);
  assert.ok(existsSync(`${dir}/.git/wingman/baselines`)); // made by the script there
  await cap.setState({ tree: t0, since: 1 });
  assert.equal((await cap.state()).tree, t0);
  // It edits a.txt in two places, adds b.txt, deletes c.txt; a temp file of a save is never reviewed.
  writeFileSync(`${dir}/a.txt`, "one\nTWO\nthree\nfour\nfive\nSIX\nseven\n"); writeFileSync(`${dir}/b.txt`, "new\n"); rmSync(`${dir}/c.txt`);
  writeFileSync(`${dir}/.wingman-zz9.tmp`, "half");
  remoteCalls.length = 0;
  assert.equal(await cap.adopt(t0, await cap.snapshot(), "t1", "spA"), 3);
  rmSync(`${dir}/.wingman-zz9.tmp`);
  assert.ok(remoteCalls.length > 0 && remoteCalls.every((c) => c.on === on));
  const ix = index();
  assert.deepEqual(Object.keys(ix.files).sort(), ["a.txt", "b.txt", "c.txt"]);
  assert.equal(ix.files["b.txt"].created, true);
  assert.equal(readFileSync(`${dir}/.git/wingman/baselines/${ix.files["a.txt"].baseline}`, "utf8"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");

  // Review loads it there; accept the first change, reject the second.
  let f = await st.load("a.txt", ix.files["a.txt"]);
  assert.equal(f.hunks.length, 2);
  const run = async (f, action) => { const { state, write } = action(f); const w = await st.apply(f, write); return { state: { ...state, diskC: state.Ctext, diskB: state.Btext }, w }; };
  const a1 = await run(f, (s) => acceptAt(s, 0));
  assert.equal(readFileSync(`${dir}/.git/wingman/baselines/${ix.files["a.txt"].baseline}`, "utf8"), "one\nTWO\nthree\nfour\nfive\nsix\nseven\n");
  f = await st.load("a.txt", ix.files["a.txt"]);
  assert.equal(f.hunks.length, 1);
  const r1 = await run(f, (s) => rejectAt(s, 0));
  assert.equal(readFileSync(`${dir}/a.txt`, "utf8"), "one\nTWO\nthree\nfour\nfive\nsix\nseven\n");
  // Undo the rejection: the agent's line is back.
  await st.undo([r1.w]);
  assert.equal(readFileSync(`${dir}/a.txt`, "utf8"), "one\nTWO\nthree\nfour\nfive\nSIX\nseven\n");
  // Someone else wrote the file meanwhile: undoing the acceptance's baseline write still works (its own file),
  // but a stale write to a.txt is refused.
  writeFileSync(`${dir}/a.txt`, "changed elsewhere\n");
  await assert.rejects(st.undo([r1.w]), /changed since it was read/);
  assert.equal(readFileSync(`${dir}/a.txt`, "utf8"), "changed elsewhere\n");
  await st.undo([a1.w]);
  writeFileSync(`${dir}/a.txt`, "one\nTWO\nthree\nfour\nfive\nSIX\nseven\n");

  // Reject the created file: deleted there.
  const fb = await st.load("b.txt", ix.files["b.txt"]);
  await run(fb, rejectAll);
  assert.ok(!existsSync(`${dir}/b.txt`));

  // Commit a.txt there: reconcile moves it to done.
  g("add", "a.txt"); g("commit", "-qm", "agent");
  remoteCalls.length = 0;
  await st.reconcile(() => "spA");
  assert.ok(remoteCalls.every((c) => c.on === on));
  const after = index();
  assert.ok(!after.files["a.txt"]);
  assert.ok(Object.keys(after.done).some((k) => k.endsWith("|a.txt")));
  // Capture state clears; no temp files anywhere.
  await cap.setState({ tree: null });
  assert.equal((await cap.state()).tree, null);
  const all = execFileSync("find", [dir, "-name", ".wingman-*"], { encoding: "utf8" }).trim();
  assert.equal(all, "");
  assert.ok(readdirSync(`${dir}/.git/wingman/baselines`).length >= 2);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("remotereview ok");
