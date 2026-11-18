// Windows only (Windows Node, git and WSL), not in run.sh's set. From the tests folder in cmd:
//   set "WINGMAN_TEST_HOME=%TEMP%"&& node --import ./register.mjs windows/fsx.test.mjs
import { listDir, pathKind } from "../../mods/wingman/fsx.js";
import { exec } from "herdr";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";

const timed = async (label, f) => { const t = Date.now(), r = await f(); console.log(`${label}: ${Date.now() - t} ms`); return r; };
const kinds = (entries) => Object.fromEntries(entries.map((e) => [e.name, e.dir]));
const odd = ["with space", "it's", "it’s", "$(x)", "`y`", "a&b"];

// ---- a Windows drive folder: PowerShell
const root = await mkdtemp(pjoin(tmpdir(), "wingman-fsx-"));
try {
  await mkdir(pjoin(root, "sub")); await mkdir(pjoin(root, "中文名")); await mkdir(pjoin(root, ".git"));
  for (const n of ["file.txt", ".env", ...odd]) await writeFile(pjoin(root, n), "hi");
  await symlink(pjoin(root, "sub"), pjoin(root, "junction"), "junction");
  await mkdir(pjoin(root, "gone")); await symlink(pjoin(root, "gone"), pjoin(root, "dangling-junction"), "junction"); await rm(pjoin(root, "gone"), { recursive: true });
  const want = { sub: true, "中文名": true, "file.txt": false, ".env": false, junction: true, "dangling-junction": false, ...Object.fromEntries(odd.map((n) => [n, false])) };
  // Folder symlinks need Developer Mode or admin; checked when they can be made.
  try {
    await symlink(pjoin(root, "sub"), pjoin(root, "link-dir"), "dir"); await symlink(pjoin(root, "missing"), pjoin(root, "dangling-link"), "dir");
    Object.assign(want, { "link-dir": true, "dangling-link": false });
  } catch (e) { console.log(`folder symlinks skipped: ${e.code}`); }

  const win = root.replace(/\\/g, "/");
  const { entries, more } = await timed("listDir (drive, first)", () => listDir(win));
  await timed("listDir (drive, again)", () => listDir(win));
  assert.deepEqual(kinds(entries), want); assert.equal(more, false);
  assert.deepEqual(await listDir(win, { limit: 2 }).then((r) => [r.entries.length, r.more]), [2, true]);
  assert.deepEqual((await listDir(`${win}/中文名`)).entries, []);
  await assert.rejects(listDir(`${win}/nope`), /nope/);
  assert.equal(await timed("pathKind (drive)", () => pathKind(win)), "dir");
  assert.equal(await pathKind(`${win}/junction`), "dir"); assert.equal(await pathKind(`${win}/it’s`), "file");
  assert.equal(await pathKind(`${win}/$(x)`), "file"); assert.equal(await pathKind(`${win}/nope`), null);
} finally { await rm(root, { recursive: true, force: true }); }

// ---- a folder in WSL's own files: sh through wsl.exe
const distro = (await exec("wsl.exe", ["-e", "sh", "-c", 'printf %s "$WSL_DISTRO_NAME"'])).stdout.trim();
const made = await exec("wsl.exe", ["-e", "sh", "-c", `d=$(mktemp -d) && cd "$d" && mkdir sub .git 中文名 && touch file .env "with space" "it's" '$(x)' '\`y\`' && ln -s sub link-dir && ln -s missing dangling && printf %s "$d"`]);
assert.equal(made.code, 0, made.stderr);
const wsl = `//wsl.localhost/${distro}${made.stdout.trim()}`;
try {
  const { entries } = await timed("listDir (WSL files, first)", () => listDir(wsl));
  await timed("listDir (WSL files, again)", () => listDir(wsl));
  assert.deepEqual(kinds(entries), { sub: true, "中文名": true, file: false, ".env": false, "with space": false, "it's": false, "$(x)": false, "`y`": false, "link-dir": true, dangling: false });
  assert.equal((await listDir(wsl.replace("//wsl.localhost/", "\\\\wsl$\\"))).entries.length, 10);
  assert.equal(await timed("pathKind (WSL files)", () => pathKind(`${wsl}/link-dir`)), "dir");
  assert.equal(await pathKind(`${wsl}/it's`), "file"); assert.equal(await pathKind(`${wsl}/nope`), null);
} finally { await exec("wsl.exe", ["-e", "rm", "-rf", "--", made.stdout.trim()]); }
console.log("fsx Windows tests pass");
