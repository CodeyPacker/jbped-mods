import { execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
// Stands in for the "herdr" module. A test answers a call itself with `fake.exec(cmd, args, opts)`,
// `fake.read(path, opts)` or `fake.write(path, text, expected)`; returning undefined falls through
// to the real call. `on` (another machine) is recorded and runs here.
export const fake = { exec: null, read: null, write: null };
export const execCalls = [];
export const runCalls = [];
export const notes = [];
export const writeCalls = [];
// Writes in flight now and at most, to prove a writer never overlaps.
export const writes = { now: 0, max: 0 };
// window().platform is "linux" unless a test sets win.platform.
export const win = { platform: "linux" };

export function reset() {
  fake.exec = fake.read = fake.write = null;
  for (const a of [execCalls, runCalls, notes, writeCalls]) a.length = 0;
  writes.now = writes.max = 0;
  win.platform = "linux";
}

export const exec = (cmd, args = [], opts = {}) => {
  execCalls.push({ cmd, args, ...opts });
  const f = fake.exec?.(cmd, args, opts);
  if (f !== undefined) return f;
  return new Promise((res, rej) =>
    execFile(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 8 << 20, timeout: opts.timeout ?? 30000 }, (e, stdout, stderr) =>
      e?.code === "ENOENT" ? rej(new Error(`cannot start ${cmd}: program not found`)) : res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));
};

const realRead = (p) => readFile(p, "utf8").catch(() => null);

export const readTextFile = (p, opts = {}) => {
  const f = fake.read?.(p, opts);
  if (f !== undefined) return f;
  return realRead(p);
};

// Compare-and-swap like Herdr: rejects when the file no longer holds `expected` (null: absent).
export async function writeTextFile(p, text, expected) {
  writeCalls.push({ path: p, text, expected });
  writes.now++; writes.max = Math.max(writes.max, writes.now);
  try {
    const f = fake.write?.(p, text, expected);
    if (f !== undefined) return await f;
    if ((await realRead(p)) !== expected) throw new Error("stale snapshot");
    await writeFile(p + ".tmp", text); await rename(p + ".tmp", p); return null;
  } finally { writes.now--; }
}

export const appHome = () => {
  if (!process.env.WRANGLR_TEST_HOME) throw new Error("WRANGLR_TEST_HOME is not set; run the tests with wranglr/tests/run.sh");
  return process.env.WRANGLR_TEST_HOME;
};
export const home = () => `${appHome()}/home`;
export const run = (name, args) => { runCalls.push({ name, args }); return null; };
export const notify = (n) => { notes.push(n); return String(notes.length); };
export const window = () => ({ platform: win.platform, titlebar: "system", buttons: false, maximized: false, fullscreen: false, active: true });
