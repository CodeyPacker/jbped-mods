// snapshot.sh gives each run its own temp index and removes it: a run killed outright (kill -9)
// doesn't block the next one with a stale lock, and two runs at once don't share an index (F7).
import { Store } from "../mods/wingman/store.js";
import { Capture } from "../mods/wingman/capture.js";
import { appHome } from "herdr";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

const dir = mkdtempSync(`${tmpdir()}/snaplock-`), bin = mkdtempSync(`${tmpdir()}/snaplock-bin-`);
const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
const leftovers = () => readdirSync(`${dir}/.git/wingman`).filter((n) => n.startsWith("snap."));
try {
  g("init", "-q");
  for (let i = 0; i < 200; i++) writeFileSync(`${dir}/f${i}.txt`, `${i}\n`);
  g("add", "."); g("commit", "-qm", "c");
  const cap = new Capture(await Store.open(dir));
  const first = await cap.snapshot();
  assert.deepEqual(leftovers(), []);

  // A run killed while git holds its lock: a git that takes the lock and hangs.
  writeFileSync(`${bin}/git`, '#!/bin/sh\n: > "$GIT_INDEX_FILE.lock"\nexec sleep 60\n'); chmodSync(`${bin}/git`, 0o755);
  const run = spawn("sh", [`${appHome()}/mods/wingman/snapshot.sh`, `${dir}/.git`, dir], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, detached: true, stdio: "ignore" });
  for (let i = 0; i < 200 && !leftovers().some((n) => n.endsWith(".lock")); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(leftovers().some((n) => n.endsWith(".lock")), "the hanging run took its lock");
  process.kill(-run.pid, "SIGKILL");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(leftovers().length >= 2, `a killed run leaves its index and lock: ${leftovers()}`);
  // An older version's shared index and lock, and a dead run's copy.
  writeFileSync(`${dir}/.git/wingman/snap.index.lock`, ""); writeFileSync(`${dir}/.git/wingman/snap.index`, "");
  writeFileSync(`${dir}/.git/wingman/snap.2147483646.index`, "");
  writeFileSync(`${dir}/f0.txt`, "changed\n");
  const second = await cap.snapshot();
  assert.notEqual(second, first);
  assert.deepEqual(leftovers(), [], "the next run cleared what dead runs left");

  // Runs at once: each succeeds with the same tree, and nothing is left behind.
  for (let round = 0; round < 3; round++) {
    const trees = await Promise.all(Array.from({ length: 6 }, () => cap.snapshot()));
    assert.deepEqual(new Set(trees), new Set([second]));
  }
  assert.deepEqual(leftovers(), []);
  assert.ok(!existsSync(`${dir}/.git/index.lock`));
} finally { rmSync(dir, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
console.log("snapshot lock tests pass");
