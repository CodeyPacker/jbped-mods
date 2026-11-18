// roots.js (P1): which root of a space owns a path, so a file has one identity however it's reached.
import { relUnder, ownerOf, nestedIn, holdsRoot, linkRows, caselessRoot } from "../mods/wingman/roots.js";
import assert from "node:assert/strict";

// ---- relUnder -------------------------------------------------------------------------------------
assert.equal(relUnder("/t/app/src/x.ts", "/t"), "app/src/x.ts");
assert.equal(relUnder("/t/app", "/t/app"), "");
assert.equal(relUnder("/t/app/", "/t/app"), "");
assert.equal(relUnder("/t/apple/x", "/t/app"), null, "a sibling with the same prefix isn't inside");
assert.equal(relUnder("/t", "/t/app"), null);
assert.equal(relUnder("/x", "/"), "x");
assert.equal(relUnder("C:/Dev/T/App/x.ts", "c:/dev/t"), "App/x.ts", "drive paths compare without case, the rest keeps its own");
assert.equal(relUnder("C:\\dev\\t\\a.txt", "C:/dev/t"), "a.txt");
assert.equal(relUnder("/T/a", "/t"), null, "POSIX paths compare exactly");
assert.equal(relUnder("//host/share/a/b", "//HOST/share/a"), "b");
assert.equal(relUnder("C:/x", "C:/"), "x");
assert.equal(relUnder("", "/t"), null);

// ---- ownerOf: a ticket folder T (plain) holding the space's worktrees ---------------------------------
const T = { root: "/w/T", plain: true, on: null };
const app = { root: "/w/T/app", plain: false, on: null };
const web = { root: "/w/T/web", plain: false, on: null };
const roots = [app, web, T];
const own = (p, on = null) => { const o = ownerOf(roots, p, on); return o && [o.root.root, o.rel]; };
assert.deepEqual(own("/w/T/app/src/x.ts"), ["/w/T/app", "src/x.ts"], "a file in a repo inside T is the repo's");
assert.deepEqual(own("/w/T/web/a"), ["/w/T/web", "a"]);
assert.deepEqual(own("/w/T/notes.md"), ["/w/T", "notes.md"], "T's loose files stay T's");
assert.deepEqual(own("/w/T/T.code-workspace"), ["/w/T", "T.code-workspace"]);
assert.deepEqual(own("/w/T/apple/x"), ["/w/T", "apple/x"]);
assert.equal(own("/w/other/x"), null);
assert.equal(own("/w/T/app/x", "wsl"), null, "another machine's roots don't own this computer's paths");
// Same path on another machine is that machine's root.
const remote = { root: "/w/T/app", plain: false, on: "wsl" };
assert.equal(ownerOf([T, remote], "/w/T/app/x", null).root, T);
assert.equal(ownerOf([T, remote], "/w/T/app/x", "wsl").root, remote);

// Nested plain roots (terminals in T and T/sub): the deeper one owns its files.
const sub = { root: "/w/T/sub", plain: true, on: null };
assert.equal(ownerOf([T, sub], "/w/T/sub/a.txt").root, sub);
assert.equal(ownerOf([T, sub], "/w/T/sub/a.txt").rel, "a.txt");
assert.equal(ownerOf([T, sub], "/w/T/a.txt").root, T);

// A repo inside a repo (a worktree folder in another repo's tree): the inner one owns its files.
const outer = { root: "/r/outer", plain: false, on: null }, inner = { root: "/r/outer/.worktrees/feat", plain: false, on: null };
assert.equal(ownerOf([outer, inner], "/r/outer/.worktrees/feat/src/a.ts").root, inner);
assert.equal(ownerOf([outer, inner], "/r/outer/src/a.ts").root, outer);
// A repo and a plain folder of the same path: the repo.
const plainSame = { root: "/r/outer", plain: true, on: null };
assert.equal(ownerOf([plainSame, outer], "/r/outer/a").root, outer);
assert.equal(ownerOf([outer, plainSame], "/r/outer/a").root, outer);
// Windows drive: case differs between the terminal's folder and the repo's root.
const wT = { root: "C:/Dev/T", plain: true, on: null }, wApp = { root: "c:/dev/t/app", plain: false, on: null };
assert.equal(ownerOf([wT, wApp], "C:/Dev/T/App/x.ts").root, wApp);
assert.equal(ownerOf([wT, wApp], "C:/Dev/T/App/x.ts").rel, "x.ts");

// ---- nestedIn, holdsRoot ------------------------------------------------------------------------------
assert.deepEqual(nestedIn(roots, T).map((n) => [n.rel, n.root]), [["app", app], ["web", web]]);
assert.deepEqual(nestedIn(roots, app), []);
assert.deepEqual(nestedIn([outer, inner], outer).map((n) => n.rel), [".worktrees/feat"]);
assert.deepEqual(nestedIn([T, remote], T), [], "another machine's root isn't nested in this computer's");
assert.equal(holdsRoot(roots, T, "app"), true, "the nested root itself");
assert.equal(holdsRoot([outer, inner], outer, ".worktrees"), true, "a folder holding a nested root");
assert.equal(holdsRoot(roots, T, "apple"), false);
assert.equal(holdsRoot(roots, T, "notes.md"), false);
assert.equal(holdsRoot([wT, wApp], wT, "APP"), true, "without case on a drive");

// ---- linkRows ---------------------------------------------------------------------------------------
const row = (rel, depth, dir = false, open = false) => ({ rel, name: rel.split("/").pop(), depth, dir, open, loading: false, mark: dir ? "M" : undefined, n: 2, dirty: false, deleted: false, more: false });
const rows = [
  row("app", 0, true, true), row("app/src", 1, true, true), row("app/src/x.ts", 2), { more: true, depth: 1, rel: "app" },
  row("apple", 0, true, true), row("apple/y", 1),
  row("group", 0, true, true), row("group/inner", 1, true, false),
  row("notes.md", 0),
  { more: true, depth: 0, rel: "" },
];
const out = linkRows(rows, nestedIn(roots, T));
assert.deepEqual(out.map((r) => (r.more ? `+more ${r.rel}` : r.rel)), ["app", "apple", "apple/y", "group", "group/inner", "notes.md", "+more "],
  "a nested root's rows and its cut marker are left out; a same-prefix sibling stays");
assert.equal(out[0].link, app); assert.equal(out[0].open, false); assert.equal(out[0].dir, true); assert.equal(out[0].n, 0); assert.equal(out[0].mark, undefined);
assert.equal(out[1].link, undefined);
assert.equal(linkRows(rows, []), rows, "no nested roots: the same rows");
// A nested root deeper down (T/group/inner), and a git-listed embedded repo shown as a file row.
const deep = { root: "/w/T/group/inner", plain: false, on: null };
const out2 = linkRows(rows, nestedIn([T, deep], T));
assert.equal(out2.find((r) => r.rel === "group/inner").link, deep);
assert.equal(out2.find((r) => r.rel === "group").link, undefined);
const asFile = linkRows([row("group/inner", 1, false)], nestedIn([T, deep], T));
assert.equal(asFile[0].link, deep); assert.equal(asFile[0].dir, true);
// Without case on a drive root.
const wrows = linkRows([row("App", 0, true, true), row("App/x.ts", 1)], nestedIn([wT, wApp], wT), caselessRoot(wT));
assert.deepEqual(wrows.map((r) => r.rel), ["App"]); assert.equal(wrows[0].link, wApp);
assert.equal(caselessRoot(T), false); assert.equal(caselessRoot(wT), true);

console.log("roots ok");
