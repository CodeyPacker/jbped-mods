// An inline edit's answer as a pending review change: the file is written, journal.postEdit leaves
// an event like the Claude hook's, and the leader's Journal.drain puts the file under review with
// the old text as its baseline, in the asking space. Real repos.
import { Store, swap, shows } from "../mods/wingman/store.js";
import { Journal, postEdit, reviewDir } from "../mods/wingman/journal.js";
import { replaceLines, cleanAnswer, relocate, target } from "../mods/wingman/inlineedit.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const made = [];
function repo(files) {
  const dir = mkdtempSync(`${tmpdir()}/ie-`);
  made.push(dir);
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) writeFileSync(`${dir}/${rel}`, text);
  g("add", "."); g("commit", "-qm", "c");
  return dir;
}
const index = (st) => JSON.parse(readFileSync(`${st.dir}/index.json`, "utf8")).files;
const events = () => (existsSync(`${reviewDir()}/events`) ? readdirSync(`${reviewDir()}/events`) : []);

try {
  // 1. A file with no changes, CRLF, unsaved edits elsewhere in the buffer: the baseline is the
  //    buffer before the edit (unsaved edits included), the file gets the buffer after it.
  {
    const disk = "a\r\nb\r\nc\r\nd\r\n", dir = repo({ "f.txt": disk });
    const buffer = "a\r\nb\r\nc\r\nd (my unsaved edit)\r\n";
    const t = relocate(buffer, target(buffer, 1, 2));
    const next = replaceLines(buffer, t.a, t.b, cleanAnswer("```\nB1\nB2\nB3\n```"));
    assert.equal(next, "a\r\nB1\r\nB2\r\nB3\r\nd (my unsaved edit)\r\n");
    await swap(`${dir}/f.txt`, disk, next);
    await postEdit({ path: `${dir}/f.txt`, original: buffer, space: "s1" });
    assert.equal(events().length, 1);
    await new Journal(() => {}).drain();
    assert.equal(events().length, 0); // applied and removed
    const st = await Store.open(dir), e = index(st)["f.txt"];
    assert.ok(e, "the file is under review");
    assert.equal(e.space, "s1"); assert.equal(e.by, null); assert.equal(e.branch, "main"); assert.equal(e.created, false);
    const f = await st.load("f.txt", e);
    assert.equal(f.Btext, buffer); assert.equal(f.Ctext, next);
    // Exactly the edited lines are pending: lines 2-3 became 2-4; the unsaved edit isn't a change.
    assert.deepEqual(f.hunks, [{ o: 1, oc: 2, n: 1, nc: 3 }]);
    assert.equal(shows(e, "main", "s1"), true);
    assert.equal(shows(e, "main", "s2"), false); // only the asking space reviews it
  }
  // 2. A file already under review keeps its baseline: a second event changes nothing.
  {
    const dir = repo({ "g.js": "x\ny\n" });
    writeFileSync(`${dir}/g.js`, "x\nAGENT\n");
    await postEdit({ path: `${dir}/g.js`, original: "x\ny\n", space: "s1" });
    await new Journal(() => {}).drain();
    const st = await Store.open(dir), before = readFileSync(`${st.dir}/index.json`, "utf8");
    await swap(`${dir}/g.js`, "x\nAGENT\n", "INLINE\nAGENT\n");
    await postEdit({ path: `${dir}/g.js`, original: "x\nAGENT\n", space: "s1" });
    await new Journal(() => {}).drain();
    assert.equal(readFileSync(`${st.dir}/index.json`, "utf8"), before); // index untouched
    const f = await st.load("g.js", index(st)["g.js"]);
    assert.equal(f.Btext, "x\ny\n"); // the first baseline
    assert.deepEqual(f.hunks, [{ o: 0, oc: 2, n: 0, nc: 2 }]);
  }
  // 3. Compare-and-swap: a file changed on disk since it was read is never overwritten.
  {
    const dir = repo({ "h.txt": "1\n2\n" });
    writeFileSync(`${dir}/h.txt`, "1\n2\nsomeone else\n");
    await assert.rejects(swap(`${dir}/h.txt`, "1\n2\n", "ONE\n2\n"));
    assert.equal(readFileSync(`${dir}/h.txt`, "utf8"), "1\n2\nsomeone else\n");
  }
} finally {
  for (const d of made) rmSync(d, { recursive: true, force: true });
}
console.log("inlinereview ok");
