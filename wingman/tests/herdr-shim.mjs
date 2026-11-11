import { execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
export const exec = (cmd, args, opts = {}) => new Promise((res) =>
  execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8" }, (e, stdout, stderr) => res({ code: e ? (e.code ?? 1) : 0, stdout, stderr })));
export const readTextFile = (p) => readFile(p, "utf8").catch(() => null);
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
