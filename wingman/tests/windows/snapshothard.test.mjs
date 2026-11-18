// Windows only, not in run.sh's set. From the tests folder in cmd:
//   set "WINGMAN_TEST_HOME=%TEMP%"&& node --import ./register.mjs windows/snapshothard.test.mjs
// snapshot.ps1 hardening cases (C1..C11, C13), see ../snapcases.mjs. Repos are made in %TEMP% and removed.
// Cases that need a privilege this machine lacks (symlinks) are skipped with a printed reason.
import { runner, isolate, cleanup } from "../snaphelper.mjs";
import { runCases } from "../snapcases.mjs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const script = resolve("../mods/wingman/snapshot.ps1"), base = tmpdir();
const ps = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"], q = (p) => `'${p.replace(/'/g, "''")}'`;
// Like Capture.snapshot(), or with the caller's PowerShell redirecting stderr (2>&1).
const rn = runner("ps1", base, true, (gitDir, dir, o, go) => o.redirect
  ? go("powershell.exe", [...ps, "-Command", `& ${q(script)} ${q(gitDir)} ${q(dir)} 2>&1 | Out-String; exit $LASTEXITCODE`])
  : go("powershell.exe", [...ps, "-File", script, gitDir, dir]));
isolate(base);
try { await runCases(rn, process.env.WINGMAN_SNAP_CASES?.split(",") ?? null); } finally { cleanup(); }
console.log("snapshot hardening (ps1) pass");
