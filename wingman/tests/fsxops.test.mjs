// The Explorer's file operations in fsx.js (createFile, createDir, movePath, deleteFile, deleteTree)
// on a real file system: here (local sh), as machine "vps" (the shim runs it here through `on`), and
// refused on "nosh" (a Windows machine).
import { createFile, createDir, movePath, deleteFile, deleteTree, OPS_SH, WINDOWS_NOTE } from "../mods/wingman/fsx.js";
import { newTarget, renameTarget } from "../mods/wingman/fileops.js";
import { remoteCalls } from "herdr";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, symlinkSync, lstatSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const odd = ["with space.txt", "it's.txt", '"q".txt', "$HOME.txt", "`id`.txt", "中文.md", "-n", "a;b|c&d.txt"];

for (const on of [null, "vps"]) {
  const root = mkdtempSync(`${tmpdir()}/fsxops-`), o = { on }, at = (rel) => `${root}/${rel}`;
  const outside = mkdtempSync(`${tmpdir()}/fsxops-out-`);
  try {
    remoteCalls.length = 0;
    // ---- create
    await createFile(at("a.txt"), root, o);
    assert.equal(readFileSync(at("a.txt"), "utf8"), "");
    writeFileSync(at("a.txt"), "keep");
    await assert.rejects(createFile(at("a.txt"), root, o), (e) => e.code === "exists" && /a\.txt already exists/.test(e.message));
    assert.equal(readFileSync(at("a.txt"), "utf8"), "keep"); // never truncated
    mkdirSync(at("d"));
    await assert.rejects(createFile(at("d"), root, o), /already exists/); // a folder is in the way
    await createFile(at("x/y/z.ts"), root, o); // nested
    assert.equal(readFileSync(at("x/y/z.ts"), "utf8"), "");
    await createDir(at("p/q/r"), root, o);
    assert.ok(lstatSync(at("p/q/r")).isDirectory());
    await assert.rejects(createDir(at("p/q"), root, o), /already exists/);
    await assert.rejects(createDir(at("a.txt"), root, o), /already exists/);
    for (const n of odd) {
      await createFile(at(`odd/${n}`), root, o);
      assert.ok(existsSync(at(`odd/${n}`)), n);
    }
    await createDir(at("odd/文件夹 $(x)"), root, o);
    assert.ok(existsSync(at("odd/文件夹 $(x)")));

    // ---- rename and move
    writeFileSync(at("m.txt"), "m");
    await movePath(at("m.txt"), at("n.txt"), root, o);
    assert.ok(!existsSync(at("m.txt"))); assert.equal(readFileSync(at("n.txt"), "utf8"), "m");
    await assert.rejects(movePath(at("n.txt"), at("a.txt"), root, o), (e) => e.code === "exists"); // never replaces
    assert.equal(readFileSync(at("a.txt"), "utf8"), "keep"); assert.equal(readFileSync(at("n.txt"), "utf8"), "m");
    await assert.rejects(movePath(at("n.txt"), at("d"), root, o), /already exists/); // never moves into a folder in the way
    assert.deepEqual(readdirSync(at("d")), []);
    await movePath(at("n.txt"), at("new/sub/n.txt"), root, o); // into a new subfolder
    assert.equal(readFileSync(at("new/sub/n.txt"), "utf8"), "m");
    await movePath(at("p"), at("p2"), root, o); // a folder and its content
    assert.ok(lstatSync(at("p2/q/r")).isDirectory()); assert.ok(!existsSync(at("p")));
    await movePath(at("odd/it's.txt"), at("odd/中文 `it` $x.txt"), root, o);
    assert.ok(existsSync(at("odd/中文 `it` $x.txt")));
    await assert.rejects(movePath(at("gone.txt"), at("g2.txt"), root, o), (e) => e.code === "missing");
    // A case-only rename (a case-sensitive file system here: a plain rename).
    writeFileSync(at("readme.md"), "r");
    await movePath(at("readme.md"), at("README.md"), root, o);
    assert.deepEqual(readdirSync(root).filter((n) => /^readme/i.test(n)), ["README.md"]);
    // The pure target and the primitive together.
    const t = renameTarget({ root, rel: "README.md", name: "docs/README.md" });
    await movePath(t.fromPath, t.path, root, o);
    assert.equal(readFileSync(at("docs/README.md"), "utf8"), "r");
    const nt = newTarget({ root, dir: "docs", name: "a/b.md" });
    await createFile(nt.path, root, o);
    assert.ok(existsSync(at("docs/a/b.md")));

    // ---- delete
    await deleteFile(at("a.txt"), root, o);
    assert.ok(!existsSync(at("a.txt")));
    await assert.rejects(deleteFile(at("a.txt"), root, o), (e) => e.code === "missing");
    await assert.rejects(deleteFile(at("x"), root, o), /is a folder/);
    assert.ok(existsSync(at("x/y/z.ts")));
    await deleteFile(at("odd/`id`.txt"), root, o);
    assert.ok(!existsSync(at("odd/`id`.txt")));
    // A link to a folder outside: deleting it removes the link only.
    writeFileSync(`${outside}/precious`, "p");
    symlinkSync(outside, at("link-out"));
    await deleteTree(at("link-out"), root, o);
    assert.ok(!existsSync(at("link-out"))); assert.equal(readFileSync(`${outside}/precious`, "utf8"), "p");
    symlinkSync(`${outside}/precious`, at("file-link"));
    await deleteFile(at("file-link"), root, o);
    assert.equal(readFileSync(`${outside}/precious`, "utf8"), "p");
    // A folder tree, with a read-only file and a read-only folder inside.
    mkdirSync(at("tree/a/b"), { recursive: true }); writeFileSync(at("tree/a/b/f"), "f"); writeFileSync(at("tree/ro"), "r"); chmodSync(at("tree/ro"), 0o444);
    await deleteTree(at("tree"), root, o);
    assert.ok(!existsSync(at("tree")));
    await assert.rejects(deleteTree(at("tree"), root, o), (e) => e.code === "missing");
    await assert.rejects(deleteTree(at("docs/a/b.md"), root, o), /isn't a folder/);
    await deleteTree(at("odd/文件夹 $(x)"), root, o);
    assert.ok(!existsSync(at("odd/文件夹 $(x)")));

    // ---- confinement: never the root, never outside, never .git
    mkdirSync(at(".git")); writeFileSync(at(".git/config"), "c");
    const refused = async (p) => {
      await assert.rejects(p, /isn't inside|refusing/);
    };
    await refused(deleteTree(root, root, o));
    await refused(deleteTree(`${root}/`, root, o));
    await refused(deleteTree(outside, root, o));
    await refused(deleteTree(at("../" + outside.split("/").pop()), root, o));
    await refused(deleteTree(at("x/../.."), root, o));
    await refused(deleteTree(at(".git"), root, o));
    await refused(deleteFile(at(".git/config"), root, o));
    await refused(createFile(at(".git/hooks/x"), root, o));
    await refused(createFile(`${outside}/x`, root, o));
    await refused(movePath(at("x"), `${outside}/x`, root, o));
    await refused(movePath(at("x"), at("../escaped"), root, o));
    await refused(deleteTree("/", "/", o));
    await refused(deleteTree("", root, o));
    await refused(deleteTree("/home", "/", o));
    await refused(deleteTree("/home/someone", "/home", o));
    await refused(deleteTree("/Users/someone", "/Users", o));
    await refused(deleteTree("C:/Users/x", "C:/", o));
    assert.equal(readFileSync(at(".git/config"), "utf8"), "c");
    assert.ok(existsSync(outside));
    if (on) assert.ok(remoteCalls.length > 0 && remoteCalls.every((c) => c.on === on));
  } finally {
    rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
  }
}

// The script refuses on its own too: a recursive delete outside its root, or of the home folder.
const box = mkdtempSync(`${tmpdir()}/fsxops-sh-`);
try {
  mkdirSync(`${box}/r`); mkdirSync(`${box}/other`);
  const run = (...a) => execFileSync("sh", ["-c", OPS_SH, "wingman", ...a], { encoding: "utf8", env: { ...process.env, HOME: `${box}/r/home` } }).trim();
  assert.match(run("rmtree", `${box}/other`, `${box}/r`), /^error .*isn't inside/);
  assert.match(run("rmtree", `${box}/r`, `${box}/r`), /^error .*isn't inside/);
  mkdirSync(`${box}/r/home`);
  assert.match(run("rmtree", `${box}/r/home`, `${box}/r`), /^error refusing to delete a home folder/);
  assert.equal(run("rmtree", `${box}/r/other`, `${box}/r`), "missing");
  assert.ok(existsSync(`${box}/other`) && existsSync(`${box}/r/home`));
} finally { rmSync(box, { recursive: true, force: true }); }

// A case-only rename on a case-insensitive file system: a Windows drive seen from WSL (drvfs), when there is one.
const winTemp = existsSync("/mnt/c/Windows") ? (() => { try { return execFileSync("sh", ["-c", 'wslpath "$(cmd.exe /c echo %TEMP% 2>/dev/null | tr -d "\\r")"'], { encoding: "utf8" }).trim(); } catch { return null; } })() : null;
if (winTemp && existsSync(winTemp)) {
  const r = mkdtempSync(`${winTemp}/fsxops-ci-`);
  try {
    writeFileSync(`${r}/readme.md`, "r"); mkdirSync(`${r}/lower`); writeFileSync(`${r}/lower/f`, "f");
    assert.ok(existsSync(`${r}/README.md`), "drvfs should be case-insensitive here");
    await movePath(`${r}/readme.md`, `${r}/README.md`, r);
    await movePath(`${r}/lower`, `${r}/Lower`, r);
    assert.deepEqual(readdirSync(r).sort(), ["Lower", "README.md"]);
    assert.equal(readFileSync(`${r}/README.md`, "utf8"), "r"); assert.equal(readFileSync(`${r}/Lower/f`, "utf8"), "f");
    writeFileSync(`${r}/other.md`, "o");
    await assert.rejects(movePath(`${r}/other.md`, `${r}/readme.md`, r), /already exists/); // not case-only: README.md is in the way
    console.log(`case-only rename checked on ${r}`);
  } finally { rmSync(r, { recursive: true, force: true }); }
} else console.log("case-only rename on a case-insensitive file system: skipped (no Windows drive)");

// A Windows machine elsewhere: refused, nothing run there.
await assert.rejects(createFile("C:/r/a.txt", "C:/r", { on: "nosh" }), (e) => e.message === WINDOWS_NOTE);
await assert.rejects(deleteTree("C:/r/a", "C:/r", { on: "nosh" }), (e) => e.message === WINDOWS_NOTE);
console.log("fsxops ok");
