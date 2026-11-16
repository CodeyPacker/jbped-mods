// Runs a repo's tool where the repo's tools live (toolpath.js): Inline edit's command, Format on
// save's formatter and Problems' checkers all come through here. The PATH probe runs once per
// machine and is kept for the session (a failed one is tried again after a minute); `where` is
// kept a minute per folder and program.
import { exec } from "herdr";
import { execOn } from "./fsx.js";
import { onWindows, ownerOf, toWsl, distroOf, wslArg } from "./git.js";
import { PROBE_SH, PROBE_MS, PROBE_RETRY_MS, parseProbe, probeKey, plan, exeFrom } from "./toolpath.js";

const probes = new Map(); // probeKey -> { at, path: Promise<string|null> }
const wheres = new Map(); // "<root>|<on>|<name>" -> { at, where }
const WHERE_MS = 60000;

/** Asks the user's shell on that machine for its PATH (toolpath.js PROBE_SH). Resolves the PATH or null; never rejects. */
async function askPath(where) {
  try {
    const args = ["-c", PROBE_SH];
    const r = where.on ? await execOn("sh", args, { on: where.on, timeout: PROBE_MS })
      : where.windows ? await exec("wsl.exe", [...(where.distro ? ["-d", where.distro] : []), "-e", "sh", ...args], { timeout: PROBE_MS })
      : await exec("sh", args, { timeout: PROBE_MS });
    return r.code === 0 ? parseProbe(r.stdout) : null;
  } catch { return null; }
}

/** The probed PATH for `where`'s machine ("" when there's none to use: a native Windows program, or the probe failed). */
export async function toolPath(where) {
  const key = probeKey(where);
  if (!key) return "";
  let p = probes.get(key);
  if (!p || (p.failed && Date.now() - p.at > PROBE_RETRY_MS)) {
    p = { at: Date.now(), failed: false, path: askPath(where) };
    probes.set(key, p);
    p.path.then((v) => { if (!v) p.failed = true; });
  }
  return (await p.path) ?? "";
}

/**
 * Where program `name` runs for the folder `root` (on machine `on`): the `where` toolpath.plan takes,
 * with the probed PATH. Windows: a repo WSL owns runs in WSL; another runs the native .exe that
 * `where` finds (or the full path given), else WSL's.
 */
export async function toolWhere(root, on, name, timeout) {
  const k = `${root}|${on ?? ""}|${name}`, c = wheres.get(k);
  let where = c && Date.now() - c.at < WHERE_MS ? c.where : null;
  if (!where) {
    if (on) where = { how: "remote", on, cwd: root };
    else if (!onWindows()) where = { how: "sh", cwd: root };
    else {
      const owner = await ownerOf(root);
      let nativeExe = null;
      if (owner !== "wsl") {
        if (/^[A-Za-z]:[\\/].*\.exe$/i.test(name)) nativeExe = name;
        else { const w = await exec("where", [name]).catch(() => null); nativeExe = w?.code === 0 ? exeFrom(w.stdout) : null; }
      }
      where = { how: owner !== "wsl" && nativeExe ? "native" : "wsl", windows: true, owner, nativeExe, cwd: root, wslCwd: toWsl(root), distro: distroOf(root) };
    }
    wheres.set(k, { at: Date.now(), where });
  }
  return { ...where, timeout, path: await toolPath(where) };
}

/**
 * Runs `argv` in the folder `cwd` of the repo at `root` (machine `on`), where its tools live.
 * `paths`: Windows paths in argv become WSL paths when it runs in WSL (a formatter's file
 * arguments); off for a prompt, which is text. Resolves { code, stdout, stderr }; rejects when it
 * can't start or times out.
 */
export async function runTool(argv, { root, cwd = root, on = null, timeout, paths = false }) {
  const w = await toolWhere(root, on, argv[0], timeout);
  const av = paths && w.how === "wsl" ? argv.map(wslArg) : argv;
  const p = plan(av, { ...w, cwd, wslCwd: toWsl(cwd), distro: distroOf(cwd) ?? w.distro });
  return p.opts.on ? execOn(p.cmd, p.args, p.opts) : exec(p.cmd, p.args, p.opts);
}
