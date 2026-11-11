import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unifiedDiff } from "../mods/wayfinder/providers/diff.js";

const dir = mkdtempSync(join(tmpdir(), "wayfinder-diff-"));
const numbered = (n, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}\n`).join("");

// git's own hunks for the two texts, without the "diff --git" header and the function context after "@@".
function gitPatch(name, a, b) {
  const pa = join(dir, `${name}.a`), pb = join(dir, `${name}.b`);
  writeFileSync(pa, a); writeFileSync(pb, b);
  const r = spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "--diff-algorithm=myers", "-U3", pa, pb], { encoding: "utf8" });
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  const at = r.stdout.indexOf("\n@@");
  if (at < 0) return "";
  return r.stdout.slice(at + 1).replace(/\n$/, "").replace(/^(@@ -\S+ \+\S+ @@).*$/gm, "$1");
}

const lines20 = numbered(20);
const fixtures = {
  insert: [lines20, lines20.replace("line 10\n", "line 10\nnew A\nnew B\n")],
  delete: [lines20, lines20.replace("line 7\nline 8\n", "")],
  middle: [lines20, lines20.replace("line 11\n", "changed 11\n")],
  ends: [lines20, lines20.replace("line 1\n", "first\n").replace("line 20\n", "last\n")],
  identical: [lines20, lines20],
  noNewline: ["a\nb\nc", "a\nb\nC"],
  addNewline: ["a\nb\nc", "a\nb\nc\n"],
  fromEmpty: ["", "x\ny\n"],
  toEmpty: ["x\ny\n", ""],
  twoHunks: [numbered(30), numbered(30).replace("line 3\n", "three\n").replace("line 25\n", "twenty-five\n")],
  oneLine: ["a\n", "b\n"],
};

for (const [name, [a, b]] of Object.entries(fixtures)) {
  test(`unifiedDiff matches git diff: ${name}`, () => {
    const d = unifiedDiff(a, b);
    assert.equal(d.patch, gitPatch(name, a, b));
    assert.equal(d.truncated, false);
    assert.equal(d.additions, (d.patch.match(/^\+/gm) ?? []).length);
    assert.equal(d.deletions, (d.patch.match(/^-/gm) ?? []).length);
  });
}

test("unifiedDiff: the brief's example, identical files, and the size cap", () => {
  assert.equal(unifiedDiff("a\nb\nc\n", "a\nB\nc\n").patch, "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
  assert.deepEqual(unifiedDiff("x\n", "x\n"), { patch: "", additions: 0, deletions: 0, truncated: false });
  assert.deepEqual(unifiedDiff(numbered(11), numbered(4), { maxLines: 10 }), { patch: null, additions: 4, deletions: 11, truncated: true });
  assert.equal(unifiedDiff("a\nb\n", "a\nc\n", { context: 0 }).patch, "@@ -2 +2 @@\n-b\n+c");
});
