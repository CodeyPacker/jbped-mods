// The Claude hook's journal on another machine (the shim runs machine "vps" here): the real hook
// script writes two events, drainOn applies them in order to the repo's review there and removes
// them, and feedback for that machine's terminal is written where the hook reads it, then withdrawn.
import { Journal, queueFeedback, withdrawFeedback, hookKnown } from "../mods/wingman/journal.js";
import { remoteCalls } from "herdr";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const on = "vps", dir = mkdtempSync(`${tmpdir()}/rjournal-`);
const hookScript = fileURLToPath(new URL("../mods/wingman/hooks/wingman-hook.sh", import.meta.url));
const repo = `${dir}/repo`, data = `${dir}/data`, home = `${dir}/home`;
const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
// The hook as Claude runs it in a terminal there: its input on stdin, Herdr's terminal id in the env.
const hook = (arg, input, env = {}) => execFileSync("sh", [hookScript, arg], {
  input, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, HC_TERMINAL_ID: "t7", HERDR_WINGMAN_DIR: data, ...env },
});
const logs = [];
try {
  mkdirSync(repo); mkdirSync(home);
  g("init", "-q", "-b", "main");
  writeFileSync(`${repo}/a.txt`, "one\ntwo\n");
  g("add", "."); g("commit", "-qm", "1");

  // No data folder: the hook does nothing, and the journal says it isn't installed.
  hook("post", "{}");
  assert.ok(!existsSync(data));
  const j = new Journal((m) => logs.push(m));
  assert.deepEqual(await j.drainOn(on, { dataDir: data }), { installed: false, adopted: 0, events: 0 });
  assert.equal(hookKnown(on), false);
  await assert.rejects(queueFeedback("vps/t7", "x", { on, dataDir: data }), /isn't installed on vps/);

  // Two edits of a.txt: the first event's originalFile is the baseline.
  mkdirSync(data);
  const ev = (original, now) => JSON.stringify({ session_id: "s", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Edit",
    tool_input: { file_path: `${repo}/a.txt`, old_string: "x", new_string: "y" }, tool_response: { filePath: `${repo}/a.txt`, originalFile: original, type: "update" } }, null, 2);
  writeFileSync(`${repo}/a.txt`, "one\nTWO\n"); assert.equal(hook("post", ev("one\ntwo\n")), "");
  writeFileSync(`${repo}/a.txt`, "one\nTWO\nthree\n"); hook("post", ev("one\nTWO\n"));
  const names = readdirSync(`${data}/events`).sort();
  assert.equal(names.length, 2);
  assert.match(names[0], /^\d+-t7-\d+\.json$/);
  assert.equal(JSON.parse(readFileSync(`${data}/events/${names[0]}`, "utf8")).terminal, "t7");

  remoteCalls.length = 0;
  const r = await j.drainOn(on, { dataDir: data });
  assert.deepEqual(r, { installed: true, adopted: 1, events: 2 });
  assert.equal(hookKnown(on), true);
  assert.ok(remoteCalls.length > 0 && remoteCalls.every((c) => c.on === on));
  assert.deepEqual(readdirSync(`${data}/events`), []); // processed: removed there
  const index = JSON.parse(readFileSync(`${repo}/.git/wingman/index.json`, "utf8"));
  const e = index.files["a.txt"];
  assert.equal(e.by, "vps/t7"); // Herdr's address for the terminal there
  assert.equal(e.as, `${repo}/a.txt`); // the machine's own path, never converted
  assert.equal(e.branch, "main");
  assert.match(e.head, /^[0-9a-f]{40}$/);
  assert.equal(readFileSync(`${repo}/.git/wingman/baselines/${e.baseline}`, "utf8"), "one\ntwo\n");
  assert.equal(readdirSync(`${repo}/.git/wingman/baselines`).length, 1);

  // Capture took a file first (no `by`): the journal adds `by`, keeping capture's baseline.
  writeFileSync(`${repo}/b.txt`, "b2\n");
  index.files["b.txt"] = { baseline: "cap.txt", created: false, branch: "main" };
  writeFileSync(`${repo}/.git/wingman/baselines/cap.txt`, "b1\n");
  writeFileSync(`${repo}/.git/wingman/index.json`, JSON.stringify(index, null, 2) + "\n");
  hook("post", JSON.stringify({ cwd: repo, tool_name: "Write", tool_input: { file_path: `${repo}/b.txt` }, tool_response: { originalFile: "b0\n", type: "update" } }));
  assert.equal((await j.drainOn(on, { dataDir: data })).adopted, 0);
  const b = JSON.parse(readFileSync(`${repo}/.git/wingman/index.json`, "utf8")).files["b.txt"];
  assert.equal(b.baseline, "cap.txt"); assert.equal(b.by, "vps/t7");

  // A broken event is dropped, the next one still applies.
  writeFileSync(`${data}/events/0000000000000000001-t7-1.json`, "{ not json");
  assert.equal((await j.drainOn(on, { dataDir: data })).events, 1);
  assert.deepEqual(readdirSync(`${data}/events`), []);

  // Feedback for "vps/t7" goes to the folder there under the hook's own id, and the hook hands it to Claude.
  await queueFeedback("vps/t7", "Code review: rejected line 2", { on, dataDir: data });
  await queueFeedback("vps/t7", "Code review: rejected line 3", { on, dataDir: data });
  assert.equal(JSON.parse(readFileSync(`${data}/feedback/t7.ctx`, "utf8")), "Code review: rejected line 2\nCode review: rejected line 3");
  // An undone rejection takes its note back; the last one removes the file.
  assert.equal(await withdrawFeedback("vps/t7", "Code review: rejected line 3", { on, dataDir: data }), true);
  assert.equal(JSON.parse(readFileSync(`${data}/feedback/t7.ctx`, "utf8")), "Code review: rejected line 2");
  assert.equal(await withdrawFeedback("vps/t7", "not queued", { on, dataDir: data }), false);
  const out = JSON.parse(hook("prompt", "{}"));
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Code review: rejected line 2" } });
  assert.ok(!existsSync(`${data}/feedback/t7.ctx`));
  await queueFeedback("vps/t7", "again", { on, dataDir: data });
  assert.equal(await withdrawFeedback("vps/t7", "again", { on, dataDir: data }), true);
  assert.ok(!existsSync(`${data}/feedback/t7.ctx`));

  // In a WSL machine's terminal (HC_TERMINAL_SOCKET set), a HERDR_WINGMAN_DIR from Windows through
  // WSLENV is ignored: the machine's own folder is used. Without the socket (this PC's own WSL
  // terminals) it is used, as before.
  const own = `${home}/.config/herdr-app/data/wingman`;
  mkdirSync(own, { recursive: true });
  hook("post", "{}", { HC_TERMINAL_SOCKET: "/run/user/1/herdr-core/default.sock", WSLENV: "HC_TERMINAL_ID:HERDR_WINGMAN_DIR/p" });
  assert.equal(readdirSync(`${own}/events`).length, 1);
  assert.deepEqual(readdirSync(`${data}/events`), []);
  hook("post", "{}", { WSLENV: "HC_TERMINAL_ID:HERDR_WINGMAN_DIR/p" });
  assert.equal(readdirSync(`${data}/events`).length, 1);
  hook("post", "{}", { HC_TERMINAL_SOCKET: "/run/x.sock" }); // set on that side by hand: used
  assert.equal(readdirSync(`${data}/events`).length, 2);
} finally { rmSync(dir, { recursive: true, force: true }); }
