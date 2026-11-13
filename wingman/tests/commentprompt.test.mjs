// commentprompt.js: the review comments prompt (format, repos, paths) and the target agent.
import { buildPrompt, location, relativeTo, agentView, chooseTarget, isWslArgv, promptProblem, MAX_PROMPT } from "../mods/wingman/commentprompt.js";
import { makeComment } from "../mods/wingman/comments.js";
import assert from "node:assert/strict";

const mk = (id, over = {}, text = "Use a const here") => makeComment({ space: "s1", path: "C:/dev/app/src/foo.js", root: "C:/dev/app", rel: "src/foo.js",
  key: "C:/dev/app|src/foo.js", start: 12, end: 15, snippet: ["let a = 1;", "let b = 2;", "let c = 3;"], by: "t1", ...over }, text, 1, id).comment;

// ---- one repo: the exact format ----
const one = buildPrompt([mk("a"), mk("b", { start: 20, end: 20, snippet: ["return a;"] }, "Line one\nline two")],
  { repos: new Map([["C:/dev/app", { name: "app", branch: "main" }]]), cwd: "C:/dev/app" });
assert.equal(one, [
  "Code review comments from Wingman (repo: app, branch: main):",
  "",
  "1. src/foo.js:12-15",
  "   > let a = 1;",
  "   > let b = 2;",
  "   > let c = 3;",
  "   Comment: Use a const here",
  "",
  "2. src/foo.js:20",
  "   > return a;",
  "   Comment: Line one",
  "   line two",
  "",
  "Please address each comment. Reply with what you changed per item.",
].join("\n"));

// ---- several repos: one header line per repo, numbering carries on ----
const lib = mk("c", { path: "C:/dev/lib/x.ts", root: "C:/dev/lib", rel: "x.ts", key: "C:/dev/lib|x.ts", start: 3, end: 3, snippet: [] }, "Why?");
const many = buildPrompt([mk("a"), lib, mk("d", { start: 40, end: 41, snippet: ["x"] }, "Again")],
  { repos: new Map([["C:/dev/app", { name: "app", branch: "main" }], ["C:/dev/lib", { name: "lib", branch: "dev" }]]), cwd: "C:/dev/app" });
assert.equal(many, [
  "Code review comments from Wingman:",
  "",
  "repo: app, branch: main:",
  "",
  "1. src/foo.js:12-15",
  "   > let a = 1;",
  "   > let b = 2;",
  "   > let c = 3;",
  "   Comment: Use a const here",
  "",
  "2. src/foo.js:40-41",
  "   > x",
  "   Comment: Again",
  "",
  "repo: lib, branch: dev:",
  "",
  "3. C:/dev/lib/x.ts:3",
  "   Comment: Why?",
  "",
  "Please address each comment. Reply with what you changed per item.",
].join("\n"));
// No repo info: the root's last folder, no branch.
assert.ok(buildPrompt([mk("a")]).startsWith("Code review comments from Wingman (repo: app):\n"));

// ---- paths: relative inside the agent's folder, else absolute ----
assert.equal(location(mk("a"), { cwd: "C:/dev/app" }), "src/foo.js:12-15");
assert.equal(location(mk("a"), { cwd: "C:\\dev\\app\\" }), "src/foo.js:12-15"); // backslashes, trailing slash
assert.equal(location(mk("a"), { cwd: "c:/DEV/app" }), "src/foo.js:12-15"); // drive paths ignore case
assert.equal(location(mk("a"), { cwd: "C:/dev/other" }), "C:/dev/app/src/foo.js:12-15");
assert.equal(location(mk("a"), { cwd: "C:/dev/ap" }), "C:/dev/app/src/foo.js:12-15"); // a prefix that isn't a folder
assert.equal(location(mk("a")), "C:/dev/app/src/foo.js:12-15");
assert.equal(location(mk("a", { start: 7, end: 7 }), { cwd: "C:/dev" }), "app/src/foo.js:7");
// An agent in WSL sees /mnt/c paths: absolute outside its folder, relative inside it.
assert.equal(location(mk("a"), { wsl: true }), "/mnt/c/dev/app/src/foo.js:12-15");
assert.equal(location(mk("a"), { wsl: true, cwd: "/mnt/c/dev/app" }), "src/foo.js:12-15");
assert.equal(location(mk("a"), { wsl: true, cwd: "/mnt/c/Dev/App" }), "src/foo.js:12-15");
assert.equal(location(mk("a"), { wsl: true, cwd: "C:/dev/app" }), "src/foo.js:12-15"); // cwd reported the Windows way
assert.equal(location(mk("a"), { wsl: true, cwd: "/home/me" }), "/mnt/c/dev/app/src/foo.js:12-15");
// The path the agent itself used (as), when it is the target and made the change.
assert.equal(location(mk("a", { as: "/mnt/c/dev/app/src/foo.js" }), { target: "t1", cwd: "/mnt/c/dev/app" }), "src/foo.js:12-15");
assert.equal(location(mk("a", { as: "/elsewhere/foo.js" }), { target: "t9", cwd: "C:/dev/app" }), "src/foo.js:12-15");
// Paths on another machine (Unix) stay case-sensitive.
const unix = mk("u", { path: "/home/me/app/src/foo.js", root: "/home/me/app" });
assert.equal(location(unix, { cwd: "/home/me/app" }), "src/foo.js:12-15");
assert.equal(location(unix, { cwd: "/home/me/App" }), "/home/me/app/src/foo.js:12-15");
assert.equal(agentView("C:\\x\\y", true), "/mnt/c/x/y");
assert.equal(agentView("C:/x", false), "C:/x");
assert.equal(relativeTo("/a/b", "/a/b"), "/a/b");
assert.ok(isWslArgv(["C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu"]));
assert.ok(isWslArgv(["wsl"]));
assert.ok(!isWslArgv(["pwsh.exe"]));

// ---- rejected and stale comments say so ----
const rej = buildPrompt([mk("r", { kind: "rejected", snippet: ["agent's line"] }, "Keep the old name")], { cwd: "C:/dev/app" });
assert.ok(rej.includes("1. src/foo.js:12-15 (a change of yours I rejected)\n   > agent's line\n   Comment: Keep the old name"));
assert.ok(buildPrompt([{ ...mk("s"), stale: true }]).includes("(the code here moved or changed since)"));

// ---- no escape sequences reach the prompt, whatever the comment holds ----
const evil = { ...mk("e"), text: "hi\x1b]52;c;ZXZpbA==\x07there\x1b[2J", snippet: ["\x1b[31mred"], path: "C:/dev/app/src/\x1bx.js" };
const p = buildPrompt([evil], { cwd: "C:/dev/app" });
assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(p));
assert.ok(p.includes("Comment: hi]52;c;ZXZpbA==there[2J"));
// At most 50 comments.
const fifty = buildPrompt(Array.from({ length: 60 }, (_, i) => mk(`n${i}`)));
assert.ok(fifty.includes("\n50. ") && !fifty.includes("\n51. "));
assert.equal(promptProblem("x".repeat(MAX_PROMPT)), null);
assert.ok(promptProblem("x".repeat(MAX_PROMPT + 1)).includes("at most"));

// ---- target choice ----
const A = { address: "t1" }, B = { address: "t2" };
const live = new Set(["t1", "t2"]);
// Every comment names the same live agent: that one, even with several agents in the space.
assert.deepEqual(chooseTarget([mk("a"), mk("b")], [A, B], live), { address: "t1" });
// The named agent is gone: the space's only agent.
assert.deepEqual(chooseTarget([mk("a", { by: "t9" })], [B], live), { address: "t2" });
// Comments name different agents, or none: the only agent, else a pick.
assert.deepEqual(chooseTarget([mk("a"), mk("b", { by: "t2" })], [B], live), { address: "t2" });
assert.deepEqual(chooseTarget([mk("a"), mk("b", { by: null })], [A, B], live), { pick: [A, B] });
assert.deepEqual(chooseTarget([mk("a", { by: null })], [A, B], live), { pick: [A, B] });
assert.ok(chooseTarget([mk("a", { by: null })], [], live).error);
console.log("commentprompt ok");
