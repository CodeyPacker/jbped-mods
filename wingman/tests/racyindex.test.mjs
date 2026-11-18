// A snapshot must see an edit that keeps a file's size and lands in the same second as the
// index's entry for it ("racily clean" in git's terms). Git trusts a matching stat only for
// entries older than the index file itself, so snapshot.sh's copy of the index must keep the
// real index's time: a fresh copy is newer than every entry and hides such an edit.
// The times are set by hand (touch -d) and ctime is ignored, so this doesn't depend on timing.
import { Store } from "../mods/wingman/store.js";
import { Capture } from "../mods/wingman/capture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const dir = mkdtempSync(`${tmpdir()}/racy-`);
const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
const at = (path) => execFileSync("touch", ["-d", "@1600000000", path]); // a fixed second, in the past
try {
  g("init", "-q"); g("config", "core.trustctime", "false");
  writeFileSync(`${dir}/rev.txt`, "a1\na2\na3\na4\na5\na6\n"); g("add", "."); g("commit", "-qm", "c");
  // The entry records rev.txt at that second, and the index was written in the same second.
  at(`${dir}/rev.txt`); g("update-index", "--refresh"); at(`${dir}/.git/index`);
  const cap = new Capture(await Store.open(dir));
  const t0 = await cap.snapshot();
  // The agent's edit: same size, same inode, same second.
  writeFileSync(`${dir}/rev.txt`, "a1\nA2\na3\na4\na5\nA6\n"); at(`${dir}/rev.txt`);
  writeFileSync(`${dir}/made.txt`, "made\n");
  const t1 = await cap.snapshot();
  assert.deepEqual((await cap.changed(t0, t1)).map((c) => c.path).sort(), ["made.txt", "rev.txt"]);
} finally { rmSync(dir, { recursive: true, force: true }); }
