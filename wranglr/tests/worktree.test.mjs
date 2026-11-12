// addWorktree against real temporary repos: which commit and upstream a new worktree's branch gets.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reset } from "herdr";
import { addWorktree } from "../mods/wranglr/worktree.js";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const commit = (cwd, msg) => { git(cwd, "commit", "-q", "--allow-empty", "-m", msg); return git(cwd, "rev-parse", "HEAD"); };
const upstream = (cwd) => { try { return git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"); } catch { return null; } };

let tmp, origin, clone, n = 0;
const wt = () => join(tmp, `wt${++n}`);
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wranglr-wt-")));
  origin = join(tmp, "origin.git"); clone = join(tmp, "clone");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "clone", "-q", origin, clone);
  git(clone, "checkout", "-q", "-b", "main");
  commit(clone, "one");
  git(clone, "push", "-q", "origin", "main");
  git(clone, "remote", "set-head", "origin", "main");
});
after(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => reset());

test("a branch that exists locally is checked out as it is", async () => {
  git(clone, "branch", "local-one");
  const path = wt();
  assert.deepEqual(await addWorktree({ main: clone, branch: "local-one", path, from: "origin/main" }), { ok: true });
  assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), "local-one");
});

test("a branch that is only on the remote is tracked, with the remote's commits", async () => {
  const other = join(tmp, "other");
  git(tmp, "clone", "-q", origin, other);
  git(other, "checkout", "-q", "-b", "remote-one");
  const tip = commit(other, "remote work");
  git(other, "push", "-q", "origin", "remote-one");
  const path = wt();
  assert.deepEqual(await addWorktree({ main: clone, branch: "remote-one", path, from: null }), { ok: true });
  assert.equal(git(path, "rev-parse", "HEAD"), tip);
  assert.equal(upstream(path), "origin/remote-one");
});

test("a new branch starts from the Repo's from ref, fetched first, and tracks nothing", async () => {
  const other = join(tmp, "other2");
  git(tmp, "clone", "-q", origin, other);
  git(other, "checkout", "-q", "-b", "staging");
  const tip = commit(other, "staging work");
  git(other, "push", "-q", "origin", "staging");
  const path = wt();
  assert.deepEqual(await addWorktree({ main: clone, branch: "new-from-staging", path, from: "origin/staging" }), { ok: true });
  assert.equal(git(path, "rev-parse", "HEAD"), tip, "the clone had not fetched staging before");
  assert.equal(upstream(path), null);
});

test("a new branch with no from starts from the remote's default branch, not the checked-out one", async () => {
  git(clone, "checkout", "-q", "-b", "side");
  commit(clone, "side work");
  const path = wt();
  assert.deepEqual(await addWorktree({ main: clone, branch: "new-default", path, from: null }), { ok: true });
  assert.equal(git(path, "rev-parse", "HEAD"), git(clone, "rev-parse", "origin/main"));
  git(clone, "checkout", "-q", "main");
});

test("a from that is a local branch is used with no fetch", async () => {
  const tip = git(clone, "rev-parse", "side");
  const path = wt();
  assert.deepEqual(await addWorktree({ main: clone, branch: "new-from-local", path, from: "side" }), { ok: true });
  assert.equal(git(path, "rev-parse", "HEAD"), tip);
});

test("a Repo with no remote starts a new branch from main", async () => {
  const solo = join(tmp, "solo");
  git(tmp, "init", "-q", "-b", "main", solo);
  const tip = commit(solo, "one");
  git(solo, "checkout", "-q", "-b", "elsewhere");
  commit(solo, "two");
  const path = wt();
  assert.deepEqual(await addWorktree({ main: solo, branch: "new-solo", path, from: null }), { ok: true });
  assert.equal(git(path, "rev-parse", "HEAD"), tip);
});

test("a from on a remote that cannot be fetched warns and uses the local copy", async () => {
  const lone = join(tmp, "lone");
  git(tmp, "clone", "-q", origin, lone);
  git(lone, "remote", "set-url", "origin", join(tmp, "gone.git"));
  const path = wt();
  const r = await addWorktree({ main: lone, branch: "new-offline", path, from: "origin/main" });
  assert.equal(r.ok, true);
  assert.match(r.warning, /Could not fetch origin\/main/);
  assert.equal(git(path, "rev-parse", "HEAD"), git(lone, "rev-parse", "origin/main"));
});

test("a path that is taken fails with git's own message", async () => {
  const r = await addWorktree({ main: clone, branch: "new-clash", path: clone, from: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /already exists/);
});
