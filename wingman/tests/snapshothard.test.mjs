// snapshot.sh hardening cases (C1..C11, C13), see snapcases.mjs. The 20,000-file timing case is slow/snapshotsize.test.mjs.
import { runner, isolate, cleanup } from "./snaphelper.mjs";
import { runCases } from "./snapcases.mjs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const script = resolve("../mods/wingman/snapshot.sh"), base = tmpdir();
const rn = runner("sh", base, false, (gitDir, dir, _o, go) => go("sh", [script, gitDir, dir]));
rn.script = script;
isolate(base);
try { await runCases(rn, process.env.WINGMAN_SNAP_CASES?.split(",") ?? null); } finally { cleanup(); }
console.log("snapshot hardening (sh) pass");
