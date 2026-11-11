// captureloop: the real capture loop (captureloop.js: lease, lead, collectAll) over real temp git
// repos, the real Store, Capture, snapshot.sh and workspace files, with fake spaces, agents and
// clock (herdr-shim's `world`). Scenarios S1-S11: repos added and dropped, shared repos, two
// spellings of a repo, no agent, deleted spaces and folders, branch switches, a leader change and
// linked worktrees. `WINGMAN_LOOP_CASES=S1,S5` runs only some.
import { world, execCalls } from "./herdr-shim.mjs";
import { CaptureLoop, LEASE_MS, CAPTURE_ERRORS } from "../mods/wingman/captureloop.js";
import { addFolder, removeFolder } from "../mods/wingman/workspace.js";
import { shows } from "../mods/wingman/store.js";
import { mkRepo, isolate, tempDir, cleanup, state } from "./snaphelper.mjs";
import { readFileSync, existsSync, rmSync, mkdirSync, symlinkSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const home = process.env.WINGMAN_TEST_HOME;
if (!home) throw new Error("run with run.sh");
const BASE = join(tmpdir(), "wingman-loop");
isolate(BASE);

const LAYOUT = { id: "w", type: "block", content: { mod: "wingman", props: { view: "review" } } }; // every space reviewed
const clock = { t: 1.7e12 };
const now = () => clock.t;
const cx = { notify() {} };

/** A fresh Herdr world and Wingman data folder. */
function reset() {
  rmSync(join(home, "data"), { recursive: true, force: true });
  mkdirSync(join(home, "data", "wingman"), { recursive: true });
  Object.assign(world, { spaces: [], agents: [], panes: [], terminals: [], layout: LAYOUT });
  world.shared.clear();
}

function newLoop(id = "L1") {
  const lines = [], loop = new CaptureLoop({ id, log: (m) => lines.push(m), now });
  loop.lines = lines;
  /** Log lines since the last mark. */
  loop.since = () => { const out = lines.slice(loop.at ?? 0); loop.at = lines.length; return out; };
  return loop;
}
/** A lead tick (500 ms). */
const tick = async (loop) => { clock.t += 500; await loop.lead(cx); };
/** A collect tick: lead, then collectAll (3 s). */
const pass = async (loop) => { clock.t += 3000; await loop.lead(cx); await loop.collectAll(cx); };
/** Past the 5 s repo lookup. */
const relook = async (loop) => { clock.t += 5100; await loop.lead(cx); };

function space(id, folder) {
  const sp = { id, index: world.spaces.length, name: id, named: true, folder, machine: null, branch: null, active: false, status: null, tabs: [{ id: `${id}-tab` }] };
  world.spaces.push(sp);
  return sp;
}
function agent(address, sp, cwd, status = "idle", app = "claude-code") {
  const a = { address, pane: `${address}-p`, space: sp.id, tab: sp.tabs[0].id, status, app };
  world.agents.push(a);
  world.panes.push({ pane: a.pane, terminal: address, tab: sp.tabs[0].id, cwd });
  return a;
}
const dropAgent = (a) => { world.agents = world.agents.filter((x) => x !== a); world.panes = world.panes.filter((p) => p.pane !== a.pane); };

const repo = () => mkRepo(BASE, { files: { "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" } });
const folder = () => tempDir(BASE, "ticket-");
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const index = (r, gitDir = r.gitDir) => readJson(join(gitDir, "wingman", "index.json")) ?? { files: {} };
/** The review entries: path -> { by, space, branch, created }. */
const entries = (r, gitDir) => Object.fromEntries(Object.entries(index(r, gitDir).files).map(([p, e]) => [p, { by: e.by ?? null, space: e.space ?? null, branch: e.branch, created: !!e.created }]));
const capState = (r, gitDir = r.gitDir) => readJson(join(gitDir, "wingman", "capture.json"));
const e = (by, space, branch = "main", created = false) => ({ by, space, branch, created });
const snaps = (lines) => lines.filter((l) => /^snapshot [0-9a-f]{40}/.test(l)).length;
const has = (lines, s) => assert.ok(lines.some((l) => l.includes(s)), `no log line with ${JSON.stringify(s)} in:\n${lines.join("\n")}`);

/** What a repo had before: refs, HEAD, index file. After: the same, and git status names only `edited`. */
function guard(r) {
  const before = state(r), gitDir = r.gitDir;
  return (edited, { head = true, idx = true } = {}) => {
    const after = state(r);
    if (idx) assert.equal(after.index, before.index, `${r.dir}: the real index changed`);
    assert.equal(after.refs, before.refs, `${r.dir}: refs changed`);
    if (head) assert.equal(after.head, before.head, `${r.dir}: HEAD changed`);
    const paths = after.status.split("\0").filter(Boolean).map((l) => l.slice(3)).sort();
    assert.deepEqual(paths, [...edited].sort(), `${r.dir}: status`);
    const left = readdirSync(join(gitDir, "wingman")).filter((n) => !["index.json", "capture.json", "sums.json", "baselines"].includes(n));
    assert.deepEqual(left, [], `${r.dir}: unexpected files in the review store`);
  };
}

const only = process.env.WINGMAN_LOOP_CASES?.split(",");
const results = [];
async function scenario(name, fn) {
  if (only && !only.includes(name)) return;
  reset();
  const t0 = Date.now();
  try { await fn(); results.push(`${name} ok ${Date.now() - t0} ms`); }
  catch (err) { results.push(`${name} FAIL`); console.log(`${name}: ${err.stack ?? err}`); process.exitCode = 1; }
}

try {
  // S1: one space, one repo; a turn: snapshot, an edit adopted with credit, the last pass clears.
  await scenario("S1", async () => {
    const A = repo(), ok = guard(A), sp = space("s1", folder()), a = agent("t1", sp, A.dir), L = newLoop();
    await tick(L);
    assert.equal(L.captures.size, 1);
    has(L.since(), `s1: capturing ${A.dir}`);
    assert.equal(capState(A), null, "no snapshot while idle");
    a.status = "working";
    await tick(L);
    let lines = L.since();
    has(lines, "s1: agent working"); has(lines, `${A.dir}: working`);
    assert.equal(snaps(lines), 1);
    const tree = capState(A).tree;
    assert.match(tree, /^[0-9a-f]{40}$/);
    A.w("a.txt", "a edited\n"); A.w("new.txt", "new\n");
    await pass(L);
    has(L.since(), "adopted 2 files");
    assert.deepEqual(entries(A), { "a.txt": e("t1", "s1"), "new.txt": e("t1", "s1", "main", true) });
    assert.equal(capState(A).tree, tree, "same working period");
    A.w("b.txt", "b edited\n");
    a.status = "idle";
    await tick(L);
    has(L.since(), `${A.dir}: idle`);
    await pass(L);
    lines = L.since();
    has(lines, "adopted 1 files");
    assert.equal(snaps(lines), 0);
    assert.deepEqual(entries(A)["b.txt"], e("t1", "s1"), "the last pass is credited too");
    assert.equal(capState(A).tree, null, "state cleared");
    A.w("c.txt", "c by hand\n");
    await pass(L);
    assert.equal(entries(A)["c.txt"], undefined, "nothing adopted after the turn");
    ok(["a.txt", "b.txt", "c.txt", "new.txt"]);
  });

  // S2-S4: a repo added mid-turn, dropped mid-turn, edited while out, added again.
  await scenario("S2-S4", async () => {
    const A = repo(), B = repo(), okA = guard(A), okB = guard(B), T = folder(), sp = space("s1", T), a = agent("t1", sp, A.dir, "working"), L = newLoop();
    await tick(L);
    assert.equal(L.captures.size, 1);
    const treeA = capState(A).tree;
    L.since();
    // S2
    B.w("a.txt", "before add\n"); // baseline: made before B joined
    await addFolder(sp, B.dir, [A.dir]);
    assert.ok(readdirSync(T).some((n) => n.endsWith(".code-workspace")), "the workspace file was made");
    await relook(L);
    let lines = L.since();
    has(lines, `s1: capturing ${B.dir}`); has(lines, `${B.dir}: working`);
    assert.equal(snaps(lines), 1, "B snapshots right away, A doesn't again");
    assert.equal(capState(A).tree, treeA);
    B.w("b.txt", "agent edit in B\n");
    await pass(L);
    assert.deepEqual(entries(B), { "b.txt": e("t1", "s1") }, "S2: the edit before the add is baseline");
    assert.equal(snaps(L.since()), 0);
    // S3
    await removeFolder(sp, B.dir);
    B.w("c.txt", "agent edit just before the drop\n");
    await relook(L);
    lines = L.since();
    has(lines, `stopped capturing ${B.dir}`);
    assert.equal(L.captures.size, 1);
    B.w("new-while-out.txt", "made while out\n"); B.w("a.txt", "edited while out\n");
    await pass(L); await pass(L);
    const s3 = { stateAfterDrop: capState(B)?.tree ?? null, entries: entries(B) };
    assert.equal(s3.stateAfterDrop, null, "S3: no saved snapshot left behind by the drop");
    assert.deepEqual(s3.entries, { "b.txt": e("t1", "s1"), "c.txt": e("t1", "s1") }, "S3: the drop's last pass took the edit made before it");
    // S4
    await addFolder(sp, B.dir, [A.dir]);
    await relook(L);
    lines = L.since();
    has(lines, `s1: capturing ${B.dir}`);
    assert.equal(snaps(lines), 1, "a new working period for B");
    B.w("b.txt", "agent edit after re-add\n"); B.w("after.txt", "after\n");
    await pass(L);
    const got = entries(B);
    assert.deepEqual(Object.keys(got).sort(), ["after.txt", "b.txt", "c.txt"], "S4: earlier entries back, edits made while out are baseline");
    const branch = "main";
    for (const ent of Object.values(index(B).files)) assert.ok(shows(ent, branch, "s1"), "shown in s1");
    a.status = "idle";
    await tick(L); await pass(L);
    assert.equal(capState(A).tree, null); assert.equal(capState(B).tree, null);
    okA([]); okB(["a.txt", "b.txt", "c.txt", "after.txt", "new-while-out.txt"]);
  });

  // S5: two spaces share one repo.
  await scenario("S5", async () => {
    const R = repo(), ok = guard(R), sA = space("sA", folder()), sB = space("sB", folder());
    const a1 = agent("t1", sA, R.dir), a2 = agent("t2", sB, R.dir), L = newLoop();
    await tick(L);
    assert.equal(L.captures.size, 1, "one record");
    assert.equal(L.since().filter((l) => l.includes("capturing")).length, 1);
    // At different times.
    a1.status = "working"; await tick(L);
    assert.equal(snaps(L.since()), 1);
    R.w("f1.txt", "1\n"); await pass(L);
    a1.status = "idle"; await tick(L); await pass(L);
    assert.equal(capState(R).tree, null);
    a2.status = "working"; await tick(L);
    assert.equal(snaps(L.since()), 1, "one snapshot per working period");
    R.w("f2.txt", "2\n"); await pass(L);
    a2.status = "idle"; await tick(L); await pass(L);
    assert.equal(capState(R).tree, null);
    // At the same time.
    a1.status = "working"; await tick(L);
    const tree = capState(R).tree;
    a2.status = "working"; await tick(L);
    assert.equal(snaps(L.since()), 1, "the second agent doesn't snapshot again");
    R.w("f3.txt", "3\n"); await pass(L);
    a1.status = "idle"; await tick(L); await pass(L);
    assert.equal(capState(R).tree, tree, "never cleared while either works");
    R.w("f4.txt", "4\n"); await pass(L);
    a2.status = "idle"; await tick(L); await pass(L);
    assert.equal(capState(R).tree, null);
    // B drops the repo while A's agent works.
    a1.status = "working"; await tick(L);
    const tree2 = capState(R).tree;
    await removeFolder(sB, R.dir);
    await relook(L);
    const lines = L.since();
    assert.ok(!lines.some((l) => l.startsWith("stopped capturing")), "A's record stays");
    assert.equal(capState(R).tree, tree2, "not cleared");
    assert.deepEqual(L.groups.get("sB").keys, [], "sB no longer has the repo");
    R.w("f5.txt", "5\n"); await pass(L);
    assert.deepEqual(entries(R), {
      "f1.txt": e("t1", "sA", "main", true), "f2.txt": e("t2", "sB", "main", true), "f3.txt": e(null, null, "main", true),
      "f4.txt": e("t2", "sB", "main", true), "f5.txt": e("t1", "sA", "main", true),
    });
    ok(["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"]);
  });

  // S6: one repo reached by two spellings (a symlink, a trailing slash) from two spaces.
  await scenario("S6", async () => {
    const R = repo(), ok = guard(R), link = join(folder(), "link");
    symlinkSync(R.dir, link);
    const sA = space("sA", folder()), sB = space("sB", folder()), sC = space("sC", folder());
    agent("t1", sA, R.dir, "working"); agent("t2", sB, link); agent("t3", sC, `${R.dir}/`);
    const L = newLoop();
    await tick(L);
    assert.equal(L.captures.size, 1, "one record");
    const lines = L.since();
    assert.equal(lines.filter((l) => l.includes(": capturing ")).length, 1);
    assert.equal(snaps(lines), 1);
    assert.deepEqual([...L.captures.values()][0].spaces.sort(), ["sA", "sB", "sC"]);
    R.w("x.txt", "x\n"); await pass(L);
    assert.deepEqual(entries(R), { "x.txt": e("t1", "sA", "main", true) });
    ok(["x.txt"]);
  });

  // S7: a space with a repo and no agent: nothing opened. An agent appears: a record, and a snapshot at its first turn.
  await scenario("S7", async () => {
    const R = repo(), ok = guard(R), T = folder(), sp = space("s1", T);
    writeFileSync(join(T, "t.code-workspace"), JSON.stringify({ folders: [{ path: R.dir }] }));
    const L = newLoop(), calls = execCalls.length;
    for (let i = 0; i < 4; i++) await pass(L);
    assert.equal(L.captures.size, 0);
    assert.ok(!execCalls.slice(calls).some((c) => c.cwd?.startsWith(R.dir)), "no git call in the repo");
    assert.equal(existsSync(join(R.gitDir, "wingman")), false);
    const a = agent("t1", sp, T);
    await tick(L);
    assert.equal(L.captures.size, 1);
    assert.equal(snaps(L.since()), 0);
    a.status = "working"; await tick(L);
    assert.equal(snaps(L.since()), 1);
    R.w("a.txt", "agent\n"); await pass(L);
    assert.deepEqual(entries(R), { "a.txt": e("t1", "s1") });
    ok(["a.txt"]);
  });

  // S8: a space deleted mid-turn; a repo folder deleted mid-turn.
  await scenario("S8", async () => {
    const R1 = repo(), R2 = repo(), R3 = repo(), ok1 = guard(R1), ok2 = guard(R2);
    const sA = space("sA", folder()), sB = space("sB", folder());
    const a1 = agent("t1", sA, R1.dir, "working"), a2 = agent("t2", sB, R2.dir, "working"), L = newLoop();
    await addFolder(sA, R3.dir, [R1.dir]);
    await tick(L);
    assert.equal(L.captures.size, 3);
    R2.w("a.txt", "edit before the space goes\n");
    // Space B goes, with its agent.
    world.spaces = world.spaces.filter((s) => s !== sB); dropAgent(a2);
    await tick(L);
    has(L.since(), `stopped capturing ${R2.dir}`);
    assert.equal(L.captures.size, 2);
    assert.equal(capState(R2).tree, null, "no saved snapshot left behind");
    assert.deepEqual(entries(R2), { "a.txt": e("t2", "sB") }, "the last pass took the edit made before");
    // R3's folder is deleted while the turn goes on.
    rmSync(R3.dir, { recursive: true, force: true });
    const r3 = [...L.captures.values()].find((c) => c.capture.store.root === R3.dir);
    R1.w("a.txt", "r1\n");
    await pass(L);
    has(L.since(), `${R3.dir}: capture failing`);
    assert.deepEqual(entries(R1), { "a.txt": e("t1", "sA") }, "other repos keep passing");
    for (let i = 0; i < 10; i++) await pass(L);
    assert.ok(r3.fail.count >= 2 && r3.fail.count < 8, `retried with backoff (${r3.fail.count})`);
    L.publishCaptureErrors();
    assert.deepEqual(Object.values(world.shared.get(CAPTURE_ERRORS).repos).map((x) => x.root), [R3.dir]);
    await removeFolder(sA, R3.dir);
    await relook(L); await pass(L);
    has(L.since(), `stopped capturing ${R3.dir}`);
    assert.equal(L.captures.size, 1);
    L.publishCaptureErrors();
    assert.deepEqual(world.shared.get(CAPTURE_ERRORS).repos, {});
    a1.status = "idle"; await tick(L); await pass(L);
    assert.equal(capState(R1).tree, null);
    ok1(["a.txt"]); ok2(["a.txt"]);
  });

  // S9: a branch switch with a capture running (W2: entries belong to the branch they were made on).
  await scenario("S9", async () => {
    const R = repo();
    R.git("checkout", "-qb", "feat"); R.w("b.txt", "b on feat\n"); R.w("feat-only.txt", "f\n"); R.commit("feat"); R.git("checkout", "-q", "main");
    const ok2 = guard(R), sp = space("s1", folder()), a = agent("t1", sp, R.dir, "working"), L = newLoop();
    await tick(L);
    R.w("a.txt", "agent on main\n"); await pass(L);
    assert.deepEqual(entries(R), { "a.txt": e("t1", "s1") });
    // Someone switches to feat (a.txt's change comes along), the agent edits c.txt there.
    R.git("checkout", "-q", "feat");
    await pass(L);
    R.w("c.txt", "agent on feat\n"); await pass(L);
    const onFeat = Object.entries(index(R).files).filter(([, x]) => shows(x, "feat", "s1")).map(([p]) => p).sort();
    const idx = index(R);
    assert.deepEqual(onFeat, ["c.txt"], `on feat only the edit made on feat shows (files: ${JSON.stringify(entries(R))}, parked: ${Object.keys(idx.parked ?? {})})`);
    assert.deepEqual(Object.keys(idx.parked ?? {}), ["main|a.txt"]);
    // Back on main: a.txt's entry comes back, c.txt's is set aside.
    R.git("checkout", "-q", "main");
    await pass(L); await pass(L);
    const onMain = Object.entries(index(R).files).filter(([, x]) => shows(x, "main", "s1")).map(([p]) => p).sort();
    assert.deepEqual(onMain, ["a.txt"]);
    a.status = "idle"; await tick(L); await pass(L);
    ok2(["a.txt", "c.txt"], { idx: false }); // the test's own checkouts rewrite the index
  });

  // S10: two loop copies, one lease; the leader dies mid-turn, the other carries on from its snapshot.
  await scenario("S10", async () => {
    const R = repo(), ok = guard(R), sp = space("s1", folder()), a = agent("t1", sp, R.dir), L1 = newLoop("c1"), L2 = newLoop("c2");
    await tick(L1); await L2.lead(cx);
    assert.equal(L1.isLeader, true); assert.equal(L2.isLeader, false);
    assert.equal(L2.captures.size, 0, "a copy that doesn't lead captures nothing");
    a.status = "working"; await tick(L1); await L2.lead(cx); await L2.collectAll(cx);
    const tree = capState(R).tree;
    R.w("a.txt", "1\n"); await pass(L1); await L2.lead(cx); await L2.collectAll(cx);
    assert.deepEqual(entries(R), { "a.txt": e("t1", "s1") });
    // L1 dies. Edits keep coming; L2 takes over once the lease has run out.
    R.w("b.txt", "2\n");
    clock.t += 1000; await L2.lead(cx);
    assert.equal(L2.isLeader, false, "the lease still holds");
    clock.t += LEASE_MS; await L2.lead(cx);
    assert.equal(L2.isLeader, true, "taken over within the lease time");
    let lines = L2.since();
    assert.equal(snaps(lines), 0, "no new snapshot: the saved one carries on");
    assert.equal(capState(R).tree, tree);
    await L2.collectAll(cx);
    lines = L2.since();
    has(lines, "adopted 1 files");
    assert.deepEqual(entries(R), { "a.txt": e("t1", "s1"), "b.txt": e("t1", "s1") });
    assert.equal(readdirSync(join(R.gitDir, "wingman", "baselines")).length, 2, "no double adoption");
    a.status = "idle"; await tick(L2); await pass(L2);
    assert.equal(capState(R).tree, null);
    ok(["a.txt", "b.txt"]);
  });

  // S11: a linked worktree and its main clone, both in one space: two records.
  await scenario("S11", async () => {
    const R = repo(), W = join(folder(), "wt");
    R.git("worktree", "add", "-q", "-b", "wt", W);
    const okR = guard(R), sp = space("s1", folder()), L = newLoop();
    agent("t1", sp, R.dir, "working"); agent("t2", sp, W);
    await tick(L);
    assert.equal(L.captures.size, 2, "two records");
    assert.equal(snaps(L.since()), 2);
    writeFileSync(join(W, "a.txt"), "in the worktree\n"); R.w("b.txt", "in the clone\n");
    await pass(L);
    const wtGit = join(R.gitDir, "worktrees", "wt");
    assert.deepEqual(entries(R), { "b.txt": e("t1", "s1") }, "t1 is the space's only working agent: credited in both");
    assert.deepEqual(entries(R, wtGit), { "a.txt": e("t1", "s1", "wt") });
    okR(["b.txt"]);
  });
} finally {
  console.log(results.join("\n"));
  cleanup();
}
