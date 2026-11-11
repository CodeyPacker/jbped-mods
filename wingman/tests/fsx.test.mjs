import { join, dirname, basename, listDir, pathKind, readText } from "../mods/wingman/fsx.js";
import { remoteCalls } from "herdr";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

// ---- path helpers
assert.equal(join("C:/dev", "x", "y.js"), "C:/dev/x/y.js"); assert.equal(join("C:", "x"), "C:/x"); assert.equal(join("C:\\dev\\", "\\x\\"), "C:/dev/x");
assert.equal(join("//wsl.localhost/Ubuntu", "home", "j"), "//wsl.localhost/Ubuntu/home/j"); assert.equal(join("\\\\wsl$\\Ubuntu\\home", "j"), "//wsl$/Ubuntu/home/j");
assert.equal(join("/", "a"), "/a"); assert.equal(join("/a/", "/b/", "c/"), "/a/b/c"); assert.equal(join("a", "b"), "a/b"); assert.equal(join("a/../b", "c"), "a/../b/c");
assert.equal(join("/a", "", null, "b"), "/a/b"); assert.equal(join(), ".");
assert.equal(dirname("C:/a/b"), "C:/a"); assert.equal(dirname("C:/a"), "C:/"); assert.equal(dirname("C:/"), "C:/"); assert.equal(dirname("C:\\a\\b\\"), "C:/a");
assert.equal(dirname("//wsl.localhost/Ubuntu/home"), "//wsl.localhost/Ubuntu"); assert.equal(dirname("//wsl.localhost/Ubuntu"), "//wsl.localhost/Ubuntu");
assert.equal(dirname("/a/b/"), "/a"); assert.equal(dirname("/a"), "/"); assert.equal(dirname("/"), "/"); assert.equal(dirname("a"), "."); assert.equal(dirname("a/b"), "a");
assert.equal(basename("C:/a/b.js"), "b.js"); assert.equal(basename("/a/b/"), "b"); assert.equal(basename("C:/"), ""); assert.equal(basename("/"), "");
assert.equal(basename("//wsl.localhost/Ubuntu/home"), "home"); assert.equal(basename("//wsl.localhost/Ubuntu"), ""); assert.equal(basename("x"), "x");

// ---- a real folder
const root = await mkdtemp(pjoin(tmpdir(), "wingman-fsx-"));
try {
  const names = { sub: true, "file.txt": false, ".env": false, "with space": false, "it's": false, "$(x)": false, "`y`": false, "中文名": true, "link-dir": true, dangling: false };
  await mkdir(pjoin(root, "sub")); await mkdir(pjoin(root, "中文名")); await mkdir(pjoin(root, ".git"));
  for (const n of ["file.txt", ".env", "with space", "it's", "$(x)", "`y`", "中文名/a"]) await writeFile(pjoin(root, n), "hi");
  await symlink("sub", pjoin(root, "link-dir")); await symlink("missing", pjoin(root, "dangling"));
  const { entries, more } = await listDir(root);
  assert.equal(more, false);
  assert.deepEqual(Object.fromEntries(entries.map((e) => [e.name, e.dir])), names);
  assert.ok(!entries.some((e) => e.name === ".git"));

  const cut = await listDir(root, { limit: 3 });
  assert.equal(cut.entries.length, 3); assert.equal(cut.more, true);
  const exact = await listDir(root, { limit: Object.keys(names).length });
  assert.equal(exact.entries.length, Object.keys(names).length); assert.equal(exact.more, false);
  assert.deepEqual((await listDir(pjoin(root, "中文名"))).entries, [{ name: "a", dir: false }]);
  const empty = pjoin(root, "sub"); assert.deepEqual(await listDir(empty), { entries: [], more: false });

  await assert.rejects(listDir(pjoin(root, "nope")), /Not a folder/);
  await assert.rejects(listDir(pjoin(root, "file.txt")), /Not a folder/);

  assert.equal(await pathKind(root), "dir"); assert.equal(await pathKind(pjoin(root, "link-dir")), "dir");
  assert.equal(await pathKind(pjoin(root, "it's")), "file"); assert.equal(await pathKind(pjoin(root, "$(x)")), "file");
  assert.equal(await pathKind(pjoin(root, "dangling")), "file"); assert.equal(await pathKind(pjoin(root, "nope")), null);
  assert.equal(await readText(pjoin(root, "with space")), "hi"); assert.equal(await readText(pjoin(root, "nope")), null);

  // ---- another machine: sh runs there with the path as an argument
  remoteCalls.length = 0;
  assert.equal((await listDir(root, { on: "vps" })).entries.length, Object.keys(names).length);
  assert.equal(await pathKind(pjoin(root, "sub"), { on: "vps" }), "dir");
  assert.equal(await readText(pjoin(root, "file.txt"), { on: "vps" }), "hi");
  assert.deepEqual(remoteCalls.map((c) => [c.cmd ?? "read", c.on, c.args?.[0]]), [["sh", "vps", "-c"], ["sh", "vps", "-c"], ["read", "vps", undefined]]);
  assert.equal(remoteCalls[0].args.at(-2), root);

  // A machine without sh is Windows: PowerShell there (absent here, so it rejects), and sh isn't tried again.
  remoteCalls.length = 0;
  await assert.rejects(listDir("C:/x", { on: "nosh" }), /cannot start powershell/);
  assert.equal(await pathKind("C:/x", { on: "nosh" }), null);
  assert.deepEqual(remoteCalls.map((c) => c.cmd), ["sh", "powershell", "powershell"]);
  assert.match(remoteCalls[1].args.at(-1), / 'C:\\x'$/);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("fsx tests pass");
