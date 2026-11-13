import { execFile } from "node:child_process";
import { readFile, writeFile, rename, stat } from "node:fs/promises";
// `on` (another machine) runs here, recorded in `remoteCalls`. Like Herdr, a remote program that
// can't start rejects; machine "nosh" has no sh (a Windows machine).
// With WINGMAN_REMOTE_HC set (the path of hc.exe or hc), machine WINGMAN_REMOTE_ON (default "wsl")
// is reached for real, through `hc exec --on` and `hc file read --on`, the route a mod's call takes.
export const remoteCalls = [];
// Like Herdr, a local read of a text file over 1 MiB rejects (it never truncates).
export const READ_LIMIT = 1048576;
// Tests may stand in for a call: `fake.exec(cmd, args, opts)` / `fake.read(path, opts)` returning
// undefined falls through to the real call. Every exec here is recorded in `execCalls`.
export const fake = { exec: null, read: null };
export const execCalls = [];
const hcRoute = (on) => process.env.WINGMAN_REMOTE_HC && on === (process.env.WINGMAN_REMOTE_ON || "wsl") ? process.env.WINGMAN_REMOTE_HC : null;
const hcJson = (hcPath, args) => new Promise((res, rej) =>
  execFile(hcPath, args, { encoding: "utf8", maxBuffer: 64 << 20 }, (_e, stdout, stderr) => {
    // Errors come as JSON on stderr.
    try { res(JSON.parse(stdout || stderr)); } catch { rej(new Error(`hc: ${String(stdout || stderr).slice(0, 200)}`)); }
  }));
const b64 = (s) => Buffer.from(s ?? "", "base64").toString("utf8");
export const exec = (cmd, args, opts = {}) => {
  execCalls.push({ cmd, args, ...opts });
  const f = fake.exec?.(cmd, args, opts);
  if (f !== undefined) return f;
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
    execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 64 << 20 }, (e, stdout, stderr) =>
      opts.on && e?.code === "ENOENT" ? rej(new Error(`cannot start ${cmd}: program not found`)) : res({ code: e ? (e.code ?? 1) : 0, stdout, stderr })));
};
export const readTextFile = (p, opts = {}) => {
  const f = fake.read?.(p, opts);
  if (f !== undefined) return f;
  if (opts.on) {
    remoteCalls.push({ read: p, ...opts });
    const hcPath = hcRoute(opts.on);
    if (hcPath) return hcJson(hcPath, ["file", "read", "--json", "--on", opts.on, p]).then((j) => {
      if (j.error?.kind === "not_found") return null;
      if (j.error) throw new Error(j.error.message);
      return j.text;
    });
  }
  if (opts.on) return readFile(p, "utf8").catch(() => null);
  return stat(p).then((s) => { if (s.isFile() && s.size > READ_LIMIT) throw new Error("Text file exceeds 1 MiB"); }, () => {})
    .then(() => readFile(p, "utf8").catch(() => null));
};
export async function writeTextFile(p, text, expected) {
  if ((await readTextFile(p)) !== expected) throw new Error("stale snapshot");
  await writeFile(p + ".tmp", text); await rename(p + ".tmp", p); return null;
}
export const appHome = () => {
  if (!process.env.WINGMAN_TEST_HOME) throw new Error("WINGMAN_TEST_HOME is not set; run the tests with wingman/tests/run.sh");
  return process.env.WINGMAN_TEST_HOME;
};
// Herdr's live state, which a test sets: spaces(), agents(), panes(), terminals(), layout(), and
// the shared() values. hc() calls are recorded in `hcCalls` and answer code 0.
export const world = { spaces: [], agents: [], panes: [], terminals: [], layout: null, shared: new Map() };
export const hcCalls = [];
export const terminals = () => world.terminals;
export const run = () => null;
export const agents = () => world.agents;
export const spaces = () => world.spaces;
export const panes = () => world.panes;
export const layout = () => world.layout;
export const shared = (k) => world.shared.get(k);
export const setShared = (k, v) => { world.shared.set(k, v); return null; };
export const props = () => world.props ?? null;
export const hc = async (args) => { hcCalls.push(args); return { code: 0, stdout: "", stderr: "" }; };
// watchFolder(dir) waits until a test calls emitWatch(dir, paths) (resolves every call waiting on
// dir, returns how many); a dir in `watch.fail` rejects. `watch.calls` records each call.
export const watch = { waiting: new Map(), calls: [], fail: new Set() };
export const watchFolder = (dir) => {
  watch.calls.push(dir);
  if (watch.fail.has(dir)) return Promise.reject(new Error("watch failed"));
  return new Promise((res) => { if (!watch.waiting.has(dir)) watch.waiting.set(dir, []); watch.waiting.get(dir).push(res); });
};
export const emitWatch = (dir, paths) => {
  const w = watch.waiting.get(dir) ?? [];
  watch.waiting.delete(dir);
  for (const r of w) r(paths);
  return w.length;
};
