// fsx.js writes (D1): writeText, removeFile, makeDir and fingerprints, here and on another machine.
// The shim runs machine "vps" here (each call recorded in remoteCalls); "nosh" has no sh (Windows).
import { writeText, removeFile, makeDir, fingerprints, callBytes, SAFE_CALL, BIG_CALL, STALE, WINDOWS_NOTE, WRITE_SH, WRITE_TRIES, transientWrite } from "../mods/wingman/fsx.js";
import { remoteCalls, writeFaults } from "herdr";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync, chmodSync, symlinkSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const on = "vps", dir = mkdtempSync(`${tmpdir()}/fsxw-`);
const bytes = (p) => readFileSync(p);
const temps = (d = dir) => readdirSync(d).filter((n) => n.startsWith(".wingman-"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const nasty = "a\r\nb\tc \"q\" 'q' `b` \\n \\\\ \\0 \\x41 $HOME ${x} $(id) $$ !! %s %d %% %n é 中文 😀 \u00a0 \u2028 mid\ufeffbom -n -e --help * ? [a] ; | & > <";
try {
  // ---- byte exactness, one call ------------------------------------------------------------
  const cases = { nasty, crlf: "one\r\ntwo\r\n", nofinal: "no final newline", final: "x\n", many: "x\n\n\n", empty: "", lone: "\n", dash: "-n", pct: "%s%%\\" };
  for (const [name, text] of Object.entries(cases)) {
    const p = `${dir}/${name}.txt`;
    remoteCalls.length = 0;
    await writeText(p, text, null, { on });
    assert.ok(bytes(p).equals(Buffer.from(text, "utf8")), name);
    assert.equal(remoteCalls.length, 1, `${name}: one call`);
    // Overwrite with the right expected text, compare-and-swap.
    await writeText(p, text + "+", text, { on });
    assert.equal(readFileSync(p, "utf8"), text + "+");
  }
  assert.deepEqual(temps(), []);
  // A path with spaces, quotes and a leading dash in the name.
  const odd = `${dir}/-it's "odd" $x.txt`;
  await writeText(odd, "ok", null, { on });
  assert.equal(readFileSync(odd, "utf8"), "ok");

  // ---- compare-and-swap ------------------------------------------------------------------------
  const p = `${dir}/cas.txt`;
  await writeText(p, "v1", null, { on });
  await assert.rejects(writeText(p, "v2", null, { on }), (e) => e.message.includes(STALE)); // create only if absent
  await assert.rejects(writeText(p, "v2", "stale", { on }), (e) => e.message.includes(STALE));
  assert.equal(readFileSync(p, "utf8"), "v1");
  await assert.rejects(writeText(`${dir}/none.txt`, "v2", "v1", { on }), (e) => e.message.includes(STALE)); // expected a file
  assert.ok(!existsSync(`${dir}/none.txt`));
  assert.deepEqual(temps(), []);
  // The same wording here.
  await assert.rejects(writeText(p, "v2", "stale"), (e) => e.message.includes(STALE));
  await writeText(p, "local", "v1");
  assert.equal(readFileSync(p, "utf8"), "local");

  // ---- mode kept, links followed ----------------------------------------------------------------
  const x = `${dir}/run.sh`;
  writeFileSync(x, "#!/bin/sh\n"); chmodSync(x, 0o750);
  await writeText(x, "#!/bin/sh\necho hi\n", "#!/bin/sh\n", { on });
  assert.equal(statSync(x).mode & 0o777, 0o750);
  mkdirSync(`${dir}/real`);
  writeFileSync(`${dir}/real/target.txt`, "t1");
  symlinkSync("real/target.txt", `${dir}/link.txt`);
  await writeText(`${dir}/link.txt`, "t2", "t1", { on });
  assert.ok(lstatSync(`${dir}/link.txt`).isSymbolicLink());
  assert.equal(readFileSync(`${dir}/real/target.txt`, "utf8"), "t2");
  assert.deepEqual(temps(`${dir}/real`), []);

  // ---- files that aren't plain UTF-8 ------------------------------------------------------------
  // A BOM reads back as U+FEFF here, so it hashes right and is kept.
  writeFileSync(`${dir}/bom.txt`, Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
  const bomText = readFileSync(`${dir}/bom.txt`, "utf8");
  await writeText(`${dir}/bom.txt`, bomText + "!", bomText, { on });
  assert.ok(bytes(`${dir}/bom.txt`).equals(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x21])));
  // Latin-1 reads back as U+FFFD: writing would change bytes nobody edited, so it's refused.
  writeFileSync(`${dir}/latin1.txt`, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  const l1 = readFileSync(`${dir}/latin1.txt`, "utf8");
  await assert.rejects(writeText(`${dir}/latin1.txt`, l1 + "!", l1, { on }), /isn't plain UTF-8 text/);
  assert.ok(bytes(`${dir}/latin1.txt`).equals(Buffer.from([0x63, 0x61, 0x66, 0xe9])));

  // ---- chunked writes on the safe route ---------------------------------------------------------
  callBytes(on, SAFE_CALL);
  const k200 = (nasty + "\n").repeat(Math.ceil(200000 / Buffer.byteLength(nasty + "\n")));
  remoteCalls.length = 0;
  await writeText(`${dir}/k200.txt`, k200, null, { on });
  assert.equal(sha(bytes(`${dir}/k200.txt`)), sha(Buffer.from(k200, "utf8")));
  const calls = remoteCalls.filter((c) => c.cmd === "sh");
  assert.ok(calls.length >= 8, `${calls.length} calls`);
  for (const c of calls) {
    const cost = c.args.reduce((n, a) => n + Buffer.byteLength(a) + (a.match(/["\\]/g)?.length ?? 0), 0);
    assert.ok(cost <= SAFE_CALL, `call of ${cost}`);
  }
  assert.deepEqual(calls.map((c) => c.args[3]), ["start", ...Array(calls.length - 2).fill("add"), "end"]);
  assert.deepEqual(temps(), []);
  // Stale at the end: refused, the target untouched, no temp file left.
  await assert.rejects(writeText(`${dir}/k200.txt`, k200 + "x", "not it", { on }), (e) => e.message.includes(STALE));
  assert.equal(sha(bytes(`${dir}/k200.txt`)), sha(Buffer.from(k200, "utf8")));
  assert.deepEqual(temps(), []);
  // A folder that can't be written: the first step fails, nothing is left behind.
  mkdirSync(`${dir}/ro`); writeFileSync(`${dir}/ro/f.txt`, "keep"); chmodSync(`${dir}/ro`, 0o555);
  if (process.getuid?.() !== 0) {
    await assert.rejects(writeText(`${dir}/ro/f.txt`, k200, "keep", { on }), /cannot write beside/);
    await assert.rejects(writeText(`${dir}/ro/f.txt`, "small", "keep", { on }), /cannot write beside/);
    assert.equal(readFileSync(`${dir}/ro/f.txt`, "utf8"), "keep");
    assert.deepEqual(temps(`${dir}/ro`), []);
  }
  chmodSync(`${dir}/ro`, 0o755);

  // ---- the size probe: here every route is execve's, so 1 MB per call is proven ------------------
  callBytes(on, 0);
  const mb = "0123456789abcdef\n".repeat(Math.ceil(1500000 / 17));
  remoteCalls.length = 0;
  await writeText(`${dir}/mb.txt`, mb, null, { on });
  assert.equal(callBytes(on), BIG_CALL);
  assert.equal(sha(bytes(`${dir}/mb.txt`)), sha(Buffer.from(mb)));
  assert.equal(remoteCalls.filter((c) => c.cmd === "sh").length, 3); // the probe, then two calls
  assert.ok(remoteCalls.every((c) => c.args.slice(1).every((a) => Buffer.byteLength(a) <= 131071)));
  assert.deepEqual(temps(), []);

  // ---- removeFile and makeDir -------------------------------------------------------------------
  await assert.rejects(removeFile(p, "wrong", { on }), (e) => e.message.includes(STALE));
  assert.ok(existsSync(p));
  await removeFile(p, "local", { on });
  assert.ok(!existsSync(p));
  await removeFile(p, null, { on }); // already absent, as expected
  await assert.rejects(removeFile(p, "local", { on }), (e) => e.message.includes(STALE));
  // A link is deleted itself, not what it names.
  await removeFile(`${dir}/link.txt`, "t2", { on });
  assert.ok(!existsSync(`${dir}/link.txt`) && existsSync(`${dir}/real/target.txt`));
  await makeDir(`${dir}/a/b/c`, { on });
  assert.ok(statSync(`${dir}/a/b/c`).isDirectory());
  await makeDir(`${dir}/a/b/c`, { on }); // already there
  await makeDir(`${dir}/here/x`);
  assert.ok(statSync(`${dir}/here/x`).isDirectory());

  // ---- fingerprints -----------------------------------------------------------------------------
  const fp = await fingerprints([`${dir}/crlf.txt`, `${dir}/gone.txt`, `${dir}/a`], { on });
  assert.deepEqual(fp, { [`${dir}/crlf.txt`]: sha(bytes(`${dir}/crlf.txt`)), [`${dir}/gone.txt`]: null, [`${dir}/a`]: null });
  assert.deepEqual(await fingerprints([], { on }), {});

  // ---- a Windows machine (no sh) ------------------------------------------------------------------
  await assert.rejects(writeText(`${dir}/w.txt`, "x", null, { on: "nosh" }), (e) => e.message === WINDOWS_NOTE);
  await assert.rejects(removeFile(`${dir}/w.txt`, "x", { on: "nosh" }), (e) => e.message === WINDOWS_NOTE);
  assert.ok(!existsSync(`${dir}/w.txt`));

  // The script is POSIX sh: dash parses it when there is one.
  try { (await import("node:child_process")).execFileSync("dash", ["-n", "-c", WRITE_SH]); } catch (e) { if (e.code !== "ENOENT") throw e; }
} finally {
  try { chmodSync(`${dir}/ro`, 0o755); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

// A local write that Windows refused for a moment (another reader had the file open over
// \\wsl.localhost) is tried again, compare-and-swap checked each time; a real failure isn't.
{
  const d2 = mkdtempSync(`${tmpdir()}/fsxw2-`), p = `${d2}/f.txt`;
  try {
    writeFileSync(p, "old");
    writeFaults.push("`herdr.writeTextFile`: Access is denied. (os error 5)");
    await writeText(p, "new", "old");
    assert.equal(readFileSync(p, "utf8"), "new");
    writeFaults.push(...Array(WRITE_TRIES).fill("Access is denied. (os error 5)"));
    await assert.rejects(writeText(p, "newer", "new"), /Access is denied/);
    assert.equal(writeFaults.length, 0, "tried WRITE_TRIES times");
    assert.equal(readFileSync(p, "utf8"), "new");
    writeFaults.push("No space left on device (os error 28)", "unused");
    await assert.rejects(writeText(p, "newer", "new"), /No space/);
    assert.equal(writeFaults.length, 1, "not tried again"); writeFaults.length = 0;
    // changed meanwhile: the retry's compare-and-swap check refuses it
    writeFaults.push("Access is denied. (os error 5)");
    writeFileSync(p, "someone else");
    await assert.rejects(writeText(p, "mine", "new"), /changed since it was read/);
    assert.ok(transientWrite(new Error("The process cannot access the file because it is being used by another process. (os error 32)")));
    assert.ok(!transientWrite(new Error("stale snapshot")));
  } finally { writeFaults.length = 0; rmSync(d2, { recursive: true, force: true }); }
}
console.log("fsxwrite ok");
