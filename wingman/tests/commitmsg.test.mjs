// G6: Generate commit message: the prompt (style from recent subjects, every file listed before the
// diff, the diff cut to fit), and the answer cleaned into a draft.
import { buildPrompt, cleanMessage, parseSubjects, newFileDiff, fileList, MAX_MESSAGE, SUBJECT_ARGS } from "../mods/wingman/commitmsg.js";
import { MAX_PROMPT } from "../mods/wingman/inlineedit.js";
import assert from "node:assert/strict";

const files = [{ rel: "src/a.js", letter: "M", add: 3, del: 1 }, { rel: "img.png", letter: "A", binary: true }, { rel: "new.txt", letter: "A", add: 2, del: 0 }];
const subjects = parseSubjects("wingman: one\nwingman: two\x1b[31m\n\n" + Array.from({ length: 20 }, (_, i) => `s${i}`).join("\n"));
assert.equal(subjects.length, 10); assert.equal(subjects[1], "wingman: two[31m");
assert.deepEqual(SUBJECT_ARGS.slice(0, 2), ["log", "-10"]);
assert.deepEqual(fileList(files), ["M  +3 -1  src/a.js", "A  binary  img.png", "A  +2 -0  new.txt"]);
assert.equal(newFileDiff("n.txt", "a\r\nb\r\n"), "diff --git a/n.txt b/n.txt\nnew file\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");

// Small: everything fits.
{
  const p = buildPrompt({ repo: "herdr-mods", files, diff: "diff --git a/src/a.js b/src/a.js\n+x\n", subjects });
  assert.match(p, /Recent commit subjects here \(match their style\):\n- wingman: one\n/);
  assert.match(p, /Files \(3\):\nM  \+3 -1  src\/a\.js\nA  binary  img\.png\nA  \+2 -0  new\.txt\n/);
  assert.match(p, /~~~~~~~~ diff ~~~~~~~~\ndiff --git a\/src\/a\.js b\/src\/a\.js\n\+x\n~~~~~~~~ end of diff ~~~~~~~~\n$/);
  assert.ok(!p.includes("was cut"));
  assert.match(buildPrompt({ repo: "r", files, diff: "", subjects: [] }), /\(no earlier commits\)/);
}
// Big: the prompt stays under the cap, every file is still listed, the diff is cut at a line end.
{
  const many = Array.from({ length: 300 }, (_, i) => ({ rel: `dir/file${i}.js`, letter: "M", add: i, del: 1 }));
  const diff = many.map((f) => `diff --git a/${f.rel} b/${f.rel}\n` + "+line of code here\n".repeat(50)).join("");
  const p = buildPrompt({ repo: "r", files: many, diff, subjects });
  assert.ok(p.length <= MAX_PROMPT, `${p.length}`);
  for (const f of many) assert.ok(p.includes(`  ${f.rel}\n`), f.rel);
  assert.match(p, /\(the diff was cut here: \d+ more characters not shown\)\n$/);
  const body = p.slice(p.indexOf("~~~~~~~~ diff ~~~~~~~~\n") + 23, p.indexOf("~~~~~~~~ end of diff"));
  assert.ok(body.endsWith("\n") && body.length > 1000);
  // So many files that the list itself is capped: a count says how many more.
  const lots = Array.from({ length: 2000 }, (_, i) => ({ rel: `d/f${i}.js`, letter: "M", add: 1, del: 1 }));
  const q = buildPrompt({ repo: "r", files: lots, diff: "x\n".repeat(20000), subjects });
  assert.ok(q.length <= MAX_PROMPT); assert.match(q, /… and \d+ more files\n/); assert.match(q, /Files \(2000\):/);
}
// Cleaning: fences, quotes, CRLF, control characters, blank ends, the cap.
assert.equal(cleanMessage("```\nwingman: add sync\n\nBody line.\n```\n"), "wingman: add sync\n\nBody line.");
assert.equal(cleanMessage("```text\nfix: x\n```"), "fix: x");
assert.equal(cleanMessage("\n\n\"fix: quoted\"\n"), "fix: quoted");
assert.equal(cleanMessage("a\r\nb\x1b[0m\x07  \r\n"), "a\nb[0m");
assert.equal(cleanMessage("  \n ``` \n"), null);
assert.equal(cleanMessage(""), null);
const long = cleanMessage("subject\n\n" + "word ".repeat(1000));
assert.ok(long.length <= MAX_MESSAGE && long.startsWith("subject\n\nword") && !long.endsWith(" "));
