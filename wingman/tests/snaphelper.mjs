// Shared by the snapshot hardening tests (snapshothard, windows/snapshothard, slow/snapshotsize):
// makes temp repos, runs a snapshot script and checks it left the repo untouched.
// A `runner` is { name, base, win, run(gitDir, dir, { redirect }) -> { code, stdout, stderr } }.
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import assert from "node:assert/strict";

export const isTree = (s) => /^[0-9a-f]{40,64}$/.test(String(s).trim().split(/\s+/).pop() ?? "");
const made = [];

/** Makes a script runner. `cmd`/`args(gitDir, dir)` start the script, `redirectArgs` the PowerShell 2>&1 form. */
export function runner(name, base, win, start) {
  return { name, base, win, run: (gitDir, dir, o = {}) => new Promise((res) =>
    start(gitDir, dir, o, (cmd, args) => execFile(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, timeout: Number(process.env.WINGMAN_SNAP_TIMEOUT) || 180000 },
      (e, stdout, stderr) => res({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })))) };
}

/** A temp dir under `base`; removed by cleanup(). */
export function tempDir(base, prefix = "snaphard-") {
  mkdirSync(base, { recursive: true });
  const d = mkdtempSync(join(base, prefix)); made.push(d); return d;
}
export function cleanup() {
  for (const d of made.splice(0)) {
    // chmod 000 leftovers and read-only git objects: make them removable first.
    try { execFileSync("chmod", ["-R", "u+rwx", d], { stdio: "ignore" }); } catch {}
    try { rmSync(d.startsWith("\\\\?\\") ? d : d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.log(`cleanup: ${d}: ${e.message}`); }
  }
}

let globalCfg = null;
/** Isolates the tests from the machine's global git config (the system config stays, as for real runs). */
export function isolate(base) {
  if (globalCfg) return;
  globalCfg = join(tempDir(base, "gitcfg-"), "empty");
  writeFileSync(globalCfg, "");
  process.env.GIT_CONFIG_GLOBAL = globalCfg; process.env.GIT_TERMINAL_PROMPT = "0";
}

export class Repo {
  constructor(dir) { this.dir = dir; }
  /** git in the repo (throws on failure). */
  git(...a) { return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...a], { cwd: this.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }); }
  /** git that reports instead of throwing. */
  try(...a) { try { return { code: 0, out: this.git(...a) }; } catch (e) { return { code: e.status ?? 1, out: String(e.stdout ?? ""), err: String(e.stderr ?? "") }; } }
  w(rel, text = "x\n") { const p = join(this.dir, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); return p; }
  path(rel) { return join(this.dir, rel); }
  get gitDir() { return this.git("rev-parse", "--absolute-git-dir").trim(); }
  commit(msg = "c") { this.git("add", "-A"); this.git("commit", "-qm", msg); }
  show(tree, rel) { return execFileSync("git", ["cat-file", "blob", `${tree}:${rel}`], { cwd: this.dir }); }
  /** Paths that differ between two trees. */
  names(a, b) { return this.git("diff-tree", "-r", "--no-renames", "--name-only", "-z", a, b).split("\0").filter(Boolean).sort(); }
}

/** A fresh repo (own dir under `base`) with `files` ({rel: text}) committed unless `commit` is false. */
export function mkRepo(base, { files = { "a.txt": "a\n", "b.txt": "b\n" }, config = {}, commit = true, init = ["init", "-q", "-b", "main"] } = {}) {
  const r = new Repo(tempDir(base));
  r.git(...init);
  for (const [k, v] of Object.entries(config)) r.git("config", k, v);
  for (const [rel, t] of Object.entries(files)) r.w(rel, t);
  if (commit && Object.keys(files).length) r.commit("init");
  return r;
}

const sha = (p) => existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
const leftovers = (gitDir) => { try { return readdirSync(join(gitDir, "wingman")).filter((n) => n.startsWith("snap.")); } catch { return []; } };
/** Everything a snapshot must not change. */
export function state(repo, gitDir = repo.gitDir) {
  const q = (...a) => repo.try("--no-optional-locks", ...a).out;
  return { index: sha(join(gitDir, "index")), status: q("status", "--porcelain=v1", "-z", "--ignored=no"),
    refs: q("for-each-ref") + q("rev-parse", "-q", "--verify", "HEAD") + q("stash", "list"), head: sha(join(gitDir, "HEAD")) };
}

/**
 * Runs the snapshot and checks the repo is untouched and nothing is left behind. Returns { tree, r }.
 * `fail`: the script is expected to fail (non-zero exit), cleanly.
 */
export async function snap(runner, repo, { fail = false, redirect = false } = {}) {
  const gitDir = repo.gitDir, before = state(repo, gitDir);
  const r = await runner.run(gitDir, repo.dir, { redirect });
  const after = state(repo, gitDir);
  assert.deepEqual(after, before, "the snapshot changed the real index, status, refs or stash");
  assert.deepEqual(leftovers(gitDir), [], "a snap.* file was left behind");
  if (fail) { assert.notEqual(r.code, 0, "expected the snapshot to fail"); return { tree: null, r }; }
  assert.equal(r.code, 0, `exit ${r.code}: ${r.stderr}${r.stdout}`);
  const tree = redirect ? (r.stdout.split(/\r?\n/).filter((l) => /^[0-9a-f]{40,64}$/.test(l.trim())).pop() ?? "").trim() : r.stdout.trim();
  assert.ok(isTree(tree), `no tree id in: ${r.stdout}`);
  assert.equal(repo.git("cat-file", "-t", tree).trim(), "tree");
  return { tree, r };
}

/** Snapshot, edit `rel`, snapshot again: the trees differ by exactly `rel`. */
export async function roundTrip(runner, repo, rel, text = "edited\n", opts = {}) {
  const a = await snap(runner, repo, opts);
  repo.w(rel, text);
  const b = await snap(runner, repo, opts);
  assert.notEqual(a.tree, b.tree, "the edit did not change the tree");
  assert.deepEqual(repo.names(a.tree, b.tree), [rel]);
  return { a, b };
}

/** The tree git itself makes of the working tree on a copy of the index, with extra `-c` options. */
export function manualTree(repo, ...c) {
  const gitDir = repo.gitDir, tmp = join(gitDir, "manual.index");
  // the copy keeps the index's time, as the scripts' copy does (the racy-index rule, see racyindex.test.mjs)
  if (existsSync(join(gitDir, "index"))) { writeFileSync(tmp, readFileSync(join(gitDir, "index"))); const st = statSync(join(gitDir, "index")); utimesSync(tmp, st.atime, st.mtime); }
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  try {
    execFileSync("git", [...c.flatMap((x) => ["-c", x]), "add", "-A"], { cwd: repo.dir, env, stdio: "ignore" });
    return execFileSync("git", ["write-tree"], { cwd: repo.dir, env, encoding: "utf8" }).trim();
  } finally { rmSync(tmp, { force: true }); rmSync(`${tmp}.lock`, { force: true }); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
