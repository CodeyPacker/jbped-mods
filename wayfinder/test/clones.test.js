import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteRepo, sameRepo, parseClones, scanRoots } from "../mods/wayfinder/clones.js";

test("remoteRepo names the GitHub repo in every remote URL form", () => {
  for (const u of ["https://github.com/o/n", "https://github.com/o/n.git", "https://github.com/o/n/", "git@github.com:o/n.git", "ssh://git@github.com/o/n", "https://user@github.com/o/n", "https://GitHub.com/o/n.git"]) {
    assert.equal(remoteRepo(u), "o/n", u);
  }
});

test("remoteRepo names the Azure DevOps project/repo in every remote URL form", () => {
  for (const u of [
    "https://dev.azure.com/org/project/_git/repo",
    "https://org@dev.azure.com/org/project/_git/repo",
    "https://org.visualstudio.com/project/_git/repo",
    "https://org.visualstudio.com/DefaultCollection/project/_git/repo",
    "git@ssh.dev.azure.com:v3/org/project/repo",
    "ssh://git@ssh.dev.azure.com/v3/org/project/repo",
  ]) assert.equal(remoteRepo(u), "project/repo", u);
  assert.equal(remoteRepo("https://org@dev.azure.com/org/My%20Project/_git/web"), "My Project/web");
  assert.equal(remoteRepo("git@ssh.dev.azure.com:v3/org/My%20Project/web"), "My Project/web");
});

test("remoteRepo is null for other hosts and malformed input, and never throws", () => {
  for (const u of ["https://gitlab.com/a/b.git", "git@gitlab.com:a/b.git", "", null, undefined, 42, "not a url", "https://github.com/o", "https://github.com/o/n/tree/main", "https://dev.azure.com/org/_git/repo", "https://github.com/o/%zz", "/home/me/src/repo", "C:\\src\\repo", "file:///srv/o/n.git"]) {
    assert.equal(remoteRepo(u), null, String(u));
  }
});

test("sameRepo compares names ignoring case, and never matches empty ones", () => {
  assert.equal(sameRepo("A/B", "a/b"), true);
  assert.equal(sameRepo("a/b", "a/c"), false);
  assert.equal(sameRepo("", ""), false);
  assert.equal(sameRepo(null, null), false);
});

test("parseClones reads path and url lines, skipping malformed ones and repeated paths", () => {
  const out = parseClones("C:\\src\\fe\tgit@github.com:o/fe.git\r\n\nno tab here\n\tgit@github.com:o/x.git\n/x\t\nC:\\src\\fe\thttps://github.com/o/other\n/home/me/gl\thttps://gitlab.com/a/b\n");
  assert.deepEqual(out, [
    { path: "C:\\src\\fe", url: "git@github.com:o/fe.git", repo: "o/fe" },
    { path: "/home/me/gl", url: "https://gitlab.com/a/b", repo: null },
  ]);
  assert.deepEqual(parseClones(""), []);
});

test("scanRoots gives each folder's parent once, ignoring case, without roots, up to 20", () => {
  assert.deepEqual(scanRoots({ folders: ["C:\\dev\\x\\repo", "c:\\DEV\\X\\other\\", "/home/me/src/repo/", "/home/me/src/b", "C:\\repo", "/repo", "C:\\", "/", "", 7] }), ["C:\\dev\\x", "/home/me/src"]);
  assert.deepEqual(scanRoots({ folders: ["\\\\wsl.localhost\\Ubuntu\\home\\me\\r", "\\\\wsl.localhost\\Ubuntu\\r"] }), ["\\\\wsl.localhost\\Ubuntu\\home\\me"]);
  assert.equal(scanRoots({ folders: Array.from({ length: 30 }, (_, i) => `/src/p${i}/repo`) }).length, 20);
  assert.deepEqual(scanRoots({}), []);
  assert.deepEqual(scanRoots(), []);
});
