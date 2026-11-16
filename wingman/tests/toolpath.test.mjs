// toolpath.js: the PATH of the user's shell (PROBE_SH, parseProbe), the wrapper every tool runs
// under (TOOL_SH) with its fallback, and where a probe applies (probeKey). The scripts run for
// real here, with a made-up HOME.
import { PROBE_SH, TOOL_SH, parseProbe, probeKey, plan, MAX_PATH } from "../mods/wingman/toolpath.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// ---- parseProbe: the marked line only, absolute entries, no control characters ----
assert.equal(parseProbe("Welcome!\n__WINGMAN_PATH__/a/bin:/usr/bin__WINGMAN_END__\n"), "/a/bin:/usr/bin");
assert.equal(parseProbe("x __WINGMAN_PATH__/fake__WINGMAN_END__\nmore\n__WINGMAN_PATH__/real:/bin__WINGMAN_END__\n"), "/real:/bin", "the last marked line wins over a banner");
assert.equal(parseProbe("__WINGMAN_PATH__rel:/ok::/ok:/x\u001b[31m:/bin__WINGMAN_END__"), "/ok:/bin", "relative, empty, repeated and control-character entries dropped");
assert.equal(parseProbe("no marker"), null);
assert.equal(parseProbe("__WINGMAN_PATH__relative:only__WINGMAN_END__"), null);
assert.equal(parseProbe(""), null);
assert.equal(parseProbe(null), null);
assert.ok(parseProbe(`__WINGMAN_PATH__${Array.from({ length: 3000 }, (_, i) => `/p${i}/bin`).join(":")}__WINGMAN_END__`).length <= MAX_PATH);

// ---- probeKey: one probe per machine; a native Windows program has none ----
assert.equal(probeKey({ how: "sh" }), "local");
assert.equal(probeKey({ how: "remote", on: "box" }), "on:box");
assert.equal(probeKey({ how: "wsl", windows: true, distro: "Ubuntu" }), "wsl:Ubuntu");
assert.equal(probeKey({ how: "native", windows: true }), null);

// ---- plan: the PATH rides as an argument; the script text never changes ----
assert.deepEqual(plan(["node", "x.js"], { cwd: "/r", path: "/n/bin:/bin" }).args, ["-lc", TOOL_SH, "wingman", "/n/bin:/bin", "node", "x.js"]);
assert.deepEqual(plan(["node", "x.js"], { cwd: "/r", path: null }).args.slice(0, 4), ["-lc", TOOL_SH, "wingman", ""]);

const home = mkdtempSync(join(tmpdir(), "wingman-tp-"));
const env = (extra = {}) => ({ HOME: home, PATH: "/usr/bin:/bin", ...extra });
const pathIn = (path, extra) => execFileSync("sh", ["-c", TOOL_SH, "wingman", path, "sh", "-c", 'printf %s "$PATH"'], { encoding: "utf8", env: env(extra) });
try {
  // A probed PATH replaces the inherited one; Claude Code's folders come first.
  assert.equal(pathIn("/probed/bin:/usr/bin"), `${home}/.local/bin:${home}/.claude/local:/probed/bin:/usr/bin`);

  // No probed PATH: the newest nvm Node (by version, not by name: v9 < v18 < v22.10 < v22.11), volta and fnm's default.
  for (const v of ["v9.11.2", "v18.20.4", "v22.10.0", "v22.11.0", "vbad", "v20.1.0-rc"]) {
    mkdirSync(join(home, ".nvm/versions/node", v, "bin"), { recursive: true });
    writeFileSync(join(home, ".nvm/versions/node", v, "bin/node"), "#!/bin/sh\n"); chmodSync(join(home, ".nvm/versions/node", v, "bin/node"), 0o755);
  }
  mkdirSync(join(home, ".nvm/versions/node/v99.0.0/bin"), { recursive: true }); // no node in it: skipped
  mkdirSync(join(home, ".volta/bin"), { recursive: true });
  mkdirSync(join(home, ".local/share/fnm/aliases/default/bin"), { recursive: true });
  assert.equal(pathIn(""), `${home}/.local/bin:${home}/.claude/local:${home}/.nvm/versions/node/v22.11.0/bin:${home}/.local/share/fnm/aliases/default/bin:${home}/.volta/bin:/usr/bin:/bin`);

  // The program and its arguments reach it unparsed (a PATH with shell syntax is just a string).
  const canary = join(home, "pwned");
  const evil = `$(touch ${canary});touch ${canary}`;
  const out = execFileSync("sh", ["-c", TOOL_SH, "wingman", `/bin:${evil}`, "printf", "%s|", evil, "a b"], { encoding: "utf8", env: env() });
  assert.equal(out, `${evil}|a b|`);
  assert.equal(existsSync(canary), false);

  // PROBE_SH with bash as the login shell: the interactive startup files' PATH (nvm-style, from
  // .bashrc), with a banner printed around it that doesn't get in.
  const hasBash = (() => { try { execFileSync("bash", ["-c", "true"]); return true; } catch { return false; } })();
  if (hasBash) {
    writeFileSync(join(home, ".bash_profile"), '. "$HOME/.bashrc"\n');
    writeFileSync(join(home, ".bashrc"), 'echo "Welcome __WINGMAN_PATH__/banner__WINGMAN_END__"\ncase $- in *i*) ;; *) return ;; esac\nexport PATH="$HOME/.nvm/versions/node/v22.11.0/bin:$PATH"\necho bye\n');
    const r = execFileSync("sh", ["-c", PROBE_SH], { encoding: "utf8", env: env({ SHELL: "/bin/bash" }), stdio: ["ignore", "pipe", "ignore"] });
    const got = parseProbe(r); // /etc/profile may add more after
    assert.ok(got.startsWith(`${home}/.nvm/versions/node/v22.11.0/bin:/usr/bin:/bin`), got);
    assert.ok(!got.includes("/banner"), got);
  }
  // A shell that prints its PATH another way (fish) isn't asked: no marker, so the fallback applies.
  let code = 0;
  try { execFileSync("sh", ["-c", PROBE_SH], { env: env({ SHELL: "/usr/bin/fish" }), stdio: "ignore" }); } catch (e) { code = e.status; }
  assert.equal(code, 3);
  try { execFileSync("sh", ["-c", PROBE_SH], { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdio: "ignore" }); code = 0; } catch (e) { code = e.status; }
  assert.equal(code, 3, "no SHELL: not asked");
} finally { rmSync(home, { recursive: true, force: true }); }
