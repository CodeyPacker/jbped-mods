// The Explorer's file operations, pure part (fileops.js): names, targets, confinement, paths copied.
import { checkName, checkRel, newTarget, renameTarget, inside, remap, within, copyPaths, countUnder, deleteQuestion, stemEnd, windowsRoot, parentOf, under } from "../mods/wingman/fileops.js";
import assert from "node:assert/strict";

const ok = (n, o) => assert.equal(checkName(n, o), null, n);
const bad = (n, o, re) => { const why = checkName(n, o); assert.ok(why, `${JSON.stringify(n)} should be refused`); if (re) assert.match(why, re); };

// ---- names, everywhere
for (const n of ["a.ts", "a b.ts", "it's", '"q"', "$x", "`y`", "中文.md", "-dash", ".env", "a/b/c.ts", "x..y", "a.b.", "C:x", "trailing ", "<>|?*:"]) ok(n);
bad("", {}, /must be provided/); bad("   ", {}, /must be provided/);
bad("a\0b", {}, /NUL/); bad("a\\b", {}, /backslash/); bad("..\\x", {}, /backslash/);
bad("/abs", {}, /start with/); bad("/etc/passwd", {});
bad("a/", { kind: "file" }, /end with/); ok("a/", { kind: "dir" }); ok("a/b/", { kind: "dir" });
bad("a//b", {}, /empty part/); bad(".", {}); bad("..", {}); bad("a/../b", {}, /\.\./); bad("../x", {}); bad("a/./b", {});
bad(".git", {}, /\.git/); bad("a/.git/config", {}, /\.git/); bad(".GIT", {}); bad("sub/.Git", { kind: "dir" });
ok(".github"); ok(".gitignore"); ok("x.git");
bad("x".repeat(256), {}, /255/); ok("x".repeat(255));
bad("a/ /b", {}, /only spaces/);

// ---- names on Windows roots
const w = { windows: true };
for (const c of '<>:"|?*') bad(`a${c}b`, w, /Windows doesn't allow/);
bad("a\u0001b", w); bad("dot.", w, /dot or a space/); bad("space ", w, /dot or a space/); bad("sub./x", w);
for (const n of ["CON", "con", "nul.txt", "Aux.tar.gz", "COM1", "lpt9.log", "prn", "COM¹"]) bad(n, w, /reserves/);
for (const n of ["CONsole", "nul1", "com10", "a/con2.ts", "中文.md", ".env", "it's"]) ok(n, w);
ok("trailing ", {}); ok("dot.", {}); ok("con", {}); // only Windows refuses these

// ---- roots and confinement
assert.equal(windowsRoot("C:/dev"), true); assert.equal(windowsRoot("C:\\dev"), true); assert.equal(windowsRoot("//server/share/x"), true);
assert.equal(windowsRoot("//wsl.localhost/Ubuntu/home"), false); assert.equal(windowsRoot("//wsl$/Ubuntu/home"), false);
assert.equal(windowsRoot("/home/me"), false); assert.equal(windowsRoot("C:/dev", "vps"), false);
assert.equal(inside("/r/a", "/r"), true); assert.equal(inside("/r/a/b", "/r/"), true);
assert.equal(inside("/r", "/r"), false); assert.equal(inside("/r/", "/r"), false); assert.equal(inside("/rx/a", "/r"), false);
assert.equal(inside("/r/../etc", "/r"), false); assert.equal(inside("/r/a/../../etc", "/r"), false); assert.equal(inside("/r/./a", "/r"), false);
assert.equal(inside("/r/.git", "/r"), false); assert.equal(inside("/r/.git/config", "/r"), false); assert.equal(inside("/r/a/.GIT/x", "/r"), false);
assert.equal(inside("r/a", "r"), false); assert.equal(inside("/a", "/r/../"), false); assert.equal(inside("", "/r"), false); assert.equal(inside("/r/a", ""), false);
assert.equal(inside("/R/a", "/r"), false); // POSIX: case matters
assert.equal(inside("c:/Dev/a", "C:/dev"), true); assert.equal(inside("C:\\dev\\a", "C:/dev"), true); assert.equal(inside("D:/dev/a", "C:/dev"), false);
assert.equal(inside("C:/a", "C:/"), true); assert.equal(inside("C:/", "C:/"), false);
assert.equal(inside("//wsl.localhost/Ubuntu/home/me/r/a", "//wsl.localhost/Ubuntu/home/me/r"), true);
assert.equal(inside("//wsl.localhost/Debian/home/me/r/a", "//wsl.localhost/Ubuntu/home/me/r"), false);
assert.equal(inside("/a", "/"), true); assert.equal(inside("/", "/"), false);

assert.equal(checkRel(""), "Wingman doesn't rename or delete a root folder.");
assert.ok(checkRel(".git")); assert.ok(checkRel("a/.git/x")); assert.ok(checkRel("../x")); assert.ok(checkRel("a//b"));
assert.equal(checkRel("src/a.ts"), null);

// ---- New File / New Folder targets
assert.deepEqual(newTarget({ root: "/r", dir: "", name: "a.ts" }), { rel: "a.ts", path: "/r/a.ts", made: [] });
assert.deepEqual(newTarget({ root: "/r", dir: "src", name: "a/b/c.ts" }), { rel: "src/a/b/c.ts", path: "/r/src/a/b/c.ts", made: ["src/a", "src/a/b"] });
assert.deepEqual(newTarget({ root: "/r", dir: "", name: "x/y/", kind: "dir" }), { rel: "x/y", path: "/r/x/y", made: ["x", "x/y"] });
assert.deepEqual(newTarget({ root: "C:/dev/r", dir: "src", name: "中文.md", windows: true }).path, "C:/dev/r/src/中文.md");
assert.equal(newTarget({ root: "C:/", dir: "", name: "a" }).path, "C:/a");
assert.equal(newTarget({ root: "/", dir: "", name: "a" }).path, "/a");
assert.match(newTarget({ root: "/r", dir: "", name: "../x" }).error, /\.\./);
assert.match(newTarget({ root: "/r", dir: "", name: "/etc/x" }).error, /start with/);
assert.match(newTarget({ root: "/r", dir: ".git", name: "x" }).error, /\.git/);
assert.match(newTarget({ root: "/r", dir: "a/../..", name: "x" }).error, /isn't a path/);
assert.match(newTarget({ root: "C:/r", dir: "", name: "a:b", windows: true }).error, /Windows/);
assert.ok(newTarget({ root: "/r", dir: "", name: "a/", kind: "file" }).error);

// ---- Rename targets
assert.deepEqual(renameTarget({ root: "/r", rel: "src/a.ts", name: "b.ts" }), { rel: "src/b.ts", path: "/r/src/b.ts", from: "src/a.ts", fromPath: "/r/src/a.ts", caseOnly: false, same: false });
assert.equal(renameTarget({ root: "/r", rel: "src/a.ts", name: "lib/a.ts" }).rel, "src/lib/a.ts"); // a slash moves it, in its own folder
assert.equal(renameTarget({ root: "/r", rel: "a.ts", name: "a.ts" }).same, true);
const co = renameTarget({ root: "C:/r", rel: "readme.md", name: "README.md", windows: true });
assert.equal(co.caseOnly, true); assert.equal(co.same, false); assert.equal(co.path, "C:/r/README.md");
assert.match(renameTarget({ root: "/r", rel: "src", name: "src/inner", isDir: true }).error, /into itself/);
assert.equal(renameTarget({ root: "/r", rel: "src", name: "src2", isDir: true }).rel, "src2"); // a sibling with the same start is fine
assert.match(renameTarget({ root: "/r", rel: "", name: "x" }).error, /root/);
assert.match(renameTarget({ root: "/r", rel: ".git", name: "x" }).error, /\.git/);
assert.match(renameTarget({ root: "/r", rel: "a.ts", name: "../a.ts" }).error, /\.\./);
assert.match(renameTarget({ root: "/r", rel: "a.ts", name: ".git" }).error, /\.git/);

// ---- after a rename, deletes, copies
assert.equal(remap("src", "src", "lib"), "lib"); assert.equal(remap("src/a/b.ts", "src", "lib"), "lib/a/b.ts");
assert.equal(remap("srcx/a", "src", "lib"), null); assert.equal(remap("other", "src", "lib"), null);
assert.equal(within("a/b", "a"), true); assert.equal(within("a", "a"), true); assert.equal(within("ab", "a"), false);
assert.equal(parentOf("a/b/c"), "a/b"); assert.equal(parentOf("a"), ""); assert.equal(under("C:/", "x"), "C:/x"); assert.equal(under("/r", ""), "/r");
assert.deepEqual(copyPaths("C:/dev/r", "src/a.ts"), { path: "C:\\dev\\r\\src\\a.ts", relative: "src\\a.ts" });
assert.deepEqual(copyPaths("/home/me/r", "src/a.ts"), { path: "/home/me/r/src/a.ts", relative: "src/a.ts" });
assert.deepEqual(copyPaths("//wsl.localhost/Ubuntu/r", "a"), { path: "//wsl.localhost/Ubuntu/r/a", relative: "a" });
assert.deepEqual(copyPaths("/r", ""), { path: "/r", relative: "." });
assert.equal(countUnder(["src/a", "src/b/c", "srcx/d", "src"], "src"), 2);
assert.equal(deleteQuestion({ rel: "a.ts", isDir: false }), "Delete a.ts? This can't be undone.");
assert.equal(deleteQuestion({ rel: "src/old", isDir: true, count: 12 }), "Delete folder src/old and its 12 files? This can't be undone.");
assert.equal(deleteQuestion({ rel: "src/old", isDir: true, count: 1 }), "Delete folder src/old and its 1 file? This can't be undone.");
assert.equal(deleteQuestion({ rel: "x", isDir: true, count: null }), "Delete folder x and everything in it? This can't be undone.");
assert.equal(stemEnd("main.test.ts"), 9); assert.equal(stemEnd(".env"), 4); assert.equal(stemEnd("Makefile"), 8); assert.equal(stemEnd("a.b", true), 3);
console.log("fileops ok");
