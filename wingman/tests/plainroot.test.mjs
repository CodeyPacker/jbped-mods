// PlainRoot: a folder outside git whose files save like a repo's, compare-and-swap.
import { PlainRoot } from "../mods/wingman/store.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
const dir = mkdtempSync(`${tmpdir()}/plain-`);
try {
  const root = new PlainRoot(dir), path = `${dir}/notes.txt`;
  assert.equal(root.plain, true); assert.equal(root.asked, dir);
  writeFileSync(path, "one\n");
  const f = { rel: "notes.txt", path, store: root, key: `${dir}|notes.txt` };
  const w = await root.apply(f, { target: "current", before: "one\n", after: "two\n" });
  assert.equal(readFileSync(path, "utf8"), "two\n");
  // Changed on disk since it was read: refused, file kept.
  await assert.rejects(root.apply(f, { target: "current", before: "one\n", after: "three\n" }), /changed since it was read/);
  assert.equal(readFileSync(path, "utf8"), "two\n");
  await assert.rejects(root.apply(f, { target: "baseline", before: "", after: "x" }), /no review baseline/);
  await root.undo([w]);
  assert.equal(readFileSync(path, "utf8"), "one\n");
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("plainroot ok");
