// gitread: parse fixtures, and readRepo against real temporary repos.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { reset, execCalls } from "herdr";
import { parseWorktrees, parseRefs, readRepo, REF_FORMAT } from "../mods/gitr/gitread.js";
import { g, commit, commitFile, write, tmpDir, repo } from "./gitutil.mjs";

beforeEach(() => reset());

test("parseWorktrees reads main, branch, detached, locked and prunable entries", () => {
  const text = [
    "worktree C:/dev/app", "HEAD aaa", "branch refs/heads/main", "",
    "worktree C:/dev/app/.worktrees/x/", "HEAD bbb", "branch refs/heads/feat/x", "locked wip", "",
    "worktree /tmp/d", "HEAD ccc", "detached", "",
    "worktree /tmp/gone", "HEAD ddd", "branch refs/heads/old", "prunable gitdir file points to non-existent location", "",
  ].join("\n");
  assert.deepEqual(parseWorktrees(text), [
    { path: "C:/dev/app", head: "aaa", branch: "main", detached: false, prunable: false, locked: false, bare: false },
    { path: "C:/dev/app/.worktrees/x", head: "bbb", branch: "feat/x", detached: false, prunable: false, locked: true, bare: false },
    { path: "/tmp/d", head: "ccc", branch: null, detached: true, prunable: false, locked: false, bare: false },
    { path: "/tmp/gone", head: "ddd", branch: "old", detached: false, prunable: true, locked: false, bare: false },
  ]);
});

test("parseWorktrees keeps bare entries marked and handles CRLF and empty text", () => {
  const r = parseWorktrees("worktree /r.git\r\nbare\r\n\r\nworktree /w\r\nHEAD a\r\nbranch refs/heads/m\r\n");
  assert.equal(r[0].bare, true);
  assert.equal(r[1].branch, "m");
  assert.deepEqual(parseWorktrees(""), []);
});

test("parseRefs reads branches, tracking counts, gone upstreams and remotes", () => {
  const line = (...f) => f.join("\0");
  const text = [
    line("refs/heads/main", "s1", "origin/main", "[ahead 2, behind 1]", "1700000000"),
    line("refs/heads/a", "s2", "origin/a", "", "1700000100"),
    line("refs/heads/b", "s3", "origin/b", "[gone]", "1700000200"),
    line("refs/heads/c", "s4", "", "", "1700000300"),
    line("refs/heads/d", "s5", "origin/d", "[behind 4]", "1700000400"),
    line("refs/remotes/origin/HEAD", "s1", "", "", "1700000000"),
    line("refs/remotes/origin", "s1", "", "", "1700000000"),
    line("refs/remotes/origin/feat/x", "s6", "", "", "1700000500"),
  ].join("\n") + "\n";
  const { branches, remotes } = parseRefs(text);
  assert.deepEqual(branches.map((b) => [b.name, b.upstream, b.gone, b.ahead, b.behind, b.date]), [
    ["main", "origin/main", false, 2, 1, 1700000000],
    ["a", "origin/a", false, 0, 0, 1700000100],
    ["b", "origin/b", true, null, null, 1700000200],
    ["c", null, false, null, null, 1700000300],
    ["d", "origin/d", false, 0, 4, 1700000400],
  ]);
  assert.deepEqual(remotes, [{ name: "origin/feat/x", remote: "origin", branch: "feat/x", sha: "s6", date: 1700000500 }]);
});

// A bare origin, a clone of it as the Main checkout, with pushed main.
function setup() {
  const dir = tmpDir();
  const origin = join(dir, "origin.git"), main = join(dir, "main");
  mkdirSync(origin);
  g(origin, "init", "-q", "--bare", "-b", "main");
  g(dir, "clone", "-q", origin, main);
  g(main, "checkout", "-q", "-b", "main");
  commit(main, "one");
  g(main, "push", "-q", "-u", "origin", "main");
  g(main, "remote", "set-head", "origin", "main");
  return { dir, origin, main };
}

test("readRepo reads the Main checkout, Worktrees, Branches, remotes and the default branch", async () => {
  const { dir, main } = setup();
  g(main, "branch", "feat");
  g(main, "worktree", "add", "-q", join(dir, "wt-feat"), "feat");
  g(main, "worktree", "add", "-q", "--detach", join(dir, "wt-det"));
  g(main, "branch", "alone");
  const s = await readRepo(main, null);
  assert.equal(s.main, main);
  assert.equal(s.defaultBranch, "origin/main");
  // The Main checkout is first, then git's own order for the rest.
  assert.equal(s.checkouts[0].path, main);
  const rows = s.checkouts.map((c) => [c.path, c.main, c.branch, c.detached, c.prunable, c.changes, c.tracked]);
  rows.sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
  assert.deepEqual(rows, [
    [main, true, "main", false, false, 0, 0],
    [join(dir, "wt-det"), false, null, true, false, 0, 0],
    [join(dir, "wt-feat"), false, "feat", false, false, 0, 0],
  ]);
  assert.equal(s.checkouts[0].head, g(main, "rev-parse", "main"));
  assert.deepEqual(s.branches.map((b) => b.name).sort(), ["alone", "feat", "main"]);
  assert.deepEqual(s.remotes.map((r) => r.name), ["origin/main"]);
  assert.ok(Math.abs(s.at - Date.now()) < 60000);
});

test("a Worktree whose directory was deleted is prunable and has null counts", async () => {
  const { dir, main } = setup();
  g(main, "worktree", "add", "-q", "-b", "gone-dir", join(dir, "wt-gone"));
  rmSync(join(dir, "wt-gone"), { recursive: true, force: true });
  const s = await readRepo(main, null);
  const c = s.checkouts.find((x) => x.branch === "gone-dir");
  assert.equal(c.prunable, true);
  assert.equal(c.changes, null);
  assert.equal(c.tracked, null);
  // status never ran there.
  assert.ok(!execCalls.some((e) => e.cwd === join(dir, "wt-gone")));
});

test("a Branch whose upstream was deleted on the remote is gone after a pruning fetch", async () => {
  const { dir, origin, main } = setup();
  g(main, "checkout", "-q", "-b", "topic");
  commit(main, "t");
  g(main, "push", "-q", "-u", "origin", "topic");
  g(main, "checkout", "-q", "main");
  g(origin, "branch", "-D", "topic");
  g(main, "fetch", "-q", "--prune");
  const b = (await readRepo(main, null)).branches.find((x) => x.name === "topic");
  assert.equal(b.gone, true);
  assert.equal(b.upstream, "origin/topic");
  assert.equal(b.ahead, null);
  assert.equal(b.behind, null);
});

test("ahead and behind counts", async () => {
  const { dir, origin, main } = setup();
  commit(main, "local 1");
  commit(main, "local 2");
  const other = join(dir, "other");
  g(dir, "clone", "-q", origin, other);
  commit(other, "remote 1");
  g(other, "push", "-q", "origin", "main");
  g(main, "fetch", "-q");
  const b = (await readRepo(main, null)).branches.find((x) => x.name === "main");
  assert.equal(b.ahead, 2);
  assert.equal(b.behind, 1);
});

test("changes count tracked and untracked lines, tracked counts without ??", async () => {
  const { dir, main } = setup();
  commitFile(main, "a.txt", "1\n");
  write(main, "a.txt", "2\n");
  write(main, "new1.txt");
  write(main, "new2.txt");
  g(main, "worktree", "add", "-q", "-b", "w", join(dir, "wt-w"));
  write(join(dir, "wt-w"), "u.txt");
  const s = await readRepo(main, null);
  assert.deepEqual([s.checkouts[0].changes, s.checkouts[0].tracked], [3, 1]);
  const w = s.checkouts.find((c) => c.branch === "w");
  assert.deepEqual([w.changes, w.tracked], [1, 0]);
});

test("no remote: defaultBranch is null and remotes is empty", async () => {
  const main = repo();
  const s = await readRepo(main, null);
  assert.equal(s.defaultBranch, null);
  assert.deepEqual(s.remotes, []);
});

test("the default branch falls back to the first remote", async () => {
  const { dir, origin, main } = setup();
  g(main, "remote", "rename", "origin", "up");
  g(main, "remote", "set-head", "up", "main");
  assert.equal((await readRepo(main, null)).defaultBranch, "up/main");
});

test("a status run is at most four at a time", async () => {
  const { dir, main } = setup();
  for (let i = 0; i < 7; i++) g(main, "worktree", "add", "-q", "-b", `w${i}`, join(dir, `wt${i}`));
  let now = 0, max = 0;
  const { fake } = await import("herdr");
  fake.exec = (cmd, args) => {
    if (!args.includes("status")) return undefined;
    now++; max = Math.max(max, now);
    return new Promise((res) => setTimeout(() => { now--; res({ code: 0, stdout: "", stderr: "" }); }, 20));
  };
  const s = await readRepo(main, null);
  assert.equal(s.checkouts.length, 8);
  assert.equal(max, 4);
});

test("readRepo throws with git's message outside a repo", async () => {
  const dir = tmpDir();
  await assert.rejects(readRepo(dir, null), /not a git repository/i);
});

test("the Machine is passed to git", async () => {
  const main = repo();
  await readRepo(main, "box");
  assert.ok(execCalls.length > 0 && execCalls.every((e) => e.on === "box"));
});

test("REF_FORMAT asks for the fields parseRefs reads", () => {
  for (const f of ["refname", "objectname", "upstream:short", "upstream:track", "committerdate:unix"]) assert.ok(REF_FORMAT.includes(`%(${f})`));
});
