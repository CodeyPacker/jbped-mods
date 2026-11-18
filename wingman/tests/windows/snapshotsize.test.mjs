// Windows only, opt-in: snapshot.ps1 timings on a Windows drive (C12). From the tests folder in cmd:
//   set "WINGMAN_TEST_HOME=%TEMP%"&& node --import ./register.mjs windows/snapshotsize.test.mjs
import { runner, isolate, cleanup } from "../snaphelper.mjs";
import { runSize } from "../snapcases.mjs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const script = resolve("../mods/wingman/snapshot.ps1"), base = tmpdir();
const ps = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
process.env.WINGMAN_SNAP_TIMEOUT ??= "3600000"; // timings, not a limit
isolate(base);
try { await runSize(runner("ps1", base, true, (gitDir, dir, _o, go) => go("powershell.exe", [...ps, "-File", script, gitDir, dir]))); } finally { cleanup(); }
console.log("snapshot size timings done");
