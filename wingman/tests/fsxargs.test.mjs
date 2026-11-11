// fsx.chunkArgs (paths split so each remote call stays within its safe size) and fsx.revealCommand
// (Explorer's /select with a comma in the path).
import { chunkArgs, revealCommand, SAFE_CALL, fingerprints } from "../mods/wingman/fsx.js";
import { remoteCalls } from "./herdr-shim.mjs";
import { byteLength } from "../mods/wingman/sha256.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// ---- chunkArgs ---------------------------------------------------------------------------------------
assert.deepEqual(chunkArgs([]), []);
assert.deepEqual(chunkArgs(["a", "b"]), [["a", "b"]]);
const cost = (s) => byteLength(s) + (s.match(/["\\]/g)?.length ?? 0) + 3;
// 200 long paths (about 400 bytes each, 80 KB in all): several calls, each within the budget, order kept.
const long = Array.from({ length: 200 }, (_, i) => `/home/me/projects/${"deep/".repeat(70)}file-${i}.ts`);
const runs = chunkArgs(long);
assert.ok(runs.length > 1, "split");
assert.deepEqual(runs.flat(), long, "every path once, in order");
for (const r of runs) assert.ok(r.reduce((n, p) => n + cost(p), 0) <= SAFE_CALL - 2000, "each run within the budget");
// Quotes and backslashes count twice; multi-byte characters count their UTF-8 bytes.
assert.deepEqual(chunkArgs(['a"b', "c\\d"], cost('a"b') + cost("c\\d")).length, 1);
assert.deepEqual(chunkArgs(['a"b', "c\\d"], cost('a"b') + cost("c\\d") - 1).length, 2);
assert.deepEqual(chunkArgs(["é".repeat(10), "x"], cost("é".repeat(10))).map((r) => r.length), [1, 1]);
// One argument over the budget: alone in its own run.
assert.deepEqual(chunkArgs(["x".repeat(50), "y"], 20), [["x".repeat(50)], ["y"]]);

// fingerprints over many long paths on another machine: several calls, one answer per path.
const dir = mkdtempSync(`${tmpdir()}/wingman-fp-`);
try {
  const paths = Array.from({ length: 300 }, (_, i) => `${dir}/${"n".repeat(200)}-${i}.txt`);
  paths.slice(0, 3).forEach((p) => writeFileSync(p, "x"));
  const before = remoteCalls.length;
  const fp = await fingerprints(paths, { on: "wsl" });
  const calls = remoteCalls.slice(before);
  assert.ok(calls.length > 1, `split into ${calls.length} calls`);
  assert.equal(Object.keys(fp).length, 300);
  assert.equal(fp[paths[0]], "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  assert.equal(fp[paths[299]], null);
} finally { rmSync(dir, { recursive: true, force: true }); }

// ---- revealCommand ---------------------------------------------------------------------------------------
assert.deepEqual(revealCommand("C:/dev/app/src/x.ts"), { cmd: "explorer.exe", args: ["/select,", "C:\\dev\\app\\src\\x.ts"] });
assert.deepEqual(revealCommand("C:/dev/app/src", true), { cmd: "explorer.exe", args: ["C:\\dev\\app\\src"] });
const c = revealCommand("C:/dev/a,b/it's, here.ts");
assert.equal(c.cmd, "powershell");
const script = c.args.at(-1);
assert.ok(script.startsWith("$p = 'C:\\dev\\a,b\\it''s, here.ts';"), "the path as a single-quoted literal, its quote doubled");
assert.ok(script.includes("Start-Process -FilePath explorer.exe -ArgumentList ('/select,' + $q + $p + $q)"));
assert.ok(!script.includes('"'), "no double quote reaches exec's escaping");
const d = revealCommand("C:/dev/a,b", true).args.at(-1);
assert.ok(d.includes("-ArgumentList ($q + $p + $q)"), "a folder with a comma: opened, quoted");
assert.ok(revealCommand("C:/x/‘a’,b.ts").args.at(-1).includes("‘‘a’’"), "curly quotes doubled too");
assert.deepEqual(revealCommand("//wsl.localhost/Ubuntu/home/me/a.ts").args, ["/select,", "\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts"]);
console.log("fsxargs ok");
