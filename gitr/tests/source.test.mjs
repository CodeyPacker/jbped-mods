// source: which Source applies, and what each one sends to Herdr.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { reset, world, runCalls, overlays, sharedCalls } from "herdr";
import { join } from "node:path";
import { makeSource } from "../mods/gitr/source.js";
import { g, commit, tmpDir, repo } from "./gitutil.mjs";

beforeEach(() => reset());

const block = (mod, extra = {}) => ({ type: "leaf", content: { mod }, ...extra });
const treeWith = (mod, extra) => ({ type: "column", children: [block("spaces"), { type: "row", children: [block("x"), block(mod, extra)] }] });
const REPOS = [{ identity: "github.com/o/r", name: "r", on: { "": "/dev/r" } }];

test("kind is wranglr with a wranglr block and repos in the shared view", () => {
  world.layout = treeWith("wranglr");
  world.shared["wranglr.view"] = { repos: REPOS };
  assert.equal(makeSource().kind(), "wranglr");
});

test("a hidden wranglr block still counts", () => {
  world.layout = treeWith("wranglr", { hidden: true });
  world.shared["wranglr.view"] = { repos: [] };
  assert.equal(makeSource().kind(), "wranglr");
});

test("kind is standalone without a wranglr block, even with a leftover shared view", () => {
  world.layout = treeWith("other");
  world.shared["wranglr.view"] = { repos: REPOS };
  assert.equal(makeSource().kind(), "standalone");
});

test("kind is standalone with a block but no repos in the shared view", () => {
  world.layout = treeWith("wranglr");
  assert.equal(makeSource().kind(), "standalone");
  world.shared["wranglr.view"] = { plus: "worktree" };
  assert.equal(makeSource().kind(), "standalone");
  world.shared["wranglr.view"] = { repos: "no" };
  assert.equal(makeSource().kind(), "standalone");
});

test("kind is standalone with no layout, and is read fresh on each call", () => {
  const s = makeSource();
  assert.equal(s.kind(), "standalone");
  world.layout = treeWith("wranglr");
  world.shared["wranglr.view"] = { repos: REPOS };
  assert.equal(s.kind(), "wranglr");
  world.layout = null;
  assert.equal(s.kind(), "standalone");
});

test("wranglr: repos come from the shared view and enter follows its plus setting", async () => {
  world.layout = treeWith("wranglr");
  world.shared["wranglr.view"] = { repos: REPOS, plus: "worktree" };
  const s = makeSource();
  assert.deepEqual(await s.repos(), REPOS);
  assert.equal(s.enter({ enter: "checkout" }), "worktree");
  world.shared["wranglr.view"] = { repos: REPOS, plus: "main" };
  assert.equal(s.enter({ enter: "worktree" }), "checkout");
  world.shared["wranglr.view"] = { repos: REPOS };
  assert.equal(s.enter({ enter: "worktree" }), "checkout");
});

test("wranglr: startSpace and makeWorktree send actions with a counter that counts up", async () => {
  world.layout = treeWith("wranglr");
  world.shared["wranglr.view"] = { repos: REPOS };
  const s = makeSource();
  await s.startSpace({ repo: { identity: "github.com/o/r", name: "r" }, machine: "box", dir: "/dev/r" });
  await s.makeWorktree({ repo: "github.com/o/r", machine: null, main: "/dev/r", branch: "feat" });
  assert.deepEqual(sharedCalls, [
    { key: "wranglr.action", value: { n: 1, action: { type: "start", repo: "github.com/o/r", machine: "box", folder: "/dev/r" } } },
    { key: "wranglr.action", value: { n: 2, action: { type: "plus", group: "repo:github.com/o/r", sub: null, mode: "worktree", machine: null, branch: "feat" } } },
  ]);
  assert.equal(runCalls.length, 0);
  assert.equal(overlays.length, 0);
});

test("wranglr: the counter continues from Wranglr's own value", async () => {
  world.layout = treeWith("wranglr");
  world.shared["wranglr.view"] = { repos: REPOS };
  world.shared["wranglr.action"] = { n: 41, action: { type: "other" } };
  await makeSource().startSpace({ repo: "r", machine: null, dir: "/d" });
  assert.equal(sharedCalls[0].value.n, 42);
});

test("standalone: enter is the setting, defaulting to worktree", () => {
  const s = makeSource();
  assert.equal(s.enter({ enter: "checkout" }), "checkout");
  assert.equal(s.enter({ enter: "worktree" }), "worktree");
  assert.equal(s.enter({}), "worktree");
  assert.equal(s.enter(undefined), "worktree");
});

test("standalone: startSpace runs space.new with the Machine and what the setting runs", async () => {
  const s = makeSource({ settings: () => ({ run: ["pwsh", "-NoLogo"] }) });
  await s.startSpace({ repo: "r", machine: null, dir: "/d" });
  await s.startSpace({ repo: "r", machine: "box", dir: "/e" });
  assert.deepEqual(runCalls, [
    { name: "space.new", args: { folder: "/d", machine: "", argv: ["pwsh", "-NoLogo"] } },
    { name: "space.new", args: { folder: "/e", machine: "box", argv: ["pwsh", "-NoLogo"] } },
  ]);
});

test("standalone: with no run setting no argv is sent", async () => {
  await makeSource({ settings: { run: null } }).startSpace({ repo: "r", machine: null, dir: "/d" });
  assert.deepEqual(runCalls[0].args, { folder: "/d", machine: "" });
});

test("standalone: makeWorktree opens the shipped worktree dialog with the Main checkout, Machine and Branch", async () => {
  await makeSource().makeWorktree({ repo: "r", machine: "box", main: "/dev/r", branch: "feat/x" });
  assert.deepEqual(overlays, [{ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { folder: "/dev/r", machine: "box", branch: "feat/x" } }]);
  overlays.length = 0;
  await makeSource({ settings: { run: ["sh"] } }).makeWorktree({ repo: "r", machine: null, main: "/dev/r", branch: "b" });
  assert.deepEqual(overlays[0].props, { folder: "/dev/r", machine: null, branch: "b", argv: ["sh"] });
  assert.equal(sharedCalls.length, 0);
});

test("standalone: repos merges the spaces of one Repo by identity, with its Main checkout per Machine", async () => {
  const dir = tmpDir();
  const main = repo(join(dir, "main"));
  const other = repo();
  g(main, "remote", "add", "origin", "git@github.com:Org/Proj.git");
  g(main, "worktree", "add", "-q", "-b", "feat", join(dir, "wt"));
  g(other, "remote", "add", "origin", "https://example.com/else/where.git");
  world.spaces = [
    { id: "s1", name: "a", folder: "", machine: null, tabs: [{ id: "t1" }] },
    { id: "s2", name: "b", folder: "", machine: null, tabs: [{ id: "t2" }] },
    { id: "s3", name: "c", folder: other, machine: null, tabs: [{ id: "t3" }] },
    { id: "s4", name: "d", folder: "", machine: null, tabs: [{ id: "t4" }] },
    { id: "s5", name: "e", folder: "/nowhere/at/all", machine: null, tabs: [] },
  ];
  world.panes = [
    { pane: "p1", terminal: "x1", tab: "t1", cwd: main },
    { pane: "p2", terminal: "x2", tab: "t2", cwd: join(dir, "wt") },
    { pane: "p3", terminal: "x3", tab: "t3", cwd: null },
    { pane: "p4", terminal: null, mod: "m", tab: "t4", cwd: main },
  ];
  const r = await makeSource().repos();
  assert.deepEqual(r, [
    { identity: "github.com/Org/Proj", name: "Proj", on: { "": main } },
    { identity: "example.com/else/where", name: "where", on: { "": other } },
  ]);
});

test("standalone: the same Repo on two Machines is one entry with two paths", async () => {
  const main = repo();
  g(main, "remote", "add", "origin", "git@github.com:Org/Proj.git");
  world.spaces = [
    { id: "s1", name: "a", folder: main, machine: null, tabs: [] },
    { id: "s2", name: "b", folder: main, machine: "box", tabs: [] }, // the shim runs "on" a machine here
  ];
  const r = await makeSource().repos();
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].on, { "": main, box: main });
});

test("standalone: no spaces gives no Repos", async () => {
  assert.deepEqual(await makeSource().repos(), []);
});
