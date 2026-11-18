// Discard and Commit name files, never patterns (F1), and Commit takes any number of files through
// a pathspec file instead of the command line (F12). Real repos, here and as machine "vps" (the
// shim runs it here, through the remote write route).
import { discardCommands, commitCommands, pathspecText } from "../mods/wingman/changes.js";
import { Store } from "../mods/wingman/store.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const repo = () => {
  const d = mkdtempSync(`${tmpdir()}/wm-ps-`), g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q");
  return { d, g, put: (rel, text) => { mkdirSync(`${d}/${rel}`.replace(/\/[^/]*$/, ""), { recursive: true }); writeFileSync(`${d}/${rel}`, text); } };
};
const run = async (st, cmds) => { for (const a of cmds) { const r = await st.git(a); assert.equal(r.code, 0, `git ${a.join(" ")}: ${r.stderr}`); } };

// ---- F1: discard
{
  const { d, g, put } = repo();
  try {
    const names = ["app/[slug]/page.tsx", "app/s/page.tsx", ":!x", "*", "a?.txt", "ab.txt"];
    for (const n of names) put(n, "1\n");
    g("add", "-A"); g("commit", "-qm", "i");
    for (const n of names) put(n, "2\n");
    put("new[1].txt", "n\n"); put("new1.txt", "keep\n");
    const st = await Store.open(d);
    await run(st, discardCommands("app/[slug]/page.tsx", true));
    await run(st, discardCommands(":!x", true));
    await run(st, discardCommands("*", true));
    await run(st, discardCommands("a?.txt", true));
    await run(st, discardCommands("new[1].txt", false));
    assert.equal(readFileSync(`${d}/app/[slug]/page.tsx`, "utf8"), "1\n");
    assert.equal(readFileSync(`${d}/:!x`, "utf8"), "1\n");
    assert.equal(readFileSync(`${d}/*`, "utf8"), "1\n");
    assert.equal(readFileSync(`${d}/a?.txt`, "utf8"), "1\n");
    assert.ok(!existsSync(`${d}/new[1].txt`));
    // Only the named files went back: the ones their names match as patterns kept their edits.
    assert.equal(readFileSync(`${d}/app/s/page.tsx`, "utf8"), "2\n");
    assert.equal(readFileSync(`${d}/ab.txt`, "utf8"), "2\n");
    assert.equal(readFileSync(`${d}/new1.txt`, "utf8"), "keep\n");
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// ---- F1 + F12: commit, here and on "vps"
for (const on of [null, "vps"]) {
  const { d, g, put } = repo();
  try {
    put("app/[slug]/page.tsx", "1\n"); put("app/s/page.tsx", "1\n"); put("*", "1\n"); put("x.txt", "1\n");
    g("add", "-A"); g("commit", "-qm", "i");
    put("app/[slug]/page.tsx", "2\n"); put("app/s/page.tsx", "2\n"); put("*", "2\n"); put("x.txt", "2\n");
    // Odd names: quotes, a backslash, spaces at the ends, a newline, magic, non-ASCII.
    const odd = ['q"uote.txt', "back\\slash.txt", " lead.txt", "trail.txt ", "new\nline.txt", ":(glob)x.txt", "中文 $x.txt"];
    for (const n of odd) put(n, "odd\n");
    // 400 files with long names: about 80 KB of paths, more than a Windows command line holds.
    const many = Array.from({ length: 400 }, (_, i) => `deep/${"long-folder-name-".repeat(6)}/${String(i).padStart(3, "0")}-${"x".repeat(80)}.txt`);
    for (const n of many) put(n, `${n}\n`);
    const st = await Store.open(d, on), rels = ["app/[slug]/page.tsx", "*", ...odd, ...many];
    const spec = st.tempPath("pathspec");
    assert.ok(spec.startsWith(`${st.dir}/`));
    await st.withTemp(spec, pathspecText(rels), () => run(st, commitCommands(rels, "many", spec)));
    assert.ok(!existsSync(spec), "the pathspec file is removed");
    assert.deepEqual(readdirSync(st.dir).filter((n) => n.startsWith("tmp-")), []);
    const committed = g("show", "--name-only", "-z", "--format=", "HEAD").split("\0").filter(Boolean).sort();
    assert.deepEqual(committed, [...rels].sort());
    assert.equal(g("rev-list", "--count", "HEAD").trim(), "2"); // one commit
    // The files the paths match as patterns are still uncommitted.
    assert.deepEqual(g("status", "--porcelain", "-z").split("\0").filter(Boolean).sort(), [" M app/s/page.tsx", " M x.txt"]);
    // A failed commit removes the file too.
    const spec2 = st.tempPath("pathspec");
    await assert.rejects(st.withTemp(spec2, pathspecText(["x.txt"]), async () => { throw new Error("boom"); }), /boom/);
    assert.ok(!existsSync(spec2));
  } finally { rmSync(d, { recursive: true, force: true }); }
}
console.log("pathspec tests pass");
