import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, execCalls, win, reset } from "herdr";
import { cleanWords, namePrompt, askName } from "../mods/wranglr/namer.js";

beforeEach(() => reset());

test("cleanWords strips quotes and trailing punctuation", () => {
  assert.equal(cleanWords('"Fix login redirect."\n'), "Fix login redirect");
  assert.equal(cleanWords("“Add export”"), "Add export");
});

test("cleanWords takes the first non-empty line", () => {
  assert.equal(cleanWords("\n\n  Retry uploads!  \nsecond line\n"), "Retry uploads");
});

test("cleanWords on empty output is null", () => {
  assert.equal(cleanWords(""), null);
  assert.equal(cleanWords("\n  \n"), null);
  assert.equal(cleanWords('""'), null);
});

test("the prompt names the branch and the title", () => {
  const p = namePrompt("feature/123-x", "Fixing the login");
  assert.ok(p.includes("feature/123-x") && p.includes("Fixing the login") && /one to four/.test(p));
});

test("askName returns the cleaned words on success", async () => {
  fake.exec = () => Promise.resolve({ code: 0, stdout: "'Speed up search'\n", stderr: "" });
  assert.equal(await askName("b", "t"), "Speed up search");
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].cmd, "claude");
  assert.deepEqual(execCalls[0].args, ["-p", namePrompt("b", "t"), "--model", "haiku"]);
  assert.equal(execCalls[0].timeout, 60000);
});

test("askName is null on a non-zero exit", async () => {
  fake.exec = () => Promise.resolve({ code: 1, stdout: "Some words", stderr: "auth" });
  assert.equal(await askName("b", "t"), null);
});

test("askName is null when claude cannot start", async () => {
  fake.exec = () => Promise.reject(new Error("cannot start claude"));
  assert.equal(await askName("b", "t"), null);
  assert.equal(execCalls.length, 1);
});

test("askName on Windows tries WSL once when claude cannot start", async () => {
  win.platform = "windows";
  fake.exec = (cmd) => (cmd === "claude" ? Promise.reject(new Error("cannot start claude")) : Promise.resolve({ code: 0, stdout: "From wsl\n", stderr: "" }));
  assert.equal(await askName("b", "t"), "From wsl");
  assert.deepEqual(execCalls[1].args, ["-e", "bash", "-lc", 'claude -p "$1" --model haiku', "_", namePrompt("b", "t")]);
});
