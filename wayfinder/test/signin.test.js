import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGhStatus, ghSignInState, github } from "../mods/wayfinder/providers/github.js";
import { signInStates } from "../mods/wayfinder/flow.js";
import { shellInvocation } from "../mods/wayfinder/command.js";

const STATUS = `github.com
  ✓ Logged in to github.com account jbped (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'

  ✓ Logged in to github.com account Work-Me (keyring)
  - Active account: false
  - Token scopes: 'gist', 'read:org', 'read:project', 'repo'

  X Failed to log in to github.com account gone (keyring)
  - Active account: false
  - The token in keyring is invalid.
`;

test("gh status parses logins, validity, the active account and scopes", () => {
  const a = parseGhStatus(STATUS);
  assert.deepEqual(a.get("jbped"), { login: "jbped", ok: true, active: true, scopes: ["gist", "read:org", "repo", "workflow"] });
  assert.equal(a.get("work-me").scopes.includes("read:project"), true);
  assert.equal(a.get("gone").ok, false);
  assert.equal(parseGhStatus("You are not logged into any GitHub hosts. To log in, run: gh auth login").size, 0);
});

test("missing, expired and under-scoped logins each name their command", () => {
  const a = parseGhStatus(STATUS);
  assert.deepEqual(ghSignInState("nobody", a), { ok: false, reason: "nobody isn't signed in to gh", command: "gh auth login -h github.com" });
  assert.equal(ghSignInState("gone", a).command, "gh auth login -h github.com");
  assert.deepEqual(ghSignInState("jbped", a, { boards: true }),
    { ok: false, reason: "jbped lacks the read:project scope Boards need", command: "gh auth refresh -s read:project -h github.com" });
  assert.deepEqual(ghSignInState("jbped", a, { boards: false }), { ok: true });
  assert.deepEqual(ghSignInState("WORK-ME", a, { boards: true }), { ok: true });
});

test("an inactive account switches to itself for the refresh, then back", () => {
  const a = parseGhStatus(STATUS.replace("'read:project', ", ""));
  assert.equal(ghSignInState("Work-Me", a, { boards: true }).command,
    "gh auth switch -h github.com -u Work-Me && gh auth refresh -s read:project -h github.com && gh auth switch -h github.com -u jbped");
});

test("signInState rejects odd logins before any command, and reports an unreachable gh", async () => {
  let ran = 0;
  const io = { run: async () => { ran++; return { code: 127, stdout: "", stderr: "gh: not found" }; } };
  assert.equal((await github.signInState({ login: "a; rm -rf ~" }, io)).command, null);
  assert.equal(ran, 0);
  const r = await github.signInState({ login: "jbped" }, io);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/);
});

test("the flow checks every Account, asks for board scopes only where Boards use it, and isolates failures", async () => {
  const seen = {};
  const fake = { capabilities: ["signInState"], signInState: async (a, _io, needs) => { seen[a.id] = needs; if (a.id === "c") throw new Error("boom"); return { ok: true }; } };
  const profile = { accounts: [{ id: "a", provider: "fake" }, { id: "b", provider: "fake" }, { id: "c", provider: "fake" }, { id: "d", provider: "none" }], boards: [{ id: "x", account: "a" }] };
  const states = await signInStates(profile, {}, { fake });
  assert.deepEqual(seen, { a: { boards: true }, b: { boards: false }, c: { boards: false } });
  assert.deepEqual(states, { a: { ok: true }, b: { ok: true }, c: { ok: false, reason: "boom", command: null } });
});

test("sign-in commands run in a shell through the runner", () => {
  const w = shellInvocation("wsl:Ubuntu", "windows", "gh auth login -h github.com");
  assert.equal(w.command, "wsl.exe");
  assert.deepEqual(w.args.slice(0, 5), ["-d", "Ubuntu", "--exec", "bash", "-lc"]);
  assert.equal(w.args[5], "gh auth login -h github.com");
  assert.deepEqual(shellInvocation("native", "windows", "gh auth login"), { command: "cmd.exe", args: ["/c", "gh auth login"], cwd: undefined });
  assert.equal(shellInvocation("native", "linux", "x").command, "sh");
});
