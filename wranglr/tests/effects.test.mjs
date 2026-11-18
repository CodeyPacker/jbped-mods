import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, execCalls, runCalls, notes, hcCalls, reset } from "herdr";
import { runEffects } from "../mods/wranglr/effects.js";

const ok = { code: 0, stdout: "", stderr: "" };
const order = [];
const noDeps = { dispatch: () => {}, askName: async () => null, saveSetting: async () => {}, saveSettings: async () => {}, saveGroup: async () => {} };
beforeEach(() => {
  reset(); order.length = 0;
  fake.exec = (cmd, args) => { order.push(`${cmd} ${args.join(" ")}`); return Promise.resolve(ok); };
});

test("select and rename run the space commands", async () => {
  await runEffects([{ type: "select", id: "s1" }, { type: "rename", id: "s2", name: "123 Fix login" }], noDeps);
  assert.deepEqual(runCalls, [{ name: "space.select", args: { id: "s1" } }, { name: "space.rename", args: { id: "s2", name: "123 Fix login" } }]);
});

test("start without a worktree opens a space, always naming the Machine and leaving out null fields", async () => {
  await runEffects([
    { type: "start", machine: null, folder: "/r", argv: null, name: null, worktree: null },
    { type: "start", machine: "wsl", folder: "/w", argv: ["claude", "--add-dir", "/x"], name: "Arden", worktree: null },
  ], noDeps);
  assert.deepEqual(runCalls, [
    { name: "space.new", args: { folder: "/r", machine: "" } },
    { name: "space.new", args: { folder: "/w", machine: "wsl", argv: ["claude", "--add-dir", "/x"], name: "Arden" } },
  ]);
  assert.equal(execCalls.length, 0);
});

test("a worktree start makes the worktree, says so, then runs space.new", async () => {
  const sent = [];
  await runEffects([{ type: "start", machine: "wsl", folder: "/m/.worktrees/b", argv: null, name: null, worktree: { main: "/m", branch: "b", path: "/m/.worktrees/b", from: null }, place: { group: "repo:x", sub: "s" } }],
    { ...noDeps, dispatch: (a) => sent.push({ ...a, spaces: runCalls.length }) });
  assert.ok(order.some((c) => c.startsWith("git worktree add")), "git made the worktree");
  assert.deepEqual(sent, [{ type: "made", ok: true, group: "repo:x", sub: "s", machine: "wsl", folder: "/m/.worktrees/b", spaces: 0 }]);
  assert.deepEqual(runCalls, [{ name: "space.new", args: { folder: "/m/.worktrees/b", machine: "wsl" } }]);
});

test("a failed worktree add reports git's error and opens no space", async () => {
  fake.exec = (_cmd, args) => Promise.resolve(args[0] === "worktree" ? { code: 128, stdout: "", stderr: "fatal: '/m/w' already exists\n" } : { code: 1, stdout: "", stderr: "" });
  const sent = [];
  await runEffects([{ type: "start", machine: null, folder: "/m/w", argv: null, name: null, worktree: { main: "/m", branch: "b", path: "/m/w", from: null }, place: { group: "repo:x", sub: null } }, { type: "select", id: "s1" }], { ...noDeps, dispatch: (a) => sent.push(a) });
  assert.deepEqual(sent, [{ type: "made", ok: false, group: "repo:x", sub: null, machine: null, folder: "/m/w" }]);
  assert.deepEqual(runCalls, [{ name: "space.select", args: { id: "s1" } }]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, "error");
  assert.match(notes[0].body, /already exists/);
});

test("ask dispatches named with the words", async () => {
  const sent = [];
  await runEffects([{ type: "ask", space: "s1", ticket: "123", branch: "feature/123-a-b-c-d-e", title: "T" }], {
    ...noDeps, dispatch: (a) => sent.push(a), askName: async (branch, title) => (branch === "feature/123-a-b-c-d-e" && title === "T" ? "Fix login" : "wrong"),
  });
  assert.deepEqual(sent, [{ type: "named", space: "s1", words: "Fix login" }]);
});

test("ask dispatches named with null when the call fails", async () => {
  const sent = [];
  await runEffects([{ type: "ask", space: "s1", ticket: null, branch: "b", title: "" }], { ...noDeps, dispatch: (a) => sent.push(a), askName: async () => { throw new Error("x"); } });
  assert.deepEqual(sent, [{ type: "named", space: "s1", words: null }]);
});

test("setting saves through saveSetting and toast notifies", async () => {
  const saved = [];
  await runEffects([{ type: "setting", key: "sort", value: "az" }, { type: "toast", level: "warning", title: "No Machine", body: "Clone it first." }], { ...noDeps, saveSetting: async (k, v) => saved.push([k, v]) });
  assert.deepEqual(saved, [["sort", "az"]]);
  assert.deepEqual(notes, [{ title: "No Machine", body: "Clone it first.", level: "warning" }]);
});

test("a throwing effect is reported and the rest still run", async () => {
  await runEffects([{ type: "setting", key: "sort", value: "az" }, { type: "select", id: "s9" }], { ...noDeps, saveSetting: async () => { throw new Error("disk full"); } });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, "error");
  assert.match(notes[0].body, /disk full/);
  assert.deepEqual(runCalls, [{ name: "space.select", args: { id: "s9" } }]);
});

test("settings and group save through the config module, and a failed save says so", async () => {
  const saved = [];
  await runEffects([
    { type: "settings", values: { machine: "wsl" } },
    { type: "group", kind: "repo", key: "github.com/o/r", values: { from: "origin/dev" } },
  ], { ...noDeps, saveSettings: async (v) => saved.push(["settings", v]), saveGroup: async (...a) => saved.push(["group", ...a]) });
  assert.deepEqual(saved, [["settings", { machine: "wsl" }], ["group", "repo", "github.com/o/r", { from: "origin/dev" }]]);
  assert.equal(notes.length, 0);
  await runEffects([{ type: "group", kind: "workspace", key: "W", values: {} }, { type: "select", id: "s1" }], { ...noDeps, saveGroup: async () => { throw new Error("the Workspace \"W\" is not in wranglr.json"); } });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, "error");
  assert.match(notes[0].body, /^Not saved: the Workspace "W" is not in wranglr.json\.$/);
  assert.deepEqual(runCalls, [{ name: "space.select", args: { id: "s1" } }], "the effects after it still run");
});

test("close closes each space without asking again", async () => {
  await runEffects([{ type: "close", ids: ["s1", "s2"] }], noDeps);
  assert.deepEqual(runCalls, [{ name: "space.close", args: { id: "s1", confirmed: true } }, { name: "space.close", args: { id: "s2", confirmed: true } }]);
});

test("revive types the resume command into the terminal, and a failed send is reported", async () => {
  hcCalls.length = 0;
  fake.hc = () => Promise.resolve(ok);
  await runEffects([{ type: "revive", terminal: "wsl/t2c", command: "cd '/r' && claude --resume x" }], noDeps);
  assert.deepEqual(hcCalls, [["send", "wsl/t2c", "cd '/r' && claude --resume x"]]);
  assert.equal(notes.length, 0);
  fake.hc = () => Promise.resolve({ code: 3, stdout: "", stderr: "no terminal" });
  await runEffects([{ type: "revive", terminal: "wsl/t2c", command: "x" }], noDeps);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /no terminal/);
  fake.hc = null;
});
