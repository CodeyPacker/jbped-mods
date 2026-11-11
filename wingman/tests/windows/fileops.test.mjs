// Windows only (Windows Node and WSL), not in run.sh's set: the Explorer's file operations through
// PowerShell (drive paths) and through wsl.exe (WSL's own files). From the tests folder in cmd:
//   set "WINGMAN_TEST_HOME=%TEMP%"&& node --import ./register.mjs windows/fileops.test.mjs
import { createFile, createDir, movePath, deleteFile, deleteTree, pathKind, makeDir, removeFile } from "../../mods/wingman/fsx.js";
import { exec } from "herdr";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, chmod, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

const timed = async (label, f) => { const t = Date.now(), r = await f(); console.log(`${label}: ${Date.now() - t} ms`); return r; };
const odd = ["with space.txt", "it's.txt", "it’s.txt", "$(x).txt", "`y`.txt", "a&b.txt", "中文.md", "-n"];
const refused = (p) => assert.rejects(p, /isn't inside|refusing/);

// ---- a Windows drive folder: PowerShell
const base = await mkdtemp(pjoin(tmpdir(), "wingman-ops-")), outside = await mkdtemp(pjoin(tmpdir(), "wingman-ops-out-"));
const root = base.replace(/\\/g, "/"), at = (rel) => `${root}/${rel}`;
try {
  await timed("createFile", () => createFile(at("a.txt"), root));
  assert.equal(await readFile(at("a.txt"), "utf8"), "");
  await writeFile(at("a.txt"), "keep");
  await assert.rejects(createFile(at("a.txt"), root), (e) => e.code === "exists");
  assert.equal(await readFile(at("a.txt"), "utf8"), "keep");
  await createFile(at("x/y/z.ts"), root);
  assert.equal(await pathKind(at("x/y/z.ts")), "file");
  await timed("createDir", () => createDir(at("p/q"), root));
  await assert.rejects(createDir(at("p"), root), /already exists/);
  for (const n of odd) { await createFile(at(`odd/${n}`), root); assert.ok(existsSync(at(`odd/${n}`)), n); }

  // The review store's own writes (makeDir, removeFile) with names cmd /c would read as its syntax:
  // , ; = split a name in two, ^ & % are cmd's own. Each makes or deletes only what it names.
  const hostile = ["a,b", "a;b", "a=b", "a^b", "a&b", "%TEMP%", "x ,;=^&% y"];
  await mkdir(at("h"));
  for (const n of ["a", "b", "b.txt", "x", "y.txt"]) await writeFile(at(`h/${n}`), "decoy");
  for (const n of hostile) {
    await timed(`makeDir ${n}`, () => makeDir(at(`h/${n}/sub`)));
    assert.ok(existsSync(at(`h/${n}/sub`)), n);
    await writeFile(at(`h/${n}.txt`), "t");
    await removeFile(at(`h/${n}.txt`), "t");
    assert.ok(!existsSync(at(`h/${n}.txt`)), n);
  }
  await makeDir(at("h/a,b/sub")); // already there: fine
  assert.deepEqual((await readdir(at("h"))).sort(), [...hostile, "a", "b", "b.txt", "x", "y.txt"].sort());
  for (const n of ["a", "b", "b.txt", "x", "y.txt"]) assert.equal(await readFile(at(`h/${n}`), "utf8"), "decoy", n);
  await writeFile(at("h/file"), "f");
  await assert.rejects(makeDir(at("h/file")), /mkdir/); // a file in the way

  await timed("movePath", () => movePath(at("a.txt"), at("b.txt"), root));
  assert.equal(await readFile(at("b.txt"), "utf8"), "keep");
  await writeFile(at("c.txt"), "c");
  await assert.rejects(movePath(at("c.txt"), at("b.txt"), root), (e) => e.code === "exists");
  assert.equal(await readFile(at("b.txt"), "utf8"), "keep");
  await assert.rejects(movePath(at("c.txt"), at("p"), root), /already exists/);
  await movePath(at("c.txt"), at("new/sub/c.txt"), root);
  assert.equal(await readFile(at("new/sub/c.txt"), "utf8"), "c");
  await movePath(at("p"), at("p2"), root);
  assert.equal(await pathKind(at("p2/q")), "dir");
  await movePath(at("odd/it’s.txt"), at("odd/中文 $x.txt"), root);
  assert.ok(existsSync(at("odd/中文 $x.txt")));
  // Case-only renames, a file and a folder.
  await writeFile(at("readme.md"), "r");
  await timed("movePath (case only)", () => movePath(at("readme.md"), at("README.md"), root));
  await movePath(at("p2"), at("P2"), root);
  const names = await readdir(base);
  assert.ok(names.includes("README.md") && !names.includes("readme.md"), names.join(","));
  assert.ok(names.includes("P2") && !names.includes("p2"), names.join(","));
  assert.equal(await readFile(at("README.md"), "utf8"), "r");
  await writeFile(at("other.md"), "o");
  await assert.rejects(movePath(at("other.md"), at("readme.md"), root), /already exists/); // README.md is in the way

  // Deletes: a read-only file, a tree with read-only files, a junction to a folder outside.
  await writeFile(at("ro.txt"), "r"); await chmod(at("ro.txt"), 0o444);
  await timed("deleteFile (read-only)", () => deleteFile(at("ro.txt"), root));
  assert.ok(!existsSync(at("ro.txt")));
  await assert.rejects(deleteFile(at("x"), root), /is a folder/);
  await mkdir(at("tree/a/b"), { recursive: true }); await writeFile(at("tree/a/b/f"), "f"); await writeFile(at("tree/ro"), "r"); await chmod(at("tree/ro"), 0o444);
  await writeFile(pjoin(outside, "precious"), "p");
  await symlink(outside, pjoin(base, "tree", "junction"), "junction");
  await timed("deleteTree", () => deleteTree(at("tree"), root));
  assert.ok(!existsSync(at("tree")));
  assert.equal(await readFile(pjoin(outside, "precious"), "utf8"), "p");
  await symlink(outside, pjoin(base, "j2"), "junction");
  await deleteTree(at("j2"), root);
  assert.ok(!existsSync(at("j2"))); assert.equal(await readFile(pjoin(outside, "precious"), "utf8"), "p");
  await assert.rejects(deleteTree(at("tree"), root), (e) => e.code === "missing");

  // Confinement.
  await mkdir(at(".git")); await writeFile(at(".git/config"), "c");
  await refused(deleteTree(root, root));
  await refused(deleteTree(`${root}/`, root));
  await refused(deleteTree(outside.replace(/\\/g, "/"), root));
  await refused(deleteTree(at("x/../.."), root));
  await refused(deleteTree(at(".git"), root));
  await refused(deleteFile(at(".git/config"), root));
  await refused(createFile(`${outside.replace(/\\/g, "/")}/x`, root));
  await refused(deleteTree("C:/", "C:/"));
  await refused(deleteTree("C:/Users", "C:/"));
  await assert.rejects(createFile("C:/wingman-should-not-exist.txt", "C:/"), /aren't available/);
  await assert.rejects(deleteTree(at("x"), "C:/"), /aren't available/);
  assert.equal(await readFile(at(".git/config"), "utf8"), "c");
} finally { await rm(base, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }

// ---- a folder in WSL's own files: sh through wsl.exe
const distro = (await exec("wsl.exe", ["-e", "sh", "-c", 'printf %s "$WSL_DISTRO_NAME"'])).stdout.trim();
const made = await exec("wsl.exe", ["-e", "sh", "-c", 'd=$(mktemp -d /tmp/wingman-ops-XXXXXX) && printf %s "$d"']);
assert.equal(made.code, 0, made.stderr);
const wroot = `//wsl.localhost/${distro}${made.stdout.trim()}`;
try {
  await timed("createFile (WSL files)", () => createFile(`${wroot}/n/a.txt`, wroot));
  assert.equal(await pathKind(`${wroot}/n/a.txt`), "file");
  await assert.rejects(createFile(`${wroot}/n/a.txt`, wroot), (e) => e.code === "exists");
  await timed("movePath (WSL files)", () => movePath(`${wroot}/n/a.txt`, `${wroot}/m/it's $x.txt`, wroot));
  assert.equal(await pathKind(`${wroot}/m/it's $x.txt`), "file");
  await createDir(`${wroot}/d/e`, wroot);
  await timed("deleteTree (WSL files)", () => deleteTree(`${wroot}/d`, wroot));
  assert.equal(await pathKind(`${wroot}/d`), null);
  await deleteFile(`${wroot}/m/it's $x.txt`, wroot);
  assert.equal(await pathKind(`${wroot}/m/it's $x.txt`), null);
  await refused(deleteTree(wroot, wroot));
} finally { await exec("wsl.exe", ["-e", "rm", "-rf", "--", made.stdout.trim()]); }
console.log("fileops Windows tests pass");
