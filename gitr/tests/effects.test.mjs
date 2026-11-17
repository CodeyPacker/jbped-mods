// effects against real temporary repos and a stand-in Source.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { reset, runCalls, notes, closes, execCalls } from "herdr";
import { runEffects, checkoutEffect } from "../mods/gitr/effects.js";
import { g, commit, commitFile, write, tmpDir, repo } from "./gitutil.mjs";

beforeEach(() => reset());

// A Main checkout on main with a.txt committed, plus a Source and callbacks that record.
function setup(extra = {}) {
  const main = repo();
  commitFile(main, "a.txt", "base\n");
  const calls = { worktree: [], start: [], set: [], refresh: 0 };
  const source = {
    makeWorktree: async (a) => { calls.worktree.push(a); },
    startSpace: async (a) => { calls.start.push(a); },
  };
  const ctx = {
    main, machine: null, repo: { identity: "r", name: "r" }, source, settings: {}, overlay: "ov1",
    onSet: (k, v) => calls.set.push([k, v]), onRefresh: () => { calls.refresh++; },
    ...extra,
  };
  return { main, ctx, calls };
}
const branch = (main) => g(main, "symbolic-ref", "--short", "HEAD");
const stashes = (main) => g(main, "stash", "list", "--format=%gs").split("\n").filter(Boolean);

test("a git effect runs in the Main checkout and succeeds", async () => {
  const { main, ctx } = setup();
  const r = await runEffects([{ type: "git", args: ["branch", "x"] }], ctx);
  assert.deepEqual(r, { ok: true, toasts: [] });
  assert.equal(g(main, "branch", "--list", "x"), "x");
  assert.equal(execCalls.at(-1).cwd, main);
});

test("a git effect runs in its own cwd and on the Machine", async () => {
  const { main, ctx } = setup({ machine: "box" });
  const other = tmpDir();
  repo(other);
  const r = await runEffects([{ type: "git", args: ["branch", "y"], cwd: other, timeout: 5000 }], ctx);
  assert.equal(r.ok, true);
  assert.equal(g(other, "branch", "--list", "y"), "y");
  assert.equal(execCalls.at(-1).on, "box");
  assert.equal(execCalls.at(-1).timeout, 5000);
});

test("a failing git effect reports git's message and stops the list", async () => {
  const { main, ctx } = setup();
  const r = await runEffects([
    { type: "git", args: ["checkout", "nope", "--"] },
    { type: "toast", level: "info", title: "after" },
  ], ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /nope/);
  assert.equal(notes.length, 0);
  assert.deepEqual(r.toasts, []);
});

test("a git effect with refuse hands the action back with git's message", async () => {
  const { main, ctx, calls } = setup();
  g(main, "checkout", "-q", "-b", "wip");
  commitFile(main, "b.txt", "b\n");
  g(main, "checkout", "-q", "main");
  const refuse = { type: "delete", row: "b:wip", force: true };
  const r = await runEffects([{ type: "git", args: ["branch", "-d", "wip"], refuse }, { type: "refresh" }], ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.next, refuse);
  assert.match(r.said, /not fully merged/);
  assert.equal(r.error, undefined);
  assert.equal(calls.refresh, 0);
  assert.equal(g(main, "branch", "--list", "wip").trim(), "wip");
  // The forced delete the view then asks for works.
  assert.equal((await runEffects([{ type: "git", args: ["branch", "-D", "wip"] }], ctx)).ok, true);
});

test("a merged Branch is deleted by -d", async () => {
  const { main, ctx } = setup();
  g(main, "branch", "merged");
  const r = await runEffects([{ type: "git", args: ["branch", "-d", "merged"], refuse: { type: "delete" } }], ctx);
  assert.equal(r.ok, true);
  assert.equal(g(main, "branch", "--list", "merged"), "");
});

test("checkout without stash switches the Branch", async () => {
  const { main, ctx } = setup();
  g(main, "branch", "other");
  const r = await runEffects([{ type: "checkout", branch: "other", stash: false }], ctx);
  assert.equal(r.ok, true);
  assert.equal(branch(main), "other");
  assert.deepEqual(stashes(main), []);
});

test("checkout without stash fails with git's message when changes would be lost", async () => {
  const { main, ctx } = setup();
  g(main, "checkout", "-q", "-b", "other");
  commitFile(main, "a.txt", "other\n");
  g(main, "checkout", "-q", "main");
  write(main, "a.txt", "mine\n");
  const r = await runEffects([{ type: "checkout", branch: "other", stash: false }], ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /overwritten|local changes/i);
  assert.equal(branch(main), "main");
});

// A branch `other` that adds b.txt, so a stashed edit of a.txt reapplies cleanly.
function withOther(main) {
  g(main, "checkout", "-q", "-b", "other");
  commitFile(main, "b.txt", "b\n");
  g(main, "checkout", "-q", "main");
}

test("checkout with stash: a clean reapply keeps the changes and drops the entry", async () => {
  const { main, ctx } = setup();
  withOther(main);
  write(main, "a.txt", "mine\n");
  const r = await runEffects([{ type: "checkout", branch: "other", stash: true }], ctx);
  assert.deepEqual(r, { ok: true, toasts: [] });
  assert.equal(branch(main), "other");
  assert.equal(readFileSync(join(main, "a.txt"), "utf8"), "mine\n");
  assert.deepEqual(stashes(main), []);
});

test("checkout with stash: the entry message names the time, the from Branch and the Branch", async () => {
  const { main, ctx } = setup({ now: Date.UTC(2026, 10, 17, 12, 0, 0) });
  withOther(main);
  write(main, "a.txt", "mine\n");
  let seen = null;
  await checkoutEffect({ branch: "other", stash: true }, ctx, async (step) => { if (step === "push") seen = stashes(main)[0]; });
  assert.match(seen, /gitr 2026-11-17T12:00:00\.000Z main to other$/);
});

test("checkout with stash: a conflicting reapply keeps the entry and warns", async () => {
  const { main, ctx } = setup();
  g(main, "checkout", "-q", "-b", "other");
  commitFile(main, "a.txt", "other\n");
  g(main, "checkout", "-q", "main");
  write(main, "a.txt", "mine\n");
  const r = await runEffects([{ type: "checkout", branch: "other", stash: true }, { type: "toast", level: "info", title: "next" }], ctx);
  assert.equal(r.ok, true);
  assert.equal(branch(main), "other");
  assert.equal(stashes(main).length, 1);
  assert.match(stashes(main)[0], /gitr .* main to other$/);
  assert.equal(r.toasts[0].level, "warning");
  assert.match(r.toasts[0].body, /gitr .* main to other/);
  // The list went on.
  assert.equal(r.toasts[1].title, "next");
  assert.equal(notes[0].level, "warning");
});

test("checkout with stash: nothing to stash leaves no entry and no toast", async () => {
  const { main, ctx } = setup();
  withOther(main);
  const r = await runEffects([{ type: "checkout", branch: "other", stash: true }], ctx);
  assert.deepEqual(r, { ok: true, toasts: [] });
  assert.equal(branch(main), "other");
  assert.deepEqual(stashes(main), []);
});

test("checkout with stash: untracked files are not stashed", async () => {
  const { main, ctx } = setup();
  withOther(main);
  write(main, "new.txt", "u\n");
  const r = await runEffects([{ type: "checkout", branch: "other", stash: true }], ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(stashes(main), []);
  assert.equal(existsSync(join(main, "new.txt")), true);
});

test("checkout with stash: an entry pushed between the steps is left untouched", async () => {
  const { main, ctx } = setup();
  withOther(main);
  const wt = join(tmpDir(), "wt");
  g(main, "worktree", "add", "-q", "-b", "side", wt);
  write(main, "a.txt", "mine\n");
  let pushedOther = false;
  ctx.tap = async (step) => {
    // Another Worktree stashes onto the shared stack after Gitr's entry was found.
    if (step === "find" && !pushedOther) {
      pushedOther = true;
      write(wt, "a.txt", "side\n");
      g(wt, "stash", "push", "-m", "somebody else");
    }
  };
  const r = await runEffects([{ type: "checkout", branch: "other", stash: true }], ctx);
  assert.equal(pushedOther, true);
  assert.deepEqual(r, { ok: true, toasts: [] });
  assert.equal(readFileSync(join(main, "a.txt"), "utf8"), "mine\n");
  // Only the other entry remains, and it is the same one.
  assert.deepEqual(stashes(main), ["On side: somebody else"]);
});

test("checkout with stash: an entry pushed on top while checking out is not dropped by position", async () => {
  const { main, ctx } = setup();
  withOther(main);
  const wt = join(tmpDir(), "wt2");
  g(main, "worktree", "add", "-q", "-b", "side2", wt);
  write(main, "a.txt", "mine\n");
  ctx.tap = async (step) => { if (step === "checkout") { write(wt, "a.txt", "s\n"); g(wt, "stash", "push", "-m", "late"); } };
  const r = await runEffects([{ type: "checkout", branch: "other", stash: true }], ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(stashes(main), ["On side2: late"]);
});

test("checkout with stash: a failed checkout reapplies the entry and fails with git's message", async () => {
  const { main, ctx } = setup();
  write(main, "a.txt", "mine\n");
  const r = await runEffects([{ type: "checkout", branch: "nope", stash: true }], ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /nope/);
  assert.equal(branch(main), "main");
  assert.equal(readFileSync(join(main, "a.txt"), "utf8"), "mine\n");
  assert.deepEqual(stashes(main), []);
});

test("fetch effect: a remote ref is fetched, a failure warns and the list goes on, a local ref is skipped", async () => {
  const { main, ctx } = setup();
  const origin = join(tmpDir(), "o.git");
  mkdirSync(origin);
  g(origin, "init", "-q", "--bare", "-b", "main");
  g(main, "remote", "add", "origin", origin);
  g(main, "push", "-q", "origin", "main");
  const ok = await runEffects([{ type: "fetch", ref: "origin/main" }], ctx);
  assert.deepEqual(ok, { ok: true, toasts: [] });
  assert.deepEqual(execCalls.at(-1).args, ["fetch", "--quiet", "origin", "main"]);
  const bad = await runEffects([{ type: "fetch", ref: "origin/missing" }, { type: "toast", level: "info", title: "next" }], ctx);
  assert.equal(bad.ok, true);
  assert.equal(bad.toasts[0].level, "warning");
  assert.match(bad.toasts[0].title, /origin\/missing/);
  assert.equal(bad.toasts[1].title, "next");
  const n = execCalls.length;
  await runEffects([{ type: "fetch", ref: "main" }], ctx);
  assert.equal(execCalls.length, n);
});

test("Worktree remove refuses with changes, and works with --force", async () => {
  const { main, ctx } = setup();
  const wt = join(tmpDir(), "wt");
  g(main, "worktree", "add", "-q", "-b", "feat", wt);
  write(wt, "dirty.txt");
  const refused = await runEffects([{ type: "git", args: ["worktree", "remove", wt] }], ctx);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /modified or untracked|--force/);
  assert.equal(existsSync(wt), true);
  const forced = await runEffects([{ type: "git", args: ["worktree", "remove", "--force", wt] }], ctx);
  assert.equal(forced.ok, true);
  assert.equal(existsSync(wt), false);
});

test("Worktree remove without changes works without --force", async () => {
  const { main, ctx } = setup();
  const wt = join(tmpDir(), "wt");
  g(main, "worktree", "add", "-q", "-b", "feat", wt);
  assert.equal((await runEffects([{ type: "git", args: ["worktree", "remove", wt] }], ctx)).ok, true);
  assert.equal(existsSync(wt), false);
});

test("A remove that fails after git dropped the Worktree warns and the list goes on", async () => {
  const { main, ctx } = setup();
  // git fails on a path it no longer lists, as it does when it could not delete a held folder.
  const gone = join(tmpDir(), "held");
  const r = await runEffects([{ type: "git", args: ["worktree", "remove", gone] }, { type: "toast", level: "info", title: "next" }], ctx);
  assert.equal(r.ok, true);
  assert.equal(r.toasts[0].level, "warning");
  assert.match(r.toasts[0].title, /folder left behind/);
  assert.equal(r.toasts[1].title, "next");
});

test("worktree and space.start go to the Source with the Repo and Machine", async () => {
  const { main, ctx, calls } = setup({ machine: "box" });
  const r = await runEffects([{ type: "worktree", branch: "feat" }, { type: "space.start", dir: "/x/y" }], ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.worktree, [{ repo: ctx.repo, machine: "box", main, branch: "feat" }]);
  assert.deepEqual(calls.start, [{ repo: ctx.repo, machine: "box", dir: "/x/y" }]);
});

test("space.select, space.close, close, set, refresh and toast call the right things", async () => {
  const { ctx, calls } = setup();
  const r = await runEffects([
    { type: "space.select", id: "s1" },
    { type: "space.close", id: "s2" },
    { type: "set", key: "sort", value: "az" },
    { type: "refresh" },
    { type: "toast", level: "error", title: "T", body: "B" },
    { type: "close" },
  ], ctx);
  assert.deepEqual(runCalls, [
    { name: "space.select", args: { id: "s1" } },
    { name: "space.close", args: { id: "s2", confirmed: true } },
  ]);
  assert.deepEqual(calls.set, [["sort", "az"]]);
  assert.equal(calls.refresh, 1);
  assert.deepEqual(notes, [{ title: "T", body: "B", level: "error" }]);
  assert.deepEqual(r, { ok: true, toasts: [{ level: "error", title: "T", body: "B" }] });
  assert.deepEqual(closes, ["ov1"]);
});

test("the list stops at the first failure and later effects do not run", async () => {
  const { main, ctx, calls } = setup();
  const r = await runEffects([
    { type: "space.select", id: "s1" },
    { type: "git", args: ["checkout", "nope", "--"] },
    { type: "worktree", branch: "feat" },
    { type: "close" },
    { type: "refresh" },
  ], ctx);
  assert.equal(r.ok, false);
  assert.equal(runCalls.length, 1);
  assert.equal(calls.worktree.length, 0);
  assert.equal(closes.length, 0);
  assert.equal(calls.refresh, 0);
});

test("runEffects never throws: a Source that throws, an unknown effect, a missing list", async () => {
  const { ctx } = setup();
  ctx.source.makeWorktree = async () => { throw new Error("worktree dialog unavailable"); };
  assert.deepEqual(await runEffects([{ type: "worktree", branch: "b" }], ctx), { ok: false, error: "worktree dialog unavailable", toasts: [] });
  assert.equal((await runEffects([{ type: "bogus" }], ctx)).ok, false);
  assert.deepEqual(await runEffects(undefined, ctx), { ok: true, toasts: [] });
  ctx.main = join(tmpDir(), "missing-dir");
  const r = await runEffects([{ type: "git", args: ["status"] }], ctx);
  assert.equal(r.ok, false);
});
