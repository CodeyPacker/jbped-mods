import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, execCalls, hcCalls, reset } from "herdr";
import { agentDir, agentFacts, terminalNow, lastCwd } from "../mods/wranglr/agentdir.js";

const SID = "a2577da9-364f-4793-b7a1-50e0f1f604cb";
const ok = (stdout) => Promise.resolve({ code: 0, stdout, stderr: "" });
const no = () => Promise.resolve({ code: 1, stdout: "", stderr: "nope" });
// Answers for: hc get, the session file, the transcript's folder lines.
function answers(get, session, folder) {
  fake.hc = () => get;
  fake.exec = (_cmd, args) => (args[1].includes("sessions") ? session : folder);
}
const front = (o = {}) => ok(JSON.stringify({ foreground: { name: "claude", pid: 8887, ...o } }));
beforeEach(() => { reset(); hcCalls.length = 0; fake.hc = null; });

test("lastCwd takes the last valid absolute folder", () => {
  assert.equal(lastCwd('"cwd":"/a"\n"cwd":"/b/c"\n'), "/b/c");
  assert.equal(lastCwd('"cwd":"C:\\\\dev\\\\x"'), "C:\\dev\\x");
  assert.equal(lastCwd('"cwd":"/a"\n"cwd":"relative"\ngarbage'), "/a");
  assert.equal(lastCwd(""), null);
  assert.equal(lastCwd(null), null);
});

test("agentDir reads the session of the terminal's Claude process and its transcript, on the Machine", async () => {
  answers(front(), ok(JSON.stringify({ pid: 8887, sessionId: SID, cwd: "/r" })), ok('"cwd":"/r"\n"cwd":"/r/.worktrees/x"\n'));
  assert.equal(await agentDir("wsl/t2c", "wsl"), "/r/.worktrees/x");
  // The app's own hc is asked, with the full address.
  assert.deepEqual(hcCalls, [["get", "wsl/t2c", "--json"]]);
  // The pid and session id are arguments, not script text.
  assert.deepEqual(execCalls[0].args.slice(2), ["sh", "8887"]);
  assert.deepEqual(execCalls[1].args.slice(2), ["sh", SID]);
  assert.ok(!execCalls[0].args[1].includes("8887") && !execCalls[1].args[1].includes(SID));
  assert.equal(execCalls[0].on, "wsl");
  assert.equal(execCalls[1].on, "wsl");
});

test("agentDir on this computer names no Machine", async () => {
  answers(front(), ok(JSON.stringify({ sessionId: SID })), ok('"cwd":"/r"'));
  assert.equal(await agentDir("t7"), "/r");
  assert.equal(execCalls[0].on, undefined);
});

test("agentDir gives null for anything it cannot trust", async () => {
  const session = ok(JSON.stringify({ sessionId: SID })), folder = ok('"cwd":"/r"');
  const cases = [
    [no(), session, folder],
    [ok("not json"), session, folder],
    [front({ name: "bash" }), session, folder],
    [front({ pid: "8887; rm -rf /" }), session, folder],
    [front({ pid: -1 }), session, folder],
    [front(), no(), folder],
    [front(), ok("{"), folder],
    [front(), ok(JSON.stringify({ sessionId: "../../etc/passwd" })), folder],
    [front(), ok(JSON.stringify({ sessionId: SID + "x" })), folder],
    [front(), session, ok("")],
    [front(), session, ok('"cwd":"not/absolute"')],
  ];
  for (const [g, s, f] of cases) { answers(g, s, f); assert.equal(await agentDir("t1", "wsl"), null); }
  answers(front(), session, folder);
  fake.exec = () => Promise.reject(new Error("unreachable"));
  assert.equal(await agentDir("t1", "wsl"), null);
  fake.hc = () => Promise.reject(new Error("no core"));
  assert.equal(await agentDir("t1", "wsl"), null);
});

test("agentFacts gives the terminal's process, the session, where it started, its flags and where it works now", async () => {
  fake.hc = () => ok(JSON.stringify({ pid: 876, foreground: { name: "claude", pid: 8887, argv: ["claude", "-r", "--model", "opus"] } }));
  fake.exec = (_c, args) => (args[1].includes("sessions") ? ok(JSON.stringify({ sessionId: SID, cwd: "/r" })) : ok('"cwd":"/r/wt"'));
  assert.deepEqual(await agentFacts("wsl/t2c", "wsl"), { pid: 876, session: SID, cwd: "/r", flags: ["-r", "--model", "opus"], dir: "/r/wt" });
  // No transcript: the rest is still known.
  fake.exec = (_c, args) => (args[1].includes("sessions") ? ok(JSON.stringify({ sessionId: SID, cwd: "/r" })) : no());
  assert.equal((await agentFacts("wsl/t2c", "wsl")).dir, null);
});

test("terminalNow tells an idle shell, a busy terminal, a closed one and one it could not ask about", async () => {
  fake.hc = () => ok(JSON.stringify({ pid: 19028, state: "live", foreground: { name: "bash", pid: 19028 } }));
  assert.deepEqual(await terminalNow("wsl/t1"), { pid: 19028, idle: true });
  assert.deepEqual(hcCalls, [["get", "wsl/t1", "--json"]]);
  fake.hc = () => ok(JSON.stringify({ pid: 19028, state: "live", foreground: { name: "vim", pid: 20000 } }));
  assert.deepEqual(await terminalNow("t1"), { pid: 19028, idle: false });
  fake.hc = () => Promise.resolve({ code: 3, stdout: JSON.stringify({ error: { kind: "not_found", message: 'no terminal "t1"' } }), stderr: "" });
  assert.deepEqual(await terminalNow("t1"), { gone: true });
  fake.hc = () => ok(JSON.stringify({ pid: 5, state: "finished" }));
  assert.deepEqual(await terminalNow("t1"), { gone: true });
  fake.hc = () => Promise.resolve({ code: 1, stdout: JSON.stringify({ error: { kind: "unreachable" } }), stderr: "" });
  assert.equal(await terminalNow("t1"), null);
  fake.hc = () => ok("{}");
  assert.equal(await terminalNow("t1"), null);
  fake.hc = () => Promise.reject(new Error("no core"));
  assert.equal(await terminalNow("t1"), null);
});
