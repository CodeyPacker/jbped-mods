// G4 checkpoints: one per agent turn (capturePass with the real Capture and git), bounded with their
// refs, titled from the hook's prompt event, listed per turn, and restored compare-and-swap
// (modified, created and deleted files), refused on unsaved edits, a working agent or another
// branch, safe from `git gc --prune=now`, on this computer and on another machine (shim "vps").
import { titleOf, notePrompt, promptFor, forgetPrompts, newId, validId, parse, addTo, patch, turnRows, agentsSince, confirmText, restoreNote, planSig, safeRel, parseRaw,
  Checkpoints, planRestore, applyRestore, MAX_CHECKPOINTS, MAX_FILES, REF, PROMPT_WINDOW } from "../mods/wingman/checkpoints.js";
import { capturePass } from "../mods/wingman/captureplan.js";
import { Capture } from "../mods/wingman/capture.js";
import { Store } from "../mods/wingman/store.js";
import { Journal } from "../mods/wingman/journal.js";
import { appHome, world } from "herdr";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---- pure parts --------------------------------------------------------------------------------
assert.equal(titleOf("\n  Fix the login\tbug  \nand more"), "Fix the login bug");
assert.equal(titleOf("a\u0007b\u001b[31mc\u202ed"), "ab[31mcd", "control and bidi characters dropped");
assert.equal(titleOf("x".repeat(200)).length, 80);
assert.ok(titleOf("x".repeat(200)).endsWith("…"));
assert.equal(titleOf(null), "");
forgetPrompts();
notePrompt("t1", "First line\nsecond", 1000);
assert.equal(promptFor("t1", 1000 + PROMPT_WINDOW), "First line");
assert.equal(promptFor("t1", 1001 + PROMPT_WINDOW), null, "a prompt from long before the turn isn't its title");
assert.equal(promptFor("t2", 1000), null);
assert.ok(validId(newId(Date.now())));
assert.ok(!validId("../x") && !validId("a b") && !validId(""));
assert.deepEqual(parse("not json"), { version: 1, list: [] });
assert.deepEqual(parse(JSON.stringify({ list: [{ id: "../../x", tree: "a".repeat(40) }] })).list, [], "a bad id is dropped (it names a ref)");
{
  const d = { version: 1, list: [] }, tree = "a".repeat(40);
  let pruned = [];
  for (let i = 0; i < 33; i++) pruned.push(...addTo(d, { id: `k${i}-aaaaaa`, tree, at: i }, MAX_CHECKPOINTS));
  assert.equal(d.list.length, 30);
  assert.deepEqual(pruned, ["k0-aaaaaa", "k1-aaaaaa", "k2-aaaaaa"], "oldest first");
  assert.equal(patch(d, "k32-aaaaaa", { files: ["a", "b"] }), true);
  assert.equal(patch(d, "k32-aaaaaa", { files: ["a", "b"] }), false, "unchanged");
  assert.equal(patch(d, "k32-aaaaaa", { prompt: "t" }), true);
  assert.equal(patch(d, "k32-aaaaaa", { prompt: "u" }), false, "the first title stays");
  assert.equal(patch(d, "nope-aaaaaa", { files: [] }), false);
  const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => `f${i}`);
  patch(d, "k31-aaaaaa", { files: many });
  assert.equal(d.list.find((e) => e.id === "k31-aaaaaa").files.length, MAX_FILES);
  assert.equal(d.list.find((e) => e.id === "k31-aaaaaa").count, MAX_FILES + 5);
}
{
  const tree = "b".repeat(40);
  const repos = [
    { key: "A", name: "api", data: { list: [{ id: "a1-x", turn: "T1", tree, at: 10, agent: "t1", space: "s1", files: ["x.ts"], count: 1 }, { id: "a2-x", turn: "T2", tree, at: 20, agent: "t2", space: "s1", files: [], count: 0, prompt: "p" }] } },
    { key: "W", name: "web", data: { list: [{ id: "w1-x", turn: "T1", tree, at: 11, agent: "t1", space: "s1", files: ["y.ts", "z.ts"], count: 2 }, { id: "w9-x", turn: "T9", tree, at: 30, agent: "t9", space: "s2", files: [] }, { id: "w8-x", tree, at: 5, agent: null, space: null, files: [] }] } },
  ];
  const rows = turnRows(repos, "s1");
  assert.deepEqual(rows.map((r) => r.id), ["T2", "T1", "w8-x"], "newest first, one row per turn, another space's left out");
  assert.equal(rows[1].count, 3); assert.equal(rows[1].parts.length, 2); assert.equal(rows[1].at, 10);
  assert.deepEqual(rows[1].files.map((f) => `${f.name}/${f.rel}`), ["api/x.ts", "web/y.ts", "web/z.ts"]);
  assert.deepEqual(agentsSince(rows, rows[1]), ["t2", "t1"]);
}
assert.ok(safeRel("a/b.ts") && !safeRel("../x") && !safeRel("/etc/passwd") && !safeRel("a/.git/config") && !safeRel("C:/x") && !safeRel("a//b"));
assert.deepEqual(parseRaw(":100644 000000 abc def D\0gone.txt\0:000000 120000 abc def A\0link\0"),
  [{ status: "D", path: "gone.txt", from: "100644", to: "000000" }, { status: "A", path: "link", from: "000000", to: "120000" }]);
assert.match(restoreNote(["/r/a.ts", "/r/b.ts"], "14:02"), /restored 2 files to how they were before the agent turn at 14:02: \/r\/a\.ts, \/r\/b\.ts/);

// ---- git -----------------------------------------------------------------------------------------
const dir = mkdtempSync(`${tmpdir()}/checkpoints-`);
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const cpList = (repo) => JSON.parse(readFileSync(`${repo}/.git/wingman/checkpoints.json`, "utf8")).list;
const refs = (repo) => git(repo, "for-each-ref", "--format=%(objecttype) %(refname)", REF).trim().split("\n").filter(Boolean);
let n = 0;
function mkRepo() {
  const repo = `${dir}/r${n++}`;
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(`${repo}/a.txt`, "a1\n"); writeFileSync(`${repo}/b.txt`, "b1\n"); mkdirSync(`${repo}/sub`); writeFileSync(`${repo}/sub/c.txt`, "c1\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "1");
  return repo;
}
/** A capture record as the leader keeps it, for an agent `who` of space s1. */
const record = (store, who = "t1") => ({ capture: new Capture(store), active: false, after: false, by: null, who, space: "s1", turn: null, fresh: false });
/** One agent turn on `c`: start (snapshot + checkpoint), `work()`, a pass, the end (last pass clears). */
async function turn(c, work, turnId = newId()) {
  c.active = true; c.turn = turnId;
  await capturePass(c, true);
  await work();
  await capturePass(c);
  c.active = false; c.after = true;
  await capturePass(c);
}
const unsafeHeld = () => [];

try {
  // A turn: modifies a.txt, creates n.txt, deletes b.txt. One checkpoint with the files and a tree ref.
  const repo = mkRepo(), st = await Store.open(repo), c = record(st);
  writeFileSync(`${repo}/u.txt`, "untracked\n"); // so no commit holds the checkpoint's tree: only its ref keeps it from gc
  notePrompt("t1", "Refactor the parser\nthen run tests", Date.now());
  await turn(c, async () => { writeFileSync(`${repo}/a.txt`, "a2\n"); writeFileSync(`${repo}/n.txt`, "new\n"); unlinkSync(`${repo}/b.txt`); });
  let list = cpList(repo);
  assert.equal(list.length, 1);
  assert.deepEqual([...list[0].files].sort(), ["a.txt", "b.txt", "n.txt"]);
  assert.equal(list[0].count, 3);
  assert.equal(list[0].agent, "t1"); assert.equal(list[0].space, "s1"); assert.equal(list[0].branch, "main");
  assert.equal(list[0].prompt, "Refactor the parser");
  assert.deepEqual(refs(repo), [`tree ${REF}${list[0].id}`]);
  assert.equal(git(repo, "rev-parse", `${REF}${list[0].id}`).trim(), list[0].tree);
  assert.equal(JSON.parse(read(`${repo}/.git/wingman/capture.json`)).tree, null, "the turn ended");
  // A second turn is a second checkpoint.
  await turn(c, async () => { writeFileSync(`${repo}/sub/c.txt`, "c2\n"); });
  list = cpList(repo);
  assert.equal(list.length, 2);
  assert.deepEqual(list[1].files, ["sub/c.txt"]);
  assert.equal(git(repo, "status", "--porcelain").includes("wingman"), false, "nothing of it in git status");
  assert.equal(git(repo, "stash", "list"), "");

  // gc: the trees stay (their refs keep them), and nothing else of the user's changed.
  assert.notEqual(git(repo, "rev-parse", "HEAD^{tree}").trim(), list[0].tree);
  git(repo, "reflog", "expire", "--expire=now", "--all");
  git(repo, "gc", "--prune=now", "-q");
  assert.equal(git(repo, "cat-file", "-t", list[0].tree).trim(), "tree");

  // Restore to before the first turn: a.txt back, n.txt deleted, b.txt back, sub/c.txt back.
  const rows = turnRows([{ key: st.root, name: "r", data: { list } }], "s1");
  assert.equal(rows.length, 2);
  const first = rows[1], parts = first.parts.map((p) => ({ store: st, key: p.key, name: p.name, entry: p.entry }));
  const plan = await planRestore(parts);
  const files = Object.fromEntries(plan.parts[0].files.map((f) => [f.rel, [f.before, f.after]]));
  assert.deepEqual(files, { "a.txt": ["a2\n", "a1\n"], "b.txt": [null, "b1\n"], "n.txt": ["new\n", null], "sub/c.txt": ["c2\n", "c1\n"] });
  assert.match(confirmText(plan, "14:02"), /^Restore 4 files in r to how they were before this turn \(14:02\): 1 created since is deleted, 1 deleted since comes back\?$/);
  // Unsaved edits in a Wingman copy refuse it, naming the files, before anything is written.
  await assert.rejects(applyRestore(plan, { held: (keys) => keys.filter((k) => k.endsWith("|a.txt")) }), /Unsaved edits in a\.txt: save or discard them in Edit first/);
  assert.equal(read(`${repo}/a.txt`), "a2\n");
  assert.equal(cpList(repo).length, 2, "no checkpoint recorded for a refused restore");
  const res = await applyRestore(plan, { held: unsafeHeld, space: "s1", when: "14:02" });
  assert.deepEqual(res.failed, []);
  assert.equal(res.restored.length, 4);
  assert.equal(read(`${repo}/a.txt`), "a1\n"); assert.equal(read(`${repo}/b.txt`), "b1\n"); assert.equal(read(`${repo}/n.txt`), null); assert.equal(read(`${repo}/sub/c.txt`), "c1\n");
  assert.equal(git(repo, "status", "--porcelain"), "?? u.txt\n", "the working tree is as it was before the turn");
  // The "before restore" checkpoint: restoring it goes forward again.
  list = cpList(repo);
  assert.equal(list.length, 3);
  assert.equal(list[2].kind, "restore"); assert.equal(list[2].prompt, "Before restore to 14:02");
  assert.deepEqual([...list[2].files].sort(), ["a.txt", "b.txt", "n.txt", "sub/c.txt"], "its files: the ones the restore changed");
  const fwd = turnRows([{ key: st.root, name: "r", data: { list } }], "s1")[0];
  assert.equal(fwd.kind, "restore");
  const plan2 = await planRestore(fwd.parts.map((p) => ({ store: st, key: p.key, name: p.name, entry: p.entry })));
  await applyRestore(plan2, { space: "s1", when: "x" });
  assert.equal(read(`${repo}/a.txt`), "a2\n"); assert.equal(read(`${repo}/n.txt`), "new\n"); assert.equal(read(`${repo}/b.txt`), null); assert.equal(read(`${repo}/sub/c.txt`), "c2\n");

  // Compare-and-swap: a file changed after the plan was made isn't written, and is named.
  const plan3 = await planRestore(parts);
  writeFileSync(`${repo}/a.txt`, "mine\n");
  const res3 = await applyRestore(plan3, { space: "s1" });
  assert.deepEqual(res3.failed.map((f) => f.rel), ["a.txt"]);
  assert.match(res3.failed[0].why, /changed since it was checked/);
  assert.equal(read(`${repo}/a.txt`), "mine\n");
  assert.equal(planSig(plan3) === planSig(await planRestore(parts)), false, "a fresh plan tells the set changed");

  // A working agent (a turn in progress in capture.json) refuses it.
  c.active = true; c.turn = newId(); await capturePass(c, true);
  await assert.rejects(planRestore(parts), /an agent is working in r: restore once its turn ends/);
  c.active = false; await capturePass(c);

  // Another branch: not restorable, with a message.
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "2"); git(repo, "switch", "-q", "-c", "other");
  await assert.rejects(planRestore(parts), /taken on branch main, and r is on other now: switch back to main to restore it/);
  git(repo, "switch", "-q", "main");

  // The bound: at most MAX_CHECKPOINTS, the oldest pruned with their refs.
  const cps = new Checkpoints(st), tree = list[0].tree;
  for (let i = 0; i < MAX_CHECKPOINTS + 3; i++) await cps.record({ tree, branch: "main", agent: "t1", space: "s1", at: Date.now() + i });
  list = cpList(repo);
  assert.equal(list.length, MAX_CHECKPOINTS);
  assert.deepEqual(refs(repo).sort(), list.map((e) => `tree ${REF}${e.id}`).sort(), "a ref for each kept checkpoint, none for pruned ones");

  // A gone tree (refs deleted by hand, then gc): a clear message, nothing written.
  const repoG = mkRepo(), stG = await Store.open(repoG), cG = record(stG);
  writeFileSync(`${repoG}/b.txt`, "uncommitted before the turn\n"); // so the checkpoint's tree is no commit's
  await turn(cG, async () => { writeFileSync(`${repoG}/a.txt`, "zz\n"); });
  const eG = cpList(repoG)[0];
  git(repoG, "update-ref", "-d", `${REF}${eG.id}`); git(repoG, "reflog", "expire", "--expire=now", "--all"); git(repoG, "gc", "--prune=now", "-q");
  await assert.rejects(planRestore([{ store: stG, key: stG.root, name: "g", entry: eG }]), /gone from g's git store/);

  // The hook's prompt event: saved by the hook (only with a prompt), read by the journal as the title.
  const hookScript = fileURLToPath(new URL("../mods/wingman/hooks/wingman-hook.sh", import.meta.url));
  const data = `${appHome()}/data/wingman`;
  mkdirSync(`${data}/events`, { recursive: true });
  const hook = (input) => execFileSync("sh", [hookScript, "prompt"], { input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, HC_TERMINAL_ID: "t5", HERDR_WINGMAN_DIR: data } });
  const before = readdirSync(`${data}/events`).length;
  hook("{}");
  assert.equal(readdirSync(`${data}/events`).length, before, "no prompt: nothing saved");
  hook(JSON.stringify({ session_id: "s", hook_event_name: "UserPromptSubmit", prompt: "Add checkpoints\nto Review", cwd: repo }) + "\n");
  hook(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "x".repeat(70000) }));
  assert.equal(readdirSync(`${data}/events`).length, before + 1, "a prompt over 64 KB isn't saved");
  forgetPrompts();
  world.terminals = [{ address: "t5", labels: {} }];
  const logs = [];
  await new Journal((m) => logs.push(m)).drain();
  assert.equal(promptFor("t5", Date.now()), "Add checkpoints");
  assert.equal(readdirSync(`${data}/events`).length, 0, "read and removed");
  assert.ok(!logs.some((l) => /not in a repo/.test(l)), "a prompt isn't taken for an edit");

  // Another machine ("vps" in the shim): the same calls record and restore there.
  const repoR = mkRepo(), stR = await Store.open(repoR, "vps"), cR = record(stR);
  await turn(cR, async () => { writeFileSync(`${repoR}/a.txt`, "remote\n"); writeFileSync(`${repoR}/sub/new.txt`, "n\n"); unlinkSync(`${repoR}/sub/c.txt`); });
  const eR = JSON.parse(readFileSync(`${repoR}/.git/wingman/checkpoints.json`, "utf8")).list[0];
  assert.deepEqual([...eR.files].sort(), ["a.txt", "sub/c.txt", "sub/new.txt"]);
  rmSync(`${repoR}/sub`, { recursive: true }); // the folder of a deleted file is gone too: it's made again
  const planR = await planRestore([{ store: stR, key: "vps\0" + stR.root, name: "rr", entry: eR }]);
  const resR = await applyRestore(planR, { space: "s1", when: "t" });
  assert.deepEqual(resR.failed, []);
  assert.equal(read(`${repoR}/a.txt`), "a1\n"); assert.equal(read(`${repoR}/sub/c.txt`), "c1\n"); assert.equal(read(`${repoR}/sub/new.txt`), null);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("checkpoints ok");
