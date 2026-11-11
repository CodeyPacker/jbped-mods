import { parseJsonc, withFolders, pickFile, joinPath, relTo, foldersOf, sharedBranch, worktreeDest, scanRepos, repoInfo, addWorktree, removeWorktree } from "../mods/wingman/workspace.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

// JSONC
assert.deepEqual(parseJsonc('{ // c\n "folders": [ {"path": "a//b"}, /* x */ ], "s": "/*no*/", }'), { folders: [{ path: "a//b" }], s: "/*no*/" });

// withFolders keeps every other byte.
const vs = '{\n\t// my workspace\n\t"folders": [\n\t\t{\n\t\t\t"path": "api"\n\t\t}\n\t],\n\t"settings": { "editor.tabSize": 2, "x": ["folders"] }\n}\n';
const out = withFolders(vs, [{ path: "api" }, { path: "../web", name: "web" }]);
assert.equal(out, '{\n\t// my workspace\n\t"folders": [\n\t\t{ "path": "api" },\n\t\t{ "path": "../web", "name": "web" }\n\t],\n\t"settings": { "editor.tabSize": 2, "x": ["folders"] }\n}\n');
assert.deepEqual(parseJsonc(out).settings, { "editor.tabSize": 2, x: ["folders"] });
assert.equal(withFolders(vs, []).includes('"folders": [],'), true);
// Nested "folders" keys aren't the top-level one.
const nested = '{\n  "settings": { "folders": [1] },\n  "folders": [ { "path": "a" } ]\n}';
assert.deepEqual(parseJsonc(withFolders(nested, [{ path: "b" }])), { settings: { folders: [1] }, folders: [{ path: "b" }] });
assert.equal(withFolders(nested, [{ path: "b" }]).includes('\n    { "path": "b" }'), true); // spaces indent kept
// New file, and a file with no folders key.
assert.deepEqual(parseJsonc(withFolders(null, [{ path: "a" }, { path: "b" }])), { folders: [{ path: "a" }, { path: "b" }], settings: {} });
assert.deepEqual(parseJsonc(withFolders('{\n\t"settings": {}\n}', [{ path: "a" }])), { folders: [{ path: "a" }], settings: {} });
assert.deepEqual(parseJsonc(withFolders("{}", [{ path: "a" }])), { folders: [{ path: "a" }] });

// Which file
assert.equal(pickFile(["b.code-workspace", "T1.code-workspace", "x.txt"], "t1"), "T1.code-workspace");
assert.equal(pickFile(["b.code-workspace", "a.code-workspace"], "t1"), "a.code-workspace");
assert.equal(pickFile(["x.json"], "t1"), null);

// Paths
assert.equal(joinPath("C:/w/t1", "api"), "C:/w/t1/api");
assert.equal(joinPath("C:/w/t1", "..\\shared\\.\\lib"), "C:/w/shared/lib");
assert.equal(joinPath("C:/w/t1", "D:\\x"), "D:/x");
assert.equal(joinPath("//wsl.localhost/Ubuntu/home/j/t1", "../r"), "//wsl.localhost/Ubuntu/home/j/r");
assert.equal(joinPath("/home/j/t1", "./api/"), "/home/j/t1/api");
assert.equal(relTo("C:/w/t1", "c:/w/t1/api"), "api");
assert.equal(relTo("C:/w/t1", "C:/w/t10/api"), "C:/w/t10/api");
assert.equal(relTo("/home/j/t1", "/home/j/other"), "/home/j/other");
assert.equal(relTo("/home/j/t1", "/home/j/t1"), ".");
assert.deepEqual(foldersOf('{"folders":[{"path":"api"},{"path":"../web","name":" Web "},{"path":""},{"x":1}]}', "/w/t1"),
  [{ path: "/w/t1/api", name: null, i: 0 }, { path: "/w/web", name: "Web", i: 1 }]);
assert.deepEqual(foldersOf('{"settings":{}}', "/w"), []);

// Worktrees
assert.equal(sharedBranch(["123-fix", "123-fix", "HEAD"]), "123-fix");
assert.equal(sharedBranch(["a", "b"]), null);
assert.equal(sharedBranch([]), null);
assert.equal(worktreeDest(["/w/t1/api", "/w/t1/web/"], "lib"), "/w/t1/lib");
assert.equal(worktreeDest(["/w/t1/api", "/x/web"], "lib"), null);
assert.equal(worktreeDest([], "lib"), null);

// Real repos: scan, worktree info, add and remove.
const dir = mkdtempSync(`${tmpdir()}/ws-`), g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
try {
  for (const r of ["api", "web"]) { mkdirSync(`${dir}/${r}`); g(`${dir}/${r}`, "init", "-q", "-b", "main"); writeFileSync(`${dir}/${r}/f`, "1"); g(`${dir}/${r}`, "add", "."); g(`${dir}/${r}`, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "1"); }
  mkdirSync(`${dir}/notes`);
  assert.deepEqual(await scanRepos(dir + "/"), [`${dir}/api`, `${dir}/web`]);
  const main = await repoInfo(`${dir}/api`);
  assert.equal(main.linked, false); assert.equal(main.branch, "main");
  mkdirSync(`${dir}/t1`);
  await addWorktree(`${dir}/api`, `${dir}/t1/api`, "t1-task");
  const wt = await repoInfo(`${dir}/t1/api`);
  assert.equal(wt.linked, true); assert.equal(wt.branch, "t1-task"); assert.equal(wt.common, `${dir}/api/.git`);
  await addWorktree(`${dir}/web`, `${dir}/t1/web`, "t1-task");
  assert.equal((await repoInfo(`${dir}/t1/web`)).branch, "t1-task");
  // The branch exists already: the second worktree uses it.
  g(`${dir}/t1/web`, "switch", "-q", "-c", "other"); g(`${dir}/web`, "worktree", "remove", `${dir}/t1/web`);
  await addWorktree(`${dir}/web`, `${dir}/t1/web`, "t1-task");
  assert.equal((await repoInfo(`${dir}/t1/web`)).branch, "t1-task");
  writeFileSync(`${dir}/t1/web/new`, "x");
  await assert.rejects(removeWorktree(`${dir}/t1/web`), /untracked|modified/);
  await removeWorktree(`${dir}/t1/api`);
  assert.equal(existsSync(`${dir}/t1/api`), false);
  await assert.rejects(removeWorktree(`${dir}/api`), /not a linked worktree/);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("workspace tests pass");
