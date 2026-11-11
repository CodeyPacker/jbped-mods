import { Store, branchOf, shows, parkStale } from "../mods/wingman/store.js";
import { Capture } from "../mods/wingman/capture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

assert.equal(branchOf("ref: refs/heads/48752-fix\n"), "48752-fix");
assert.equal(branchOf("0123456789abcdef0123\n"), "@0123456789ab");
assert.equal(branchOf(null), null);
const so = (by) => ({ t22: "spA" })[by] ?? null;
assert.equal(shows({ branch: "a", space: "s1" }, "a", "s1"), true);
assert.equal(shows({ branch: "a" }, "b", "s1"), false);
assert.equal(shows({ branch: "a", space: "s2" }, "a", "s1"), false);
assert.equal(shows({ by: "t22" }, "a", "spB", so), false); // old entry: its agent's space
assert.equal(shows({ by: "t22" }, "a", "spA", so), true);
assert.equal(shows({ by: "gone" }, "a", "spA", so), true); // unknown: shown
const ix = { files: { "a.ts": { branch: "x" }, "b.ts": { branch: "y" } } };
assert.equal(parkStale(ix, "a.ts", "y"), true); assert.equal(parkStale(ix, "b.ts", "y"), false);
assert.deepEqual(ix, { files: { "b.ts": { branch: "y" } }, parked: { "x|a.ts": { branch: "x" } } });

const dir = mkdtempSync(`${tmpdir()}/rc-`), g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
const index = () => JSON.parse(readFileSync(`${dir}/.git/wingman/index.json`, "utf8"));
try {
  g("init", "-q", "-b", "main"); writeFileSync(`${dir}/a.ts`, "1\n"); g("add", "."); g("commit", "-qm", "1");
  g("switch", "-q", "-c", "task");
  const st = await Store.open(dir), cap = new Capture(st);
  mkdirSync(`${dir}/.git/wingman/baselines`, { recursive: true });
  // An agent in space spA edits a.ts and adds b.ts on branch "task".
  const t0 = await cap.snapshot();
  writeFileSync(`${dir}/a.ts`, "1\n2\n"); writeFileSync(`${dir}/b.ts`, "new\n");
  assert.equal(await cap.adopt(t0, await cap.snapshot(), "t22", "spA"), 2);
  let i = index();
  assert.equal(i.files["a.ts"].branch, "task"); assert.equal(i.files["a.ts"].space, "spA"); assert.match(i.files["a.ts"].head, /^[0-9a-f]{40}$/);
  await st.reconcile(so);
  assert.deepEqual(Object.keys(index().files).sort(), ["a.ts", "b.ts"]); // nothing committed yet
  // Committing a.ts only: it leaves the review for done; b.ts stays.
  g("add", "a.ts"); g("commit", "-qm", "a");
  await st.reconcile(so);
  i = index();
  assert.deepEqual(Object.keys(i.files), ["b.ts"]);
  assert.equal(i.done["task|a.ts"].space, "spA");
  // Switching to main parks b.ts (an untracked file carries over, but its entry belongs to "task").
  g("switch", "-q", "main");
  await st.reconcile(so);
  i = index();
  assert.deepEqual(Object.keys(i.files), []); assert.ok(i.parked["task|b.ts"]);
  // An edit on main to b.ts starts its own entry beside the parked one.
  const t1 = await cap.snapshot(); writeFileSync(`${dir}/a.ts`, "1\nmain\n");
  assert.equal(await cap.adopt(t1, await cap.snapshot(), null, "spA"), 1);
  assert.equal(index().files["a.ts"].branch, "main");
  g("checkout", "-q", "--", "a.ts");
  // Back on task: b.ts returns; main's a.ts entry is parked.
  g("switch", "-q", "task");
  await st.reconcile(so);
  i = index();
  assert.deepEqual(Object.keys(i.files), ["b.ts"]); assert.ok(i.parked["main|a.ts"]);
  // An entry from before branches were recorded: committed when HEAD differs from its baseline.
  i.files["c.ts"] = { baseline: "old.txt", created: true, by: "t22" };
  writeFileSync(`${dir}/.git/wingman/baselines/old.txt`, "");
  writeFileSync(`${dir}/.git/wingman/index.json`, JSON.stringify(i));
  writeFileSync(`${dir}/c.ts`, "c\n"); g("add", "c.ts"); g("commit", "-qm", "c");
  await st.reconcile(so);
  i = index();
  assert.ok(!i.files["c.ts"]); assert.equal(i.done["task|c.ts"].space, "spA");
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("reconcile tests pass");
