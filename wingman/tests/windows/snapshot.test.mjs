// Windows only, not in run.sh's set. From the tests folder in cmd:
//   set "WINGMAN_TEST_HOME=%TEMP%"&& node --import ./register.mjs windows/snapshot.test.mjs
// snapshot.ps1 on a repo where `git add -A` warns on stderr (LF files, core.autocrlf=true): it must still
// print a tree id and exit 0, also when the caller's PowerShell redirects stderr (2>&1), which turns
// git's warning lines into error records that $ErrorActionPreference = "Stop" makes fatal.
import { exec } from "herdr";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join as pjoin, resolve } from "node:path";

const script = resolve("../mods/wingman/snapshot.ps1");
const root = await mkdtemp(pjoin(tmpdir(), "wingman-snap-"));
const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, encoding: "utf8" });
try {
  git("init", "-q"); git("config", "core.autocrlf", "true"); git("config", "core.safecrlf", "warn");
  await writeFile(pjoin(root, ".dockerignore"), "a\nb\n"); await writeFile(pjoin(root, "f.txt"), "x\ny\n");
  const gitDir = pjoin(root, ".git");
  const ps = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
  const isTree = (s) => /^[0-9a-f]{40,64}$/.test(s.trim().split(/\s+/).pop() ?? "");

  // the way Capture.snapshot() runs it
  const a = await exec("powershell", [...ps, "-File", script, gitDir, root]);
  assert.equal(a.code, 0, a.stderr); assert.ok(isTree(a.stdout), a.stdout);
  // the caller's PowerShell redirects stderr
  const q = (p) => `'${p.replace(/'/g, "''")}'`;
  const b = await exec("powershell", [...ps, "-Command", `& ${q(script)} ${q(gitDir)} ${q(root)} 2>&1 | Out-String; exit $LASTEXITCODE`]);
  assert.equal(b.code, 0, b.stdout + b.stderr); assert.ok(isTree(b.stdout.trim().split(/\r?\n/).filter((l) => /^[0-9a-f]{40,64}$/.test(l.trim())).pop() ?? ""), b.stdout);
  // the same warning must not fire now that git is told not to
  assert.ok(!/LF will be replaced/.test(a.stderr), "the CRLF warning is silenced at the source");
  // a real git failure still fails, with git's message
  await writeFile(pjoin(gitDir, "index"), "garbage");
  const c = await exec("powershell", [...ps, "-File", script, gitDir, root]);
  assert.notEqual(c.code, 0); assert.ok(/index|corrupt|signature/i.test(c.stderr + c.stdout), c.stderr);
  console.log("windows/snapshot ok");
} finally { await rm(root, { recursive: true, force: true }); }
