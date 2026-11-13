// The session log source (sessionlog.js) with synthetic Claude Code logs: slugs, places per machine,
// path forms, tool mapping, reduction, bad and oversized lines, incremental reads, truncation, the
// ambiguity rule, and the setting off.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCalls } from "herdr";
import {
  claudeSlugs, toolOp, isClaude, parseLines, reduce, ordered, takeLines, readPlan, chooseLog, placesFor, hostOfPlace,
  noteSession, sessionOf, startedAt, agentTouches, forgetLogs, readLog, listLogs, CHUNK, EVERY_MS,
} from "../mods/wingman/sessionlog.js";

const line = (name, input, ts = "2026-11-13T10:00:00.000Z", extra = {}) => JSON.stringify({
  type: "assistant", sessionId: "11111111-2222-3333-4444-555555555555", timestamp: ts, cwd: "/work/app",
  message: { role: "assistant", content: [{ type: "text", text: "x" }, { type: "tool_use", id: "t1", name, input }] }, ...extra,
}) + "\n";

// ---- slugs: both encodings -----------------------------------------------------------
assert.deepEqual(claudeSlugs("/private/tmp/nv9076-e2e.apps/agent"), ["-private-tmp-nv9076-e2e.apps-agent", "-private-tmp-nv9076-e2e-apps-agent"]);
assert.deepEqual(claudeSlugs("/mnt/c/dev/app"), ["-mnt-c-dev-app"]);
assert.deepEqual(claudeSlugs("C:\\dev\\my.app"), ["C--dev-my.app", "C--dev-my-app"]);
assert.deepEqual(claudeSlugs("/home/u/it's"), ["-home-u-it-s"]); // a quote never reaches a slug
assert.deepEqual(claudeSlugs(""), []);

// ---- where the log is looked for ---------------------------------------------------------
assert.deepEqual(placesFor("/work/app", null, false), [{ kind: "sh", cwd: "/work/app" }]);
assert.deepEqual(placesFor("/srv/app", "box", false), [{ kind: "on", on: "box", cwd: "/srv/app" }]);
assert.deepEqual(placesFor("C:/dev/app", null, true), [{ kind: "ps", cwd: "C:\\dev\\app" }, { kind: "wsl", distro: null, cwd: "/mnt/c/dev/app" }]);
assert.deepEqual(placesFor("//wsl.localhost/Ubuntu/home/u/app", null, true), [{ kind: "wsl", distro: "Ubuntu", cwd: "/home/u/app" }]);

// ---- paths as the mod keeps them -----------------------------------------------------------
assert.equal(hostOfPlace({ kind: "ps" }, "C:\\dev\\app\\a.ts"), "C:/dev/app/a.ts");
assert.equal(hostOfPlace({ kind: "wsl", distro: null }, "/mnt/c/dev/app/a.ts"), "C:/dev/app/a.ts");
assert.equal(hostOfPlace({ kind: "wsl", distro: "Ubuntu" }, "/home/u/app/a.ts"), "//wsl.localhost/Ubuntu/home/u/app/a.ts");
assert.equal(hostOfPlace({ kind: "on", on: "box" }, "/srv/app/a.ts"), "/srv/app/a.ts");
assert.equal(hostOfPlace({ kind: "on", on: "win" }, "C:\\srv\\a.ts"), "C:/srv/a.ts");
assert.equal(hostOfPlace({ kind: "sh" }, "/work/app/a.ts"), "/work/app/a.ts");

// ---- tools -----------------------------------------------------------------------
assert.equal(toolOp("Read"), "read");
assert.equal(toolOp("Write"), "write");
for (const t of ["Edit", "MultiEdit", "NotebookEdit"]) assert.equal(toolOp(t), "edit");
assert.equal(toolOp("Bash"), null);
assert.equal(toolOp("constructor"), null);
assert.ok(isClaude({ app: "claude-code" }) && isClaude({ program: { key: "claude" } }) && !isClaude({ app: "pi" }));

// ---- parsing: mapping, bad lines, oversized lines ---------------------------------------
{
  const text = [
    line("Read", { file_path: "/work/app/r.ts" }, "2026-11-13T10:00:01Z"),
    line("Write", { file_path: "/work/app/new.ts", content: "x" }, "2026-11-13T10:00:02Z"),
    line("Edit", { file_path: "/work/app/e.ts", old_string: "a", new_string: "b" }, "2026-11-13T10:00:03Z"),
    line("MultiEdit", { file_path: "/work/app/m.ts", edits: [] }, "2026-11-13T10:00:04Z"),
    line("NotebookEdit", { notebook_path: "/work/app/n.ipynb" }, "2026-11-13T10:00:05Z"),
    line("Bash", { command: "rm -rf /" }),
    line("Edit", { file_path: "relative.ts" }),
    "{ this is not json \"tool_use\"\n",
    "\n",
    JSON.stringify({ type: "user", message: { content: "plain" } }) + "\n",
    line("Read", { file_path: "/work/app/" + "x".repeat(200) }),
  ].join("");
  const p = parseLines(text, (x) => x, 1000);
  assert.deepEqual(p.touches.map((t) => [t.path, t.op]), [
    ["/work/app/r.ts", "read"], ["/work/app/new.ts", "write"], ["/work/app/e.ts", "edit"], ["/work/app/m.ts", "edit"], ["/work/app/n.ipynb", "edit"],
    ["/work/app/" + "x".repeat(200), "read"],
  ]);
  assert.equal(p.bad, 1);
  assert.equal(p.touches[0].at, Date.parse("2026-11-13T10:00:01Z"));
  assert.equal(p.session, "11111111-2222-3333-4444-555555555555");
  // A line over the limit is skipped without being parsed.
  const big = line("Read", { file_path: "/work/app/big.ts", pad: "y".repeat(2000) });
  assert.deepEqual(parseLines(big, (x) => x, 1000), { touches: [], bad: 1, session: null });
}

// ---- reduction: one record per file, created flag, order ---------------------------------
{
  const files = reduce(new Map(), [
    { path: "/a", op: "write", at: 1 }, { path: "/b", op: "read", at: 2 }, { path: "/a", op: "edit", at: 5 },
    { path: "/c", op: "edit", at: 3 }, { path: "/c", op: "write", at: 4 }, { path: "/b", op: "read", at: 1 }, { path: "/d", op: "read", at: null },
  ]);
  assert.deepEqual(ordered(files), [
    { path: "/a", read: false, edited: true, created: true, lastAt: 5 },
    { path: "/c", read: false, edited: true, created: false, lastAt: 4 },
    { path: "/b", read: true, edited: false, created: false, lastAt: 2 },
    { path: "/d", read: true, edited: false, created: false, lastAt: null },
  ]);
  const capped = reduce(new Map(), Array.from({ length: 10 }, (_, i) => ({ path: `/f${i}`, op: "read", at: i })), 4);
  assert.deepEqual(ordered(capped).map((f) => f.path), ["/f9", "/f8", "/f7", "/f6"]);
}

// ---- incremental reads: complete lines only, oversized lines, plans ----------------------
{
  assert.deepEqual(takeLines("a\nb\npart", 8), { text: "a\nb\n", advance: 4, skipNext: false, bad: 0 });
  assert.deepEqual(takeLines("partial", 7), { text: "", advance: 0, skipNext: false, bad: 0 });
  // A chunk without a line end that filled the read: the line is too long, skipped to its end.
  assert.deepEqual(takeLines("xxxxxxxx", 8, false, 8), { text: "", advance: 8, skipNext: true, bad: 1 });
  assert.deepEqual(takeLines("tail\nnext\n", 10, true), { text: "next\n", advance: 10, skipNext: false, bad: 0 });
  assert.equal(takeLines("é\n", 3).advance, 3); // bytes, not characters
  assert.deepEqual(readPlan(null, 100), { start: 0, reset: true, partial: false });
  assert.deepEqual(readPlan(null, CHUNK + 10), { start: 10, reset: true, partial: true });
  assert.deepEqual(readPlan({ offset: 40 }, 100), { start: 40, reset: false, partial: false });
  assert.deepEqual(readPlan({ offset: 40 }, 20), { start: 0, reset: true, partial: false }); // truncated
}

// ---- choosing the log, and the ambiguity rule ------------------------------------------
{
  const logs = [{ path: "/p/old.jsonl", mtime: 1000 }, { path: "/p/aaa.jsonl", mtime: 5000 }, { path: "/p/bbb.jsonl", mtime: 9000 }];
  assert.deepEqual(chooseLog(logs), { log: logs[2], ambiguous: false });
  assert.deepEqual(chooseLog(logs, { others: 1 }), { log: logs[2], ambiguous: true });
  assert.deepEqual(chooseLog(logs, { session: "aaa", others: 1 }), { log: logs[1], ambiguous: false });
  assert.deepEqual(chooseLog(logs, { since: 20000 }), { log: null, ambiguous: false });
  assert.deepEqual(chooseLog(logs, { session: "zzz", since: 4000 }), { log: logs[2], ambiguous: false });
}

// ---- session ids from hook events, start times -------------------------------------------
noteSession("t9", { session_id: "abc-123" });
noteSession("t9", { session_id: "../../etc" }); // refused: not an id
assert.equal(sessionOf("t9"), "abc-123");
assert.equal(sessionOf("t0"), null);
assert.equal(startedAt({ created_at: 1700000000 }), 1700000000000);
assert.equal(startedAt({ started_at: "2026-11-13T10:00:00Z" }), Date.parse("2026-11-13T10:00:00Z"));
assert.equal(startedAt({}), null);

// ---- for real, on this machine: listing, reading, incremental parse, truncation ------------
const tmp = mkdtempSync(join(tmpdir(), "wm-sessionlog-"));
process.env.CLAUDE_CONFIG_DIR = tmp;
try {
  const cwd = "/work/my.app";
  const dir = join(tmp, "projects", "-work-my-app"); // the newer encoding only
  mkdirSync(dir, { recursive: true });
  const older = join(dir, "00000000-0000-0000-0000-000000000000.jsonl"), log = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
  writeFileSync(older, line("Read", { file_path: "/work/my.app/old.ts" }));
  utimesSync(older, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  writeFileSync(log, line("Read", { file_path: "/work/my.app/a.ts" }, "2026-11-13T10:00:01Z") + line("Write", { file_path: "/work/my.app/b.ts" }, "2026-11-13T10:00:02Z") + "{\"type\":\"tool_use\" not json\n");

  const listed = await listLogs({ kind: "sh", cwd });
  assert.deepEqual(listed.map((l) => l.path), [log, older]);
  assert.equal((await readLog({ kind: "sh" }, log, 0, 5)).text.length, 5);
  assert.equal(await readLog({ kind: "sh" }, join(dir, "gone.jsonl"), 0), null);

  forgetLogs();
  const agent = { address: "t1" };
  let now = 1e12;
  let r = await agentTouches(agent, { cwd, now, windows: false });
  assert.equal(r.log, log);
  assert.equal(r.ambiguous, false);
  assert.equal(r.bad, 1);
  assert.deepEqual(r.files.map((f) => [f.path, f.read, f.edited, f.created]), [["/work/my.app/b.ts", false, true, true], ["/work/my.app/a.ts", true, false, false]]);

  // Within EVERY_MS: the last result, no call.
  const calls = execCalls.length;
  assert.equal(await agentTouches(agent, { cwd, now: now + 1000, windows: false }), r);
  assert.equal(execCalls.length, calls);

  // Appended lines: only the new bytes are read.
  const before = (await readLog({ kind: "sh" }, log, 0)).size;
  appendFileSync(log, line("Edit", { file_path: "/work/my.app/a.ts" }, "2026-11-13T10:00:09Z"));
  const mark = execCalls.length;
  now += EVERY_MS;
  r = await agentTouches(agent, { cwd, now, windows: false });
  const reads = execCalls.slice(mark).filter((c) => c.args?.[1]?.includes("tail -c"));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].args[4], String(before)); // the offset: where the last read stopped
  assert.deepEqual(r.files.map((f) => [f.path, f.read, f.edited]), [["/work/my.app/a.ts", true, true], ["/work/my.app/b.ts", false, true]]);

  // A line still being written waits; once complete it's read.
  appendFileSync(log, line("Read", { file_path: "/work/my.app/c.ts" }, "2026-11-13T10:00:10Z").slice(0, 30));
  now += EVERY_MS;
  r = await agentTouches(agent, { cwd, now, windows: false });
  assert.equal(r.files.length, 2);

  // Truncated (or replaced by a shorter file): read again from the start.
  writeFileSync(log, line("Read", { file_path: "/work/my.app/z.ts" }, "2026-11-13T11:00:00Z"));
  now += EVERY_MS;
  r = await agentTouches(agent, { cwd, now, windows: false });
  assert.deepEqual(r.files.map((f) => f.path), ["/work/my.app/z.ts"]);

  // Two Claudes in the folder and no session id: the newest log, marked ambiguous. With the id the
  // hook reported, that session's log, not ambiguous.
  forgetLogs();
  r = await agentTouches({ address: "t2" }, { cwd, others: 1, now, windows: false });
  assert.equal(r.log, log); assert.equal(r.ambiguous, true);
  noteSession("t3", { session_id: "00000000-0000-0000-0000-000000000000" });
  r = await agentTouches({ address: "t3" }, { cwd, others: 1, now, windows: false });
  assert.equal(r.log, older); assert.equal(r.ambiguous, false);
  assert.deepEqual(r.files.map((f) => f.path), ["/work/my.app/old.ts"]);

  // The older slug encoding is found too.
  const old = join(tmp, "projects", "-work-my.app");
  mkdirSync(old);
  writeFileSync(join(old, "s.jsonl"), line("Edit", { file_path: "/work/my.app/o.ts" }));
  assert.ok((await listLogs({ kind: "sh", cwd })).some((l) => l.path === join(old, "s.jsonl")));

  // A log over one read: its last CHUNK only (partial), starting at a line boundary.
  forgetLogs();
  const bigDir = join(tmp, "projects", "-work-big");
  mkdirSync(bigDir);
  const pad = line("Read", { file_path: "/work/big/pad.ts", pad: "p".repeat(1000) });
  writeFileSync(join(bigDir, "b.jsonl"), pad.repeat(Math.ceil((CHUNK + 50000) / pad.length)) + line("Edit", { file_path: "/work/big/last.ts" }, "2026-11-13T12:00:00Z"));
  r = await agentTouches({ address: "t4" }, { cwd: "/work/big", now, windows: false });
  assert.equal(r.partial, true);
  assert.equal(r.bad, 0);
  assert.deepEqual(r.files.map((f) => f.path), ["/work/big/last.ts", "/work/big/pad.ts"]);

  // The setting off: nothing is read at all.
  forgetLogs();
  const n = execCalls.length;
  assert.equal(await agentTouches({ address: "t5" }, { cwd, enabled: false, now, windows: false }), null);
  assert.equal(execCalls.length, n);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("sessionlog ok");
