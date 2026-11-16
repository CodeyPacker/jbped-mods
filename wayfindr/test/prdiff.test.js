import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePrDiff, diffRows, longestLine, unquotePath, MAX_PATCH } from "../mods/wayfindr/prdiff.js";
import { PRDIFF_SH } from "../mods/wayfindr/launch.js";
import { loadLocalPrDiff } from "../mods/wayfindr/flow.js";

const out = [
  "--wayfindr status", "M\tsrc/a.js", "A\tnew.txt", "D\tgone.txt", "M\tlogo.png", "T\tlink", "M\t\"sp\\303\\251c ial.txt\"",
  "--wayfindr numstat", "1\t1\tsrc/a.js", "2\t0\tnew.txt", "0\t1\tgone.txt", "-\t-\tlogo.png", "0\t0\tlink", "1\t0\t\"sp\\303\\251c ial.txt\"",
  "--wayfindr patch",
  "diff --git a/src/a.js b/src/a.js", "index 1..2 100644", "--- a/src/a.js", "+++ b/src/a.js", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c",
  "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+x", "+y",
  "diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-z", "\\ No newline at end of file",
  "diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ",
  "diff --git a/link b/link", "old mode 100644", "new mode 100755",
  "diff --git \"a/sp\\303\\251c ial.txt\" \"b/sp\\303\\251c ial.txt\"", "--- x", "+++ y", "@@ -1 +1,2 @@", " k", "+l", "",
].join("\n");

test("parsePrDiff pairs the three sections into contract files", () => {
  const { files, truncated } = parsePrDiff(out);
  assert.equal(truncated, false);
  assert.deepEqual(files, [
    { path: "src/a.js", oldPath: null, status: "modified", additions: 1, deletions: 1, patch: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c", binary: false },
    { path: "new.txt", oldPath: null, status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+x\n+y", binary: false },
    { path: "gone.txt", oldPath: null, status: "deleted", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-z\n\\ No newline at end of file", binary: false },
    { path: "logo.png", oldPath: null, status: "modified", additions: 0, deletions: 0, patch: null, binary: true },
    { path: "link", oldPath: null, status: "modified", additions: 0, deletions: 0, patch: null, binary: false },
    { path: "spéc ial.txt", oldPath: null, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n k\n+l", binary: false },
  ]);
});

test("parsePrDiff cuts a patch over the limit at its last full line", () => {
  const body = Array.from({ length: 50000 }, (_, i) => `+line ${i}`).join("\n");
  const s = ["--wayfindr status", "A\tbig.txt", "--wayfindr numstat", "50000\t0\tbig.txt", "--wayfindr patch",
    "diff --git a/big.txt b/big.txt", "@@ -0,0 +1,50000 @@", body, ""].join("\n");
  const { files, truncated } = parsePrDiff(s);
  assert.equal(truncated, true);
  assert.ok(files[0].patch.length <= MAX_PATCH);
  assert.match(files[0].patch, /\n\+line \d+$/);
  assert.equal(files[0].additions, 50000);
});

test("parsePrDiff of empty output is no files", () => {
  assert.deepEqual(parsePrDiff("--wayfindr status\n--wayfindr numstat\n--wayfindr patch\n"), { files: [], truncated: false, head: null });
});

test("parsePrDiff reads the head section after the patch, which keeps its last file whole", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const { files, head } = parsePrDiff(`${out}--wayfindr head\n${sha}\n`);
  assert.equal(head, sha);
  assert.equal(files.at(-1).patch, "@@ -1 +1,2 @@\n k\n+l");
  assert.equal(parsePrDiff(`${out}--wayfindr head\nfatal: bad ref\n`).head, null);
});

test("unquotePath decodes git's C-style quoting", () => {
  assert.equal(unquotePath("plain.txt"), "plain.txt");
  assert.equal(unquotePath('"a\\tb\\"c\\\\d"'), 'a\tb"c\\d');
  assert.equal(unquotePath('"\\303\\251"'), "é");
});

test("diffRows numbers rows like Tourist's: new line for + and space, old line for -", () => {
  const rows = diffRows("@@ -10,3 +20,4 @@ fn\n a\n-b\n+B\n+C\n c\n\\ No newline at end of file\n@@ -50 +60 @@\n-x\n+y\n");
  assert.deepEqual(rows, [
    { kind: "@", text: "@@ -10,3 +20,4 @@ fn" },
    { kind: " ", number: 20, text: "a" },
    { kind: "-", number: 11, text: "b" },
    { kind: "+", number: 21, text: "B" },
    { kind: "+", number: 22, text: "C" },
    { kind: " ", number: 23, text: "c" },
    { kind: "", text: "\\ No newline at end of file" },
    { kind: "@", text: "@@ -50 +60 @@" },
    { kind: "-", number: 50, text: "x" },
    { kind: "+", number: 60, text: "y" },
  ]);
  assert.deepEqual(diffRows("no hunks"), []);
  assert.deepEqual(diffRows(null), []);
  assert.equal(diffRows("@@ -1 +1 @@\n+")[1].text, " ");
});

test("longestLine counts tabs as four spaces", () => {
  assert.equal(longestLine([{ text: "ab" }, { text: "\tx" }]), 5);
  assert.equal(longestLine([]), 0);
});

test("PRDIFF_SH prints the four sections and checks nothing out", () => {
  for (const name of ["status", "numstat", "patch", "head"]) assert.ok(PRDIFF_SH.includes(`--wayfindr ${name}`));
  assert.ok(!PRDIFF_SH.includes("checkout"));
  assert.ok(PRDIFF_SH.includes('"+refs/heads/$2:refs/wayfindr/pr-$4"'));
});

// The real script against real git, in a throwaway HOME.
const sh = (cmd, cwd, env) => spawnSync("sh", ["-c", cmd], { cwd, env, encoding: "utf8" });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "wf-prdiff-"));
  const env = { ...process.env, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const r = sh([
    "git init -q --bare -b main origin.git && git clone -q origin.git clone 2>/dev/null && cd clone && git checkout -q -b main",
    "printf 'a\\nb\\nc\\n' > a.txt && printf 'old\\n' > gone.txt && git add . && git commit -q -m one && git push -q origin main",
    "git checkout -q -b feat && printf 'a\\nB\\nc\\n' > a.txt && git rm -q gone.txt && printf 'n\\n' > new.txt && git add . && git commit -q -m two && git push -q origin feat",
    "git checkout -q main && printf 'later\\n' > main.txt && git add . && git commit -q -m three && git push -q origin main && git reset -q --hard HEAD~1",
  ].join(" && "), home, env);
  assert.equal(r.status, 0, r.stderr);
  const io = { run: async (cmd, args) => { const p = spawnSync(cmd, args, { env, encoding: "utf8" }); return { code: p.status, stdout: p.stdout, stderr: p.stderr }; } };
  return { io, env, clone: join(home, "clone") };
}

test("loadLocalPrDiff diffs the PR branch from its merge base, leaving the clone's checkout alone", async () => {
  const { io, env, clone } = fixture();
  const before = sh("git rev-parse HEAD && git status --porcelain", clone, env).stdout;
  const { files, truncated, head } = await loadLocalPrDiff(clone, "feat", "main", 7, io);
  assert.equal(truncated, false);
  assert.equal(head, sh("git rev-parse refs/wayfindr/pr-7", clone, env).stdout.trim());
  assert.equal(head, sh("git rev-parse origin/feat", clone, env).stdout.trim());
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions]), [["a.txt", "modified", 1, 1], ["gone.txt", "deleted", 0, 1], ["new.txt", "added", 1, 0]]);
  assert.equal(files[0].patch, "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
  assert.ok(!files.some((f) => f.path === "main.txt")); // the target's later commit isn't in the PR's diff
  assert.equal(sh("git rev-parse HEAD && git status --porcelain", clone, env).stdout, before);
  assert.equal(sh("git rev-parse --verify -q refs/wayfindr/pr-7 >/dev/null && echo ok", clone, env).stdout.trim(), "ok");
});

test("loadLocalPrDiff rejects with a message when the branch isn't on origin, or the number isn't one", async () => {
  const { io, clone } = fixture();
  await assert.rejects(loadLocalPrDiff(clone, "nope", "main", 7, io), /git fetch of nope and main failed/);
  await assert.rejects(loadLocalPrDiff(clone, "feat", "main", "7;x", io), /not a pull request number/);
});
