// How calls are built and bounded, through the shim's fakes (no Windows needed):
// - F6: wsl.exe gets -d <distro> for a path in a distro's own files, and none for a Windows drive.
// - F5: Windows drive paths go to PowerShell as quoted literals, never through cmd.
// - F10: a call to another machine that never answers fails with "timed out" instead of hanging.
import { execCalls, fake } from "herdr";
import assert from "node:assert/strict";

const home = process.env.WINGMAN_TEST_HOME;
process.env.WINGMAN_TEST_HOME = "C:/Users/t/.config/herdr-app"; // appHome() on Windows: onWindows() is true
const { inRepo } = await import("../mods/wingman/git.js");
const { makeDir, removeFile, readOn, execOn, writeText, LIMITS, distroArgs } = await import("../mods/wingman/fsx.js");
const { addSleeper, withTimeout } = await import("../mods/wingman/remote.js");
const { Store } = await import("../mods/wingman/store.js");
const { queueFeedback } = await import("../mods/wingman/journal.js");

const ok = (stdout = "") => Promise.resolve({ code: 0, stdout, stderr: "" });
const calls = () => execCalls.splice(0);
fake.exec = (cmd, args) => {
  if (cmd === "wsl.exe" && args.includes("printf %s \"$WSL_DISTRO_NAME\"")) return ok("Ubuntu");
  if (cmd === "where") return ok("C:\\Program Files\\Git\\cmd\\git.exe\r\n");
  if (cmd === "powershell") return ok("ok\r\n");
  if (cmd === "wsl.exe") return ok("");
  return ok("");
};
// A Windows drive repo that WSL git made (its .git file points to a /mnt path); the files' texts.
fake.read = (p) => (p === "C:/dev/r/.git" ? Promise.resolve("gitdir: /mnt/c/dev/main/.git/worktrees/r\n") : /\.git(\/config)?$/.test(p) ? Promise.resolve(null) : Promise.resolve("t"));

try {
  // ---- F6
  assert.deepEqual(distroArgs("//wsl.localhost/Debian/home/u"), ["-d", "Debian"]);
  assert.deepEqual(distroArgs("\\\\wsl$\\Debian\\home\\u"), ["-d", "Debian"]);
  assert.deepEqual(distroArgs("C:/dev/r"), []);
  calls();
  await inRepo("git", ["status"], { cwd: "//wsl.localhost/Debian/home/u/r" });
  let c = calls().find((x) => x.cmd === "wsl.exe" && x.args.includes("git"));
  assert.deepEqual(c.args, ["-d", "Debian", "--cd", "/home/u/r", "-e", "git", "status"]);
  await inRepo("git", ["status"], { cwd: "C:/dev/r" });
  c = calls().find((x) => x.cmd === "wsl.exe" && x.args.includes("git"));
  assert.deepEqual(c.args, ["--cd", "/mnt/c/dev/r", "-e", "git", "status"]); // the default distro
  await makeDir("//wsl.localhost/Debian/home/u/r/.git/wingman");
  assert.deepEqual(calls().at(-1).args, ["-d", "Debian", "-e", "mkdir", "-p", "--", "/home/u/r/.git/wingman"]);
  await removeFile("//wsl.localhost/Debian/home/u/r/x.txt", "t");
  assert.deepEqual(calls().at(-1).args, ["-d", "Debian", "-e", "rm", "-f", "--", "/home/u/r/x.txt"]);

  // ---- F5: names cmd would read as its own syntax go to PowerShell as single-quoted literals
  const hostile = "C:/dev/r/a,b;c=d^e&f%PATH%g 'q'";
  await makeDir(hostile);
  await removeFile(`${hostile}/x,y.txt`, "t");
  const ps = calls();
  assert.equal(ps.filter((x) => x.cmd === "cmd").length, 0);
  assert.equal(ps.length, 2);
  assert.ok(ps.every((x) => x.cmd === "powershell"));
  assert.ok(ps[0].args.at(-1).includes("CreateDirectory") && ps[0].args.at(-1).endsWith("'C:\\dev\\r\\a,b;c=d^e&f%PATH%g ''q''' '' ''"), ps[0].args.at(-1));
  assert.ok(ps[1].args.at(-1).endsWith("'C:\\dev\\r\\a,b;c=d^e&f%PATH%g ''q''\\x,y.txt' '' ''"), ps[1].args.at(-1));
  fake.exec = (cmd) => (cmd === "powershell" ? ok("error Access to the path is denied.\r\n") : undefined);
  await assert.rejects(makeDir("C:/x"), /mkdir C:\/x: Access to the path is denied/);
  fake.exec = (cmd) => (cmd === "powershell" ? ok("missing\r\n") : undefined);
  await removeFile("C:/gone.txt", "t"); // gone meanwhile: fine

  // An external editor's .cmd launcher runs through cmd /d /c: names cmd would split or read are refused.
  const { openInEditor } = await import("../mods/wingman/nvim.js");
  fake.exec = (cmd) => (cmd === "where" ? ok("C:\\VS Code\\bin\\code.cmd\r\n") : ok(""));
  calls();
  for (const bad of ["C:/r/a,b.txt", "C:/r/a;b.txt", "C:/r/a=b.txt", "C:/r/a&b.txt", "C:/r/100%.txt"]) await assert.rejects(openInEditor("code", bad, 0), /can't pass safely/, bad);
  await openInEditor("code", "C:/r/with space.txt", 2, 3);
  assert.deepEqual(calls().filter((x) => x.cmd === "cmd").map((x) => x.args), [["/d", "/c", "code", "-g", "C:/r/with space.txt:3:4"]]);

  // ---- F10
  assert.equal(withTimeout(42, 10, "x"), 42); // no sleeper yet: nothing is timed
  const timers = new Set(), drop = addSleeper((ms) => new Promise((r) => timers.add(setTimeout(r, ms))));
  Object.assign(LIMITS, { read: 150, grace: 100 });
  const never = () => new Promise(() => {});
  fake.read = (p, o) => (o?.on ? never() : undefined);
  fake.exec = (cmd, args, o) => (o?.on ? never() : undefined);
  const t0 = Date.now();
  await assert.rejects(readOn("/r/a.txt", { on: "vps" }), /Reading \/r\/a\.txt on vps timed out/);
  await assert.rejects(execOn("sh", ["-c", "true"], { on: "vps", timeout: 50 }), /sh on vps timed out/);
  await assert.rejects(new Store("/r", "/r/.git", "vps").read("/r/.git/wingman/index.json"), /timed out/);
  // A note to Claude there: its folder is found, then reading the queued notes never answers.
  fake.exec = (cmd, args, o) => (o?.on ? (args.some((a) => /feedback/.test(a)) ? ok("dir /d") : never()) : undefined);
  await assert.rejects(queueFeedback("vps/t1", "note", { on: "vps" }), /Reading \/d\/feedback\/t1\.ctx on vps timed out/);
  assert.ok(Date.now() - t0 < 5000);
  // A save there: each step's call has its timeout (60 s), plus the grace.
  fake.exec = (cmd, args, o) => (o?.on ? never() : undefined);
  LIMITS.grace = -59900;
  await assert.rejects(writeText("/r/a.txt", "x", "y", { on: "vps" }), /sh on vps timed out/);
  LIMITS.grace = 100;
  // Git on another machine is bounded too (its own timeout plus 10 s): a short one here.
  await assert.rejects(inRepo("git", ["status"], { on: "vps", timeout: 1 }), /git on vps timed out/);
  // A call that answers in time is unaffected; a sleeper that fails (its copy closed) times nothing out.
  fake.read = (p, o) => (o?.on ? Promise.resolve("text") : undefined);
  assert.equal(await readOn("/r/a.txt", { on: "vps" }), "text");
  drop(); for (const t of timers) clearTimeout(t); // what's still waiting after its call answered
  const dropBad = addSleeper(() => Promise.reject(new Error("closed")));
  assert.equal(await withTimeout(new Promise((r) => setTimeout(() => r("late"), 300)), 10, "x"), "late");
  dropBad();
} finally { fake.exec = null; fake.read = null; process.env.WINGMAN_TEST_HOME = home; }
console.log("routes tests pass");
