import { execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
// `on` (another machine) runs here, recorded in `remoteCalls`. Like Herdr, a remote program that
// can't start rejects; machine "nosh" has no sh (a Windows machine).
export const remoteCalls = [];
export const exec = (cmd, args, opts = {}) => {
  if (opts.on) {
    remoteCalls.push({ cmd, args, ...opts });
    if (opts.on === "nosh" && cmd === "sh") return Promise.reject(new Error("cannot start sh: program not found"));
  }
  return new Promise((res, rej) =>
    execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8" }, (e, stdout, stderr) =>
      opts.on && e?.code === "ENOENT" ? rej(new Error(`cannot start ${cmd}: program not found`)) : res({ code: e ? (e.code ?? 1) : 0, stdout, stderr })));
};
export const readTextFile = (p, opts = {}) => { if (opts.on) remoteCalls.push({ read: p, ...opts }); return readFile(p, "utf8").catch(() => null); };
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
