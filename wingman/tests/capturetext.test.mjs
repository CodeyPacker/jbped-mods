// Capture's baselines are the file as the working tree had it, by git's own checkout rules (F4),
// and a file over 1 MiB is left out of the review without stopping the pass (F3). Herdr (and the
// shim) refuse to read a text file over 1 MiB here.
import { Store } from "../mods/wingman/store.js";
import { Capture } from "../mods/wingman/capture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

const made = [];
const repo = (config = []) => {
  const dir = mkdtempSync(`${tmpdir()}/ct-`); made.push(dir);
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
  g("init", "-q"); for (const [k, v] of config) g("config", k, v);
  return { dir, g };
};
const baselineOf = async (st, rel) => (await st.load(rel, (await st.index())[rel])).Btext;

try {
  // ---- F4: the baseline is exactly what was on disk before the agent's edit
  const cases = [
    // [name, config when committing, config after (checkout), committed bytes, the agent's text]
    ["LF file, the agent adds one CRLF line", [], [], "l1\nl2\nl3\n", "l1\nl2\nl3\nagent line\r\n"],
    ["CRLF on disk under autocrlf=true", [], [["core.autocrlf", "true"]], "l1\nl2\nl3\n", "l1\r\nAGENT\r\nl3\r\n"],
    ["autocrlf=input, LF", [["core.autocrlf", "input"]], [], "l1\nl2\n", "l1\nAGENT\n"],
    ["autocrlf=false, CRLF committed", [["core.autocrlf", "false"]], [], "l1\r\nl2\r\n", "l1\r\nAGENT\r\n"],
    ["mixed endings committed, then autocrlf=true", [["core.autocrlf", "false"]], [["core.autocrlf", "true"]], "a\r\nb\nc\r\n", "a\r\nB\nc\r\n"],
    ["mixed endings under autocrlf=input", [["core.autocrlf", "false"]], [["core.autocrlf", "input"]], "a\r\nb\nc\r\n", "a\r\nb\nC\n"],
    ["eol=crlf attribute", [], [], "l1\nl2\n", "l1\r\nAGENT\r\n", "*.txt eol=crlf\n"],
  ];
  for (const [name, before, after, committed, agent, attrs] of cases) {
    const { dir, g } = repo(before);
    if (attrs) writeFileSync(`${dir}/.gitattributes`, attrs);
    writeFileSync(`${dir}/f.txt`, committed); g("add", "."); g("commit", "-qm", "c");
    for (const [k, v] of after) g("config", k, v);
    unlinkSync(`${dir}/f.txt`); g("checkout", "--", "f.txt"); // the file as checkout writes it
    const disk = readFileSync(`${dir}/f.txt`, "utf8");
    const st = await Store.open(dir), cap = new Capture(st), t0 = await cap.snapshot();
    writeFileSync(`${dir}/f.txt`, agent);
    assert.equal(await cap.adopt(t0, await cap.snapshot()), 1, name);
    assert.equal(await baselineOf(st, "f.txt"), disk, name);
  }

  // ---- F3: one file over 1 MiB doesn't stop the others
  {
    const { dir, g } = repo(), lines = [];
    writeFileSync(`${dir}/package-lock.json`, `{"x":"${"a".repeat(1200000)}"}\n`);
    writeFileSync(`${dir}/shrinks.txt`, "s".repeat(1100000) + "\n");
    writeFileSync(`${dir}/src.js`, "one\n"); g("add", "."); g("commit", "-qm", "c");
    const st = await Store.open(dir), cap = new Capture(st, (l) => lines.push(l)), t0 = await cap.snapshot();
    writeFileSync(`${dir}/src.js`, "AGENT\n");
    writeFileSync(`${dir}/package-lock.json`, `{"x":"${"b".repeat(1200000)}"}\n`);
    writeFileSync(`${dir}/shrinks.txt`, "small now\n"); // its baseline is over 1 MiB
    writeFileSync(`${dir}/huge-new.txt`, "n".repeat(1100000));
    assert.equal(await cap.adopt(t0, await cap.snapshot()), 1);
    assert.deepEqual(Object.keys(await st.index()), ["src.js"]);
    assert.equal(lines.length, 3); assert.ok(lines.every((l) => /over 1 MB, not reviewed/.test(l)), lines.join("\n"));
    // The next pass adds a new small file and says nothing again about the big ones.
    writeFileSync(`${dir}/later.txt`, "x\n");
    assert.equal(await cap.adopt(t0, await cap.snapshot()), 1);
    assert.deepEqual(Object.keys(await st.index()).sort(), ["later.txt", "src.js"]);
    assert.equal(lines.length, 3);
    // Reconcile and loading the review go on too.
    await st.reconcile();
    assert.ok((await st.files()).every((f) => !f.error));
  }
} finally { for (const d of made) rmSync(d, { recursive: true, force: true }); }
console.log("capture text tests pass");
