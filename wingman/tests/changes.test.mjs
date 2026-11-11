import { parseStatus, statusLetter, reviewTag, discardCommands, inHeadArgs, inHeadOf, commitCommands, pathspecText, NUMSTAT, parseNumstat, countLines, STATUS, STATUS_V2, parseStatusV2, onDisk } from "../mods/wingman/changes.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
assert.deepEqual(parseStatus(" M a.js\0?? dir/b c.js\0D  gone.txt\0"), [{ xy: " M", rel: "a.js" }, { xy: "??", rel: "dir/b c.js" }, { xy: "D ", rel: "gone.txt" }]);
assert.equal(statusLetter("??"), "A"); assert.equal(statusLetter("A "), "A"); assert.equal(statusLetter(" D"), "D"); assert.equal(statusLetter("UU"), "!"); assert.equal(statusLetter("MM"), "M");
assert.equal(reviewTag("r|a", { "r|a": 2 }), "2 to review"); assert.equal(reviewTag("r|a", { "r|a": 0 }), "reviewed"); assert.equal(reviewTag("r|b", { "r|a": 0 }), null); assert.equal(reviewTag("r|b", null), null);
assert.throws(() => commitCommands([], "x", "f")); assert.throws(() => commitCommands(["a"], "  ", "f"));
// Against a real repo: commit only checked paths, keep other staged files staged, discard both kinds.
const d = mkdtempSync(tmpdir() + "/wm-"), git = (...a) => execFileSync("git", a, { cwd: d, encoding: "utf8" });
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
writeFileSync(d + "/a.txt", "1\n"); writeFileSync(d + "/b.txt", "1\n"); git("add", "."); git("commit", "-qm", "init");
writeFileSync(d + "/a.txt", "2\n"); writeFileSync(d + "/b.txt", "2\n"); git("add", "b.txt"); writeFileSync(d + "/new.txt", "n\n"); rmSync(d + "/a.txt");
const st = parseStatus(git(...["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]));
assert.deepEqual(st.map((s) => s.rel).sort(), ["a.txt", "b.txt", "new.txt"]);
writeFileSync(d + "/.git/spec", pathspecText(["a.txt", "new.txt"]));
for (const c of commitCommands(["a.txt", "new.txt"], "two files\n\nbody", d + "/.git/spec")) git(...c);
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

// Porcelain v2 (another machine's one-call status): HEAD and the same files and letters as v1.
assert.deepEqual(parseStatusV2("# branch.oid (initial)\0# branch.head main\0? new file.txt\0"), { head: null, list: [{ xy: "??", rel: "new file.txt" }] });
assert.deepEqual(parseStatusV2("# branch.oid abc123\0" + "1 .M N... 100644 100644 100644 aa bb a b.js\0" + "2 R. N... 100644 100644 100644 aa bb R100 to.js\0from.js\0" + "u UU N... 100644 100644 100644 100644 aa bb cc c.js\0! ignored\0").list,
  [{ xy: " M", rel: "a b.js" }, { xy: "R ", rel: "to.js" }, { xy: "UU", rel: "c.js" }]);
assert.deepEqual(onDisk([{ xy: " M", rel: "a" }, { xy: " D", rel: "b" }, { xy: "D ", rel: "c" }, { xy: "??", rel: "d" }, { xy: "AD", rel: "e" }]), ["a", "d"]);
{
  const v = mkdtempSync(tmpdir() + "/wm-v2-"), vg = (...a) => execFileSync("git", a, { cwd: v, encoding: "utf8" });
  vg("init", "-q"); vg("config", "user.email", "t@t"); vg("config", "user.name", "t");
  assert.equal(parseStatusV2(vg(...STATUS_V2)).head, null);
  for (const n of ["keep.txt", "mod.txt", "gone.txt", "staged gone.txt", "both.txt"]) writeFileSync(`${v}/${n}`, "1\n");
  vg("add", "."); vg("commit", "-qm", "c1");
  writeFileSync(`${v}/mod.txt`, "2\n"); rmSync(`${v}/gone.txt`); vg("rm", "-q", "staged gone.txt");
  writeFileSync(`${v}/both.txt`, "2\n"); vg("add", "both.txt"); writeFileSync(`${v}/both.txt`, "3\n");
  writeFileSync(`${v}/new one.txt`, "x\n"); writeFileSync(`${v}/added.txt`, "x\n"); vg("add", "added.txt");
  const v2 = parseStatusV2(vg(...STATUS_V2)), sorted = (l) => [...l].sort((a, b) => a.rel.localeCompare(b.rel));
  assert.equal(v2.head, vg("rev-parse", "HEAD").trim());
  assert.deepEqual(sorted(v2.list), sorted(parseStatus(vg(...STATUS))));
  assert.equal(v2.list.length, 6);
  // The files on disk hash fine (what another machine's refresh compares).
  vg("hash-object", "--no-filters", "--", ...onDisk(v2.list));
  rmSync(v, { recursive: true, force: true });
}
// inHeadArgs/inHeadOf: whether HEAD has a path, read literally (a glob-like name matches only itself);
// a failed call throws rather than read as "not in HEAD" (a discard would then untrack and delete it).
{
  const h = mkdtempSync(tmpdir() + "/wm-inhead-"), hg = (...a) => execFileSync("git", a, { cwd: h, encoding: "utf8" });
  const run = (rel) => { try { return { code: 0, stdout: hg(...inHeadArgs(rel)) }; } catch (e) { return { code: e.status ?? 1, stdout: "", stderr: String(e.stderr ?? "") }; } };
  hg("init", "-q"); hg("config", "user.email", "t@t"); hg("config", "user.name", "t");
  for (const n of ["a[b]", "ab", "d/f"]) { if (n.includes("/")) execFileSync("mkdir", ["-p", h + "/d"]); writeFileSync(`${h}/${n}`, "x\n"); }
  hg("add", "-A"); hg("commit", "-qm", "i");
  writeFileSync(h + "/new", "n\n"); hg("add", "new");
  assert.equal(inHeadOf(run("a[b]"), "a[b]"), true);
  assert.equal(inHeadOf(run("d/f"), "d/f"), true);
  assert.equal(inHeadOf(run("new"), "new"), false, "staged, not in HEAD");
  assert.equal(inHeadOf(run("a?b"), "a?b"), false, "no glob match of a[b]/ab");
  assert.equal(inHeadOf(run("*"), "*"), false);
  assert.throws(() => inHeadOf({ code: 128, stdout: "", stderr: "fatal: index.lock" }, "ab"), /ls-tree/);
  assert.throws(() => inHeadOf(undefined, "ab"));
  rmSync(h, { recursive: true, force: true });
}
console.log("changes tests pass");
