import { toWsl, fromWsl, wslArg, ownerFrom, distroOf, ownerOf, git, inRepo, hostOf } from "../mods/wingman/git.js";
import { remoteCalls } from "herdr";
import assert from "node:assert/strict";
assert.equal(toWsl("C:/dev/x"), "/mnt/c/dev/x"); assert.equal(toWsl("C:\\dev\\x y"), "/mnt/c/dev/x y"); assert.equal(toWsl("C:"), "/mnt/c");
assert.equal(toWsl("//wsl.localhost/Ubuntu/home/j/r"), "/home/j/r"); assert.equal(toWsl("\\\\wsl$\\Ubuntu\\home"), "/home"); assert.equal(toWsl("/home/j"), "/home/j");
assert.equal(fromWsl("/mnt/c/dev/x", "Ubuntu"), "C:/dev/x"); assert.equal(fromWsl("/home/j/r", "Ubuntu"), "//wsl.localhost/Ubuntu/home/j/r"); assert.equal(fromWsl("/home/j", null), "/home/j");
assert.equal(distroOf("//wsl.localhost/Ubuntu-24.04/x"), "Ubuntu-24.04"); assert.equal(distroOf("C:/x"), null);
assert.equal(wslArg("C:/Users/x/tmp/1"), "/mnt/c/Users/x/tmp/1"); assert.equal(wslArg("HEAD:src/a.js"), "HEAD:src/a.js"); assert.equal(wslArg("--"), "--"); assert.equal(wslArg("-U0"), "-U0");
assert.equal(ownerFrom("gitdir: /mnt/c/dev/r/.git/worktrees/w\n", null), "wsl");
assert.equal(ownerFrom("gitdir: C:/dev/r/.git/worktrees/w\n", null), "native");
assert.equal(ownerFrom("gitdir: ../r/.git/worktrees/w\n", null), "native");
assert.equal(ownerFrom(null, "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n[remote \"o\"]\n"), "wsl");
assert.equal(ownerFrom(null, "[core]\n\tfilemode = false\n\tbare = false\n"), "native");
assert.equal(ownerFrom(null, "[core]\n\tbare = false\n[x]\n\tfilemode = true\n"), null);
// Off Windows everything is the machine's own git.
assert.equal(await ownerOf("/tmp"), "native");
assert.equal((await git(["--version"])).code, 0);
// Another machine runs its own program there, with no WSL routing or filemode override.
remoteCalls.length = 0;
assert.equal(await ownerOf("//wsl.localhost/Ubuntu/home/j", "vps"), "native");
assert.equal((await git(["--version"], { cwd: "/tmp", on: "vps", timeout: 5000 })).code, 0);
assert.equal((await inRepo("sh", ["-c", "pwd"], { cwd: "/tmp", on: "vps" })).stdout.trim(), "/tmp");
assert.equal(await hostOf(" C:\\r\\a.js\n", "C:/r", "vps"), "C:\\r\\a.js");
assert.deepEqual(remoteCalls.map(({ cmd, args, cwd, on, timeout }) => [cmd, args, cwd, on, timeout]),
  [["git", ["--version"], "/tmp", "vps", 5000], ["sh", ["-c", "pwd"], "/tmp", "vps", undefined]]);
console.log("git tests pass");
