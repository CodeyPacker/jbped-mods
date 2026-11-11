import { execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
// `on` (another machine) runs here, recorded in `remoteCalls`. Like Herdr, a remote program that
// can't start rejects; machine "nosh" has no sh (a Windows machine).
// With WINGMAN_REMOTE_HC set (the path of hc.exe or hc), machine WINGMAN_REMOTE_ON (default "wsl")
// is reached for real, through `hc exec --on` and `hc file read --on`, the route a mod's call takes.
export const remoteCalls = [];
const hcRoute = (on) => process.env.WINGMAN_REMOTE_HC && on === (process.env.WINGMAN_REMOTE_ON || "wsl") ? process.env.WINGMAN_REMOTE_HC : null;
const hcJson = (hcPath, args) => new Promise((res, rej) =>
  execFile(hcPath, args, { encoding: "utf8", maxBuffer: 64 << 20 }, (_e, stdout, stderr) => {
    // Errors come as JSON on stderr.
    try { res(JSON.parse(stdout || stderr)); } catch { rej(new Error(`hc: ${String(stdout || stderr).slice(0, 200)}`)); }
  }));
const b64 = (s) => Buffer.from(s ?? "", "base64").toString("utf8");
export const exec = (cmd, args, opts = {}) => {
  if (opts.on) {
    remoteCalls.push({ cmd, args, ...opts });
    const hcPath = hcRoute(opts.on);
    if (hcPath) {
      const t = opts.timeout ? ["--timeout", String(Math.max(1, Math.ceil(opts.timeout / 1000)))] : [];
      return hcJson(hcPath, ["exec", "--json", "--on", opts.on, ...(opts.cwd ? ["--cwd", opts.cwd] : []), ...t, "--", cmd, ...args])
        .then((j) => { if (j.error) throw new Error(j.error.message); return { code: j.code, stdout: b64(j.stdout), stderr: b64(j.stderr) }; });
    }
    if (opts.on === "nosh" && cmd === "sh") return Promise.reject(new Error("cannot start sh: program not found"));
  }
  return new Promise((res, rej) =>
    execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8" }, (e, stdout, stderr) =>
      opts.on && e?.code === "ENOENT" ? rej(new Error(`cannot start ${cmd}: program not found`)) : res({ code: e ? (e.code ?? 1) : 0, stdout, stderr })));
};
export const readTextFile = (p, opts = {}) => {
  if (opts.on) {
    remoteCalls.push({ read: p, ...opts });
    const hcPath = hcRoute(opts.on);
    if (hcPath) return hcJson(hcPath, ["file", "read", "--json", "--on", opts.on, p]).then((j) => {
      if (j.error?.kind === "not_found") return null;
      if (j.error) throw new Error(j.error.message);
      return j.text;
    });
  }
  return readFile(p, "utf8").catch(() => null);
};
export async function writeTextFile(p, text, expected) {
  if ((await readTextFile(p)) !== expected) throw new Error("stale snapshot");
  await writeFile(p + ".tmp", text); await rename(p + ".tmp", p); return null;
}
export const appHome = () => {
  if (!process.env.WINGMAN_TEST_HOME) throw new Error("WINGMAN_TEST_HOME is not set; run the tests with wingman/tests/run.sh");
  return process.env.WINGMAN_TEST_HOME;
};
export const terminals = () => [];
export const run = () => null;
export const agents = () => [];
