import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTemplate, templateErrors, agentArgv, slug, ticketFolder, launchPrompt, reviewPrompt, spaceArgv, parseScript, DEFAULT_LAUNCH } from "../mods/wayfinder/launch.js";
import { makeLaunchWorktrees, makeReviewWorktree, existingWorktrees } from "../mods/wayfinder/flow.js";
import { addRepo } from "../mods/wayfinder/settings.js";
import { parseConfig } from "../mods/wayfinder/config.js";

test("templates resolve global, then Board or repo, field by field", () => {
  const t = resolveTemplate(DEFAULT_LAUNCH, { agent: "codex", model: "o3" }, { model: "opus" });
  assert.equal(t.agent, "codex"); assert.equal(t.model, "opus"); assert.equal(t.prompt, DEFAULT_LAUNCH.prompt);
  assert.deepEqual(agentArgv({ agent: "claude", model: "opus", args: ["--x"] }), ["claude", "--model", "opus", "--x"]);
  assert.throws(() => agentArgv({ agent: "rm -rf" }));
  assert.ok(templateErrors({ agent: "a b" }, "t").length);
  assert.deepEqual(templateErrors({ agent: "claude", model: "opus" }, "t"), []);
  assert.ok(parseConfig(JSON.stringify({ templates: { launch: { agent: "x;y" } }, profiles: { p: {} } }), "linux").errors.some((e) => /templates\.launch\.agent/.test(e)));
});

test("ticket folder and branch names are safe", () => {
  assert.equal(slug("A8 - REPORTS: ARA / Agency"), "a8-reports-ara-agency");
  assert.equal(ticketFolder({ id: "46382", title: "Layout issue!" }), "46382-layout-issue");
  assert.equal(ticketFolder({ id: "repo#12", title: "" }), "repo-12-ticket");
});

test("prompts carry the Ticket, the repos and the criteria", () => {
  const p = launchPrompt({ id: "1", title: "T", type: "Bug", url: "u", description: "D", acceptanceCriteria: "AC" }, [{ id: "fe", worktree: "/w/fe", branch: "1-t" }], DEFAULT_LAUNCH);
  assert.match(p, /^Orchestrate this Ticket/); assert.match(p, /## Acceptance criteria\nAC/); assert.match(p, /- fe: \/w\/fe \(branch 1-t\)/);
  const r = reviewPrompt({ id: "r!1", title: "PR", repo: "p/r" }, { branch: "b", criteria: [], description: "desc" }, "/w", { prompt: "Go" });
  assert.match(r, /Use the Pull Request description:\n\ndesc/);
  assert.match(reviewPrompt({ id: "x", title: "", repo: "p/r" }, { branch: "b", criteria: [{ id: "7", title: "S", text: "must" }] }, "/w", {}), /### 7 S\nmust/);
});

test("spaceArgv runs the agent in the folder through the runner, as argv", () => {
  assert.deepEqual(spaceArgv("wsl:Ubuntu", "windows", "/h/w", ["claude"]), ["wsl.exe", "-d", "Ubuntu", "--exec", "bash", "-lc", 'cd "$0" && exec "$@"', "/h/w", "claude"]);
  assert.deepEqual(parseScript("made a\nreused b\nspace C:\\x\npath /x\n"), { space: "C:\\x", path: "/x", made: ["a"], reused: ["b"] });
});

test("addRepo adds a clone once and lists it on the Board", () => {
  const raw = { profiles: { p: { accounts: [], repos: [], boards: [{ id: "b", account: "a", ref: {} }] } } };
  const a = addRepo(raw, "p", { path: "/src/Front End/", boardId: "b" });
  assert.equal(a.id, "front-end");
  assert.deepEqual(a.raw.profiles.p.boards[0].repos, ["front-end"]);
  const b = addRepo(a.raw, "p", { path: "/src/Front End", prRepo: "o/fe" });
  assert.equal(b.id, "front-end"); assert.equal(b.raw.profiles.p.repos.length, 1); assert.equal(b.raw.profiles.p.repos[0].prRepo, "o/fe");
});

// The real scripts against real git, in a throwaway HOME.
const sh = (cmd, cwd, env) => spawnSync("sh", ["-c", cmd], { cwd, env, encoding: "utf8" });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "wf-launch-"));
  const env = { ...process.env, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const r = sh(`git init -q --bare -b main origin.git && git clone -q origin.git clone 2>/dev/null && cd clone && git commit -q --allow-empty -m one && git push -q origin main && git checkout -q -b feat && echo x > f && git add f && git commit -q -m two && git push -q origin feat && git checkout -q main && git remote set-head origin main`, home, env);
  assert.equal(r.status, 0, r.stderr);
  const io = { run: async (cmd, args) => { const p = spawnSync(cmd, args, { env, encoding: "utf8" }); return { code: p.status, stdout: p.stdout, stderr: p.stderr }; } };
  return { home, io, clone: join(home, "clone") };
}

test("Launch makes a worktree per repo on a new branch, and reuses it after", async () => {
  const { home, io, clone } = fixture();
  const first = await makeLaunchWorktrees("1-t", "1-t", [{ path: clone, name: "fe" }], io);
  assert.deepEqual(first.made, ["fe"]);
  assert.equal(first.path, join(home, ".herdr/worktrees/1-t"));
  assert.ok(existsSync(join(first.path, "fe/.git")));
  assert.equal(sh("git branch --show-current", join(first.path, "fe")).stdout.trim(), "1-t");
  assert.deepEqual(await existingWorktrees("1-t", ["fe", "be"], io), ["fe"]);
  const again = await makeLaunchWorktrees("1-t", "1-t", [{ path: clone, name: "fe" }], io);
  assert.deepEqual(again.reused, ["fe"]); assert.deepEqual(again.made, []);
});

test("Review checks out the PR branch detached, and a missing branch fails with git's message", async () => {
  const { io, clone } = fixture();
  const r = await makeReviewWorktree("review-pr-1", { path: clone, name: "fe" }, "feat", io);
  assert.deepEqual(r.made, ["fe"]);
  assert.equal(readFileSync(join(r.path, "f"), "utf8"), "x\n");
  assert.equal(sh("git branch --show-current", r.path).stdout.trim(), ""); // detached
  await assert.rejects(makeReviewWorktree("review-pr-2", { path: clone, name: "fe" }, "nope", io), /fetch of nope failed/);
});
