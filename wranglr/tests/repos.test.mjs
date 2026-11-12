import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, execCalls, reset } from "herdr";
import { identityOf, resolveRepo, makeResolver } from "../mods/wranglr/repos.js";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
let tmp;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "wranglr-repos-")));
  mkdirSync(join(tmp, "src"));
  git(join(tmp, "src"), "init", "-q");
  git(join(tmp, "src"), "commit", "-q", "--allow-empty", "-m", "x");
  git(tmp, "clone", "-q", join(tmp, "src"), "clone");
  git(join(tmp, "clone"), "remote", "set-url", "origin", "git@github.com:Org/Repo.git");
  git(join(tmp, "clone"), "worktree", "add", "-q", join(tmp, "wt"), "-b", "feature/x");
  mkdirSync(join(tmp, "clone", "deep", "er"), { recursive: true });
  mkdirSync(join(tmp, "plain"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => reset());

test("identity: ssh, https and ssh:// forms of one GitHub Repo are equal", () => {
  for (const u of ["git@github.com:Org/Repo.git", "https://github.com/Org/Repo", "ssh://git@github.com/Org/Repo.git", "https://GitHub.com/Org/Repo/", "https://user@github.com/Org/Repo.git"])
    assert.equal(identityOf(u, "/x/whatever"), "github.com/Org/Repo", u);
});

test("identity: the three Azure DevOps forms are equal", () => {
  for (const u of ["git@ssh.dev.azure.com:v3/Org/Proj/Repo", "https://dev.azure.com/Org/Proj/_git/Repo", "https://Org@dev.azure.com/Org/Proj/_git/Repo", "Org@dev.azure.com/Org/Proj/_git/Repo", "ssh://git@ssh.dev.azure.com/v3/Org/Proj/Repo"])
    assert.equal(identityOf(u, "/x"), "dev.azure.com/Org/Proj/Repo", u);
});

test("identity: a port is dropped", () => {
  assert.equal(identityOf("ssh://git@git.example.com:2222/team/app.git", "/x"), "git.example.com/team/app");
  assert.equal(identityOf("https://git.example.com:8443/team/app", "/x"), "git.example.com/team/app");
});

test("identity: no remote is the basename of the main root", () => {
  assert.equal(identityOf(null, "/home/me/code/thing/"), "thing");
  assert.equal(identityOf("", "C:\\code\\thing"), "thing");
});

test("resolveRepo: a clone with an origin", async () => {
  const r = await resolveRepo(join(tmp, "clone"), null);
  assert.deepEqual(r, { identity: "github.com/Org/Repo", name: "Repo", root: join(tmp, "clone"), main: join(tmp, "clone") });
});

test("resolveRepo: a repo with no remote is named for its folder", async () => {
  assert.deepEqual(await resolveRepo(join(tmp, "src"), null), { identity: "src", name: "src", root: join(tmp, "src"), main: join(tmp, "src") });
});

test("resolveRepo: a linked worktree has its parent's identity and main, its own root", async () => {
  assert.deepEqual(await resolveRepo(join(tmp, "wt"), null), { identity: "github.com/Org/Repo", name: "Repo", root: join(tmp, "wt"), main: join(tmp, "clone") });
});

test("resolveRepo: a subdirectory resolves to its repo", async () => {
  assert.deepEqual(await resolveRepo(join(tmp, "clone", "deep", "er"), null), { identity: "github.com/Org/Repo", name: "Repo", root: join(tmp, "clone"), main: join(tmp, "clone") });
});

test("resolveRepo: a directory in no repo, or a git that cannot start, is null", async () => {
  assert.equal(await resolveRepo(join(tmp, "plain"), null), null);
  fake.exec = () => Promise.reject(new Error("unreachable"));
  assert.equal(await resolveRepo(join(tmp, "clone"), "vps"), null);
  assert.equal(execCalls[execCalls.length - 1].on, "vps");
});

test("resolveRepo: another Machine runs git there", async () => {
  await resolveRepo(join(tmp, "clone"), "wsl");
  assert.ok(execCalls.length > 0 && execCalls.every((c) => c.cmd === "git" && c.on === "wsl" && c.cwd === join(tmp, "clone")));
});

test("resolver: repeated want runs git once", async () => {
  const r = makeResolver();
  assert.equal(r.get(join(tmp, "clone"), null), undefined);
  const [a, b] = await Promise.all([r.want(join(tmp, "clone"), null), r.want(join(tmp, "clone"), null)]);
  await r.want(join(tmp, "clone"), null);
  assert.equal(a, b);
  assert.equal(r.get(join(tmp, "clone"), null).identity, "github.com/Org/Repo");
  assert.equal(execCalls.filter((c) => c.args[0] === "rev-parse").length, 1);
  // A different Machine is a different entry.
  await r.want(join(tmp, "clone"), "wsl");
  assert.equal(execCalls.filter((c) => c.args[0] === "rev-parse").length, 2);
});

test("resolver: null is retried only after 60 seconds", async () => {
  let t = 1000;
  const r = makeResolver({ now: () => t });
  const revParses = () => execCalls.filter((c) => c.args[0] === "rev-parse").length;
  assert.equal(await r.want(join(tmp, "plain"), null), null);
  assert.equal(r.get(join(tmp, "plain"), null), null);
  t += 59000;
  await r.want(join(tmp, "plain"), null);
  assert.equal(revParses(), 1);
  t += 1001;
  await r.want(join(tmp, "plain"), null);
  assert.equal(revParses(), 2);
});

test("resolver: at most 4 resolves run at once", async () => {
  const held = [];
  fake.exec = () => new Promise((res) => held.push(() => res({ code: 128, stdout: "", stderr: "not a repo" })));
  const r = makeResolver();
  const all = Promise.all(Array.from({ length: 10 }, (_, i) => r.want(`/d${i}`, null)));
  let max = 0;
  while (held.length || execCalls.length < 10) {
    await new Promise((res) => setImmediate(res));
    max = Math.max(max, held.length);
    held.splice(0).forEach((f) => f());
  }
  await all;
  await r.settled();
  assert.equal(max, 4);
  assert.equal(execCalls.length, 10);
});
