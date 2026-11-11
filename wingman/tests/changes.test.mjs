import { parseStatus, statusLetter, reviewTag, discardCommands, commitCommands, NUMSTAT, parseNumstat, countLines } from "../mods/wingman/changes.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
assert.deepEqual(parseStatus(" M a.js\0?? dir/b c.js\0D  gone.txt\0"), [{ xy: " M", rel: "a.js" }, { xy: "??", rel: "dir/b c.js" }, { xy: "D ", rel: "gone.txt" }]);
assert.equal(statusLetter("??"), "A"); assert.equal(statusLetter("A "), "A"); assert.equal(statusLetter(" D"), "D"); assert.equal(statusLetter("UU"), "!"); assert.equal(statusLetter("MM"), "M");
assert.equal(reviewTag("r|a", { "r|a": 2 }), "2 to review"); assert.equal(reviewTag("r|a", { "r|a": 0 }), "reviewed"); assert.equal(reviewTag("r|b", { "r|a": 0 }), null); assert.equal(reviewTag("r|b", null), null);
assert.throws(() => commitCommands([], "x")); assert.throws(() => commitCommands(["a"], "  "));
// Against a real repo: commit only checked paths, keep other staged files staged, discard both kinds.
const d = mkdtempSync(tmpdir() + "/wm-"), git = (...a) => execFileSync("git", a, { cwd: d, encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
writeFileSync(d + "/a.txt", "1\n"); writeFileSync(d + "/b.txt", "1\n"); git("add", "."); git("commit", "-qm", "init");
writeFileSync(d + "/a.txt", "2\n"); writeFileSync(d + "/b.txt", "2\n"); git("add", "b.txt"); writeFileSync(d + "/new.txt", "n\n"); rmSync(d + "/a.txt");
const st = parseStatus(git(...["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]));
assert.deepEqual(st.map((s) => s.rel).sort(), ["a.txt", "b.txt", "new.txt"]);
for (const c of commitCommands(["a.txt", "new.txt"], "two files\n\nbody")) git(...c);
assert.equal(git("log", "-1", "--format=%B").trim(), "two files\n\nbody");
assert.deepEqual(git("show", "--name-status", "--format=", "HEAD").trim().split("\n").sort(), ["A\tnew.txt", "D\ta.txt"]);
assert.equal(git("diff", "--cached", "--name-only").trim(), "b.txt"); // still staged, not committed
writeFileSync(d + "/new.txt", "changed\n"); writeFileSync(d + "/u.txt", "u\n"); writeFileSync(d + "/s.txt", "s\n"); git("add", "s.txt");
for (const c of discardCommands("new.txt", true)) git(...c);
for (const c of discardCommands("u.txt", false)) git(...c);
for (const c of discardCommands("s.txt", false)) git(...c);
for (const c of discardCommands("b.txt", true)) git(...c);
assert.equal(readFileSync(d + "/new.txt", "utf8"), "n\n"); assert.ok(!existsSync(d + "/u.txt")); assert.ok(!existsSync(d + "/s.txt"));
assert.equal(git("status", "--porcelain").trim(), "");
rmSync(d, { recursive: true, force: true });
// parseNumstat: normal, binary, a tab in the path, two outputs merged.
assert.deepEqual(parseNumstat("3\t1\ta.js\0-\t-\timg.png\0"), new Map([["a.js", { add: 3, del: 1, binary: false }], ["img.png", { add: 0, del: 0, binary: true }]]));
assert.deepEqual(parseNumstat("1\t2\tdir/x\ty z.txt\0"), new Map([["dir/x\ty z.txt", { add: 1, del: 2, binary: false }]]));
assert.deepEqual(parseNumstat("1\t0\ta.js\0", "2\t1\ta.js\0-\t-\tb.bin\0").get("a.js"), { add: 3, del: 1, binary: false });
assert.equal(parseNumstat("1\t0\ta.js\0", "2\t1\ta.js\0-\t-\tb.bin\0").get("b.bin").binary, true);
assert.equal(parseNumstat("").size, 0);
// countLines
assert.equal(countLines("a\nb\n"), 2); assert.equal(countLines("a\nb"), 2); assert.equal(countLines(""), 0); assert.equal(countLines("\n\n"), 2);
// Real git: NUMSTAT against HEAD counts a modified tracked file.
const r = mkdtempSync(tmpdir() + "/wm-num-"), rg = (...a) => execFileSync("git", a, { cwd: r, encoding: "utf8" });
rg("init", "-q"); rg("config", "user.email", "t@t"); rg("config", "user.name", "t");
writeFileSync(r + "/f.txt", "1\n2\n3\n"); rg("add", "."); rg("commit", "-qm", "init");
writeFileSync(r + "/f.txt", "1\nX\n3\n4\n");
assert.deepEqual(parseNumstat(rg(...NUMSTAT)).get("f.txt"), { add: 2, del: 1, binary: false });
rmSync(r, { recursive: true, force: true });
console.log("changes tests pass");
