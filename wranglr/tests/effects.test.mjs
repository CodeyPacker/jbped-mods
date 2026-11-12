import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, execCalls, runCalls, notes, reset } from "herdr";
import { runEffects } from "../mods/wranglr/effects.js";

const ok = { code: 0, stdout: "", stderr: "" };
const order = [];
const noDeps = { dispatch: () => {}, askName: async () => null, saveSetting: async () => {} };
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

test("a worktree start runs git before space.new", async () => {
  fake.exec = (cmd, args, opts) => { order.push({ cmd, args, opts }); return Promise.resolve(ok); };
  await runEffects([{ type: "start", machine: "wsl", folder: "/m/.worktrees/b", argv: null, name: null, worktree: { main: "/m", branch: "b", path: "/m/.worktrees/b" } }], noDeps);
  assert.deepEqual(order, [{ cmd: "git", args: ["worktree", "add", "/m/.worktrees/b", "-b", "b"], opts: { cwd: "/m", on: "wsl" } }]);
  assert.deepEqual(runCalls, [{ name: "space.new", args: { folder: "/m/.worktrees/b", machine: "wsl" } }]);
});

test("an existing branch is checked out instead of made", async () => {
  fake.exec = (cmd, args) => { order.push(args.join(" ")); return Promise.resolve(args.includes("-b") ? { code: 255, stdout: "", stderr: "fatal: a branch named 'b' already exists\n" } : ok); };
  await runEffects([{ type: "start", machine: null, folder: "/m/w", argv: null, name: null, worktree: { main: "/m", branch: "b", path: "/m/w" } }], noDeps);
  assert.deepEqual(order, ["worktree add /m/w -b b", "worktree add /m/w b"]);
  assert.equal(runCalls.length, 1);
});

test("a failed worktree add reports git's error and opens no space", async () => {
  fake.exec = () => Promise.resolve({ code: 128, stdout: "", stderr: "fatal: '/m/w' already exists\n" });
  await runEffects([{ type: "start", machine: null, folder: "/m/w", argv: null, name: null, worktree: { main: "/m", branch: "b", path: "/m/w" } }, { type: "select", id: "s1" }], noDeps);
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
