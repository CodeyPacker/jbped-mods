// Store.diskSums keeps a length and checksum per path, not the file's text (F6), and Store.blobSize
// reads a committed file's size without its text (F4). A real repo.
import { Store, sumOf, checksum } from "../mods/wingman/store.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const dir = mkdtempSync(`${tmpdir()}/seen-`);
try {
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main"); writeFileSync(`${dir}/f.txt`, "one\n"); writeFileSync(`${dir}/big.bin`, Buffer.alloc(2 * 1048576, 1)); g("add", "."); g("commit", "-qm", "c");
  const st = await Store.open(dir);
  let sums = await st.diskSums(["f.txt", "gone.txt"]);
  assert.equal(sums.get("f.txt"), await sumOf("one\n"));
  assert.equal(sums.get("gone.txt"), "-", "a missing file sums as no file");
  for (const [, e] of st.seenSums) assert.ok(!("text" in e), "no text kept");
  // Same length, other content: the checksum tells them apart.
  writeFileSync(`${dir}/f.txt`, "two\n");
  sums = await st.diskSums(["f.txt"]);
  assert.equal(sums.get("f.txt"), await sumOf("two\n"));
  // Unchanged: the kept sum is reused.
  assert.equal((await st.diskSums(["f.txt"])).get("f.txt"), await sumOf("two\n"));
  assert.notEqual(checksum("ab"), checksum("ba"));
  assert.equal(checksum(""), checksum(""));
  // Sizes without reading.
  const head = g("rev-parse", "HEAD").trim();
  assert.equal(await st.blobSize(head, "big.bin"), 2 * 1048576);
  assert.equal(await st.blobSize(head, "f.txt"), 4);
  assert.equal(await st.blobSize(head, "nope.txt"), null);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("seensums ok");
