// Opt-in (not in run.sh's set): snapshot.sh timings, C12 of the hardening cases (20,000 small files, one 200 MB file).
//   sh wingman/tests/run.sh slow/snapshotsize           (in WSL: ext4 /tmp, then /mnt/c, when it exists)
// Set WINGMAN_SNAP_BASES to a comma list of folders to time instead. Repos are made there and removed.
import { runner, isolate, cleanup } from "../snaphelper.mjs";
import { runSize } from "../snapcases.mjs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

process.env.WINGMAN_SNAP_TIMEOUT ??= "3600000"; // timings, not a limit
const script = resolve("../mods/wingman/snapshot.sh");
// A Windows drive's temp folder, as WSL sees it (the same one the Windows tests use).
const winTemp = () => { try { return execFileSync("wslpath", ["-u", execFileSync("cmd.exe", ["/c", "echo %TEMP%"], { encoding: "utf8", cwd: "/mnt/c" }).trim()], { encoding: "utf8" }).trim(); } catch { return null; } };
const bases = process.env.WINGMAN_SNAP_BASES?.split(",") ?? [tmpdir(), winTemp()].filter(Boolean);
try {
  for (const base of bases) {
    isolate(base);
    await runSize(runner("sh", base, false, (gitDir, dir, _o, go) => go("sh", [script, gitDir, dir])));
  }
} finally { cleanup(); }
console.log("snapshot size timings done");
