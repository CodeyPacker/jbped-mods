// Helpers for tests that need real git repos, always under the runner's temp home.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The code under test runs git with the process environment: give it an identity and no user config.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C",
});

export const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const commit = (cwd, msg = "c") => { g(cwd, "commit", "-q", "--allow-empty", "-m", msg); return g(cwd, "rev-parse", "HEAD"); };
export const write = (cwd, name, text = "x\n") => writeFileSync(join(cwd, name), text);
export const commitFile = (cwd, name, text, msg = `add ${name}`) => { write(cwd, name, text); g(cwd, "add", name); g(cwd, "commit", "-q", "-m", msg); };

/** A fresh folder under the runner's temp home. */
export const tmpDir = () => realpathSync(mkdtempSync(join(process.env.GITR_TEST_HOME, "t-")));

/** A repo on main with one commit. */
export function repo(dir = tmpDir()) {
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  commit(dir, "one");
  return dir;
}
