import { test } from "node:test";
import assert from "node:assert/strict";
import { identityOf, parseWranglr, wranglrPattern, patternPath } from "../mods/wayfindr/wranglr.js";

test("identityOf normalises remotes the way Wranglr does", () => {
  assert.equal(identityOf("https://github.com/o/n.git", "/x"), "github.com/o/n");
  assert.equal(identityOf("git@github.com:o/n.git", "/x"), "github.com/o/n");
  assert.equal(identityOf("https://org@dev.azure.com/org/My%20Proj/_git/r", "/x"), "dev.azure.com/org/My%20Proj/r");
  assert.equal(identityOf("git@ssh.dev.azure.com:v3/org/p/r", "/x"), "dev.azure.com/org/p/r");
  assert.equal(identityOf("/srv/git/origin.git", "/x"), "/srv/git/origin");
  assert.equal(identityOf("", "/home/me/src/repo/"), "repo");
  assert.equal(identityOf(null, "C:\\dev\\repo"), "repo");
});

test("parseWranglr keeps the worktrees setting and Repo patterns, and is null when Wranglr isn't set up", () => {
  for (const t of [null, undefined, "nope", "[]", "3", "null", '"x"']) assert.equal(parseWranglr(t), null, String(t));
  assert.deepEqual(parseWranglr("{}"), { worktrees: ".worktrees/{branch}", repos: {} });
  assert.deepEqual(parseWranglr(JSON.stringify({ settings: { sort: "kind", worktrees: "" } })), { worktrees: ".worktrees/{branch}", repos: {} });
  assert.deepEqual(parseWranglr(JSON.stringify({ settings: { worktrees: "../wt/{branch}" }, repos: [] })), { worktrees: "../wt/{branch}", repos: {} });
  const c = parseWranglr(JSON.stringify({ settings: "x", repos: { "github.com/o/n": { worktrees: "../{repo}-{branch}", from: "main", on: {} }, a: { worktrees: "" }, b: { worktrees: 3 }, c: "x", d: { from: "dev" } } }));
  assert.deepEqual(c, { worktrees: ".worktrees/{branch}", repos: { "github.com/o/n": { worktrees: "../{repo}-{branch}" } } });
});

test("wranglrPattern prefers the Repo's own pattern", () => {
  const c = { worktrees: ".worktrees/{branch}", repos: { "github.com/o/n": { worktrees: "../wt/{branch}" } } };
  assert.equal(wranglrPattern(c, "github.com/o/n"), "../wt/{branch}");
  assert.equal(wranglrPattern(c, "github.com/o/other"), ".worktrees/{branch}");
  assert.equal(wranglrPattern(c, null), ".worktrees/{branch}");
});

test("patternPath puts a relative pattern under the clone and keeps an absolute one", () => {
  assert.equal(patternPath(".worktrees/{branch}", "C:\\dev\\x\\repo", "repo"), "C:\\dev\\x\\repo\\.worktrees\\{branch}");
  assert.equal(patternPath("../wt/{branch}/{repo}", "/home/me/src/repo", "repo"), "/home/me/src/wt/{branch}/repo");
  assert.equal(patternPath("./a/./b/{branch}", "/r/", "r"), "/r/a/b/{branch}");
  assert.equal(patternPath("../../../../x/{branch}", "C:\\a\\", "r"), "C:\\x\\{branch}"); // never above the drive
  assert.equal(patternPath("../../../x/{branch}", "/a", "r"), "/x/{branch}"); // never above the root
  assert.equal(patternPath("../wt/{branch}", "C:/dev/repo", "repo"), "C:\\dev\\wt\\{branch}");
  assert.equal(patternPath("../wt/{branch}", "\\\\wsl.localhost\\Ubuntu\\home\\r", "r"), "\\\\wsl.localhost\\Ubuntu\\home\\wt\\{branch}");
  assert.equal(patternPath("../../../{branch}", "\\\\srv\\share\\r", "r"), "\\\\srv\\share\\{branch}"); // never above the share
  assert.equal(patternPath("D:\\wt", "C:\\x\\r", "r"), "D:\\wt\\{branch}");
  assert.equal(patternPath("/wt/{repo}/{branch}", "C:\\x\\r", "r"), "/wt/r/{branch}");
  assert.equal(patternPath("C:/wt/{branch}", "/r", "r"), "C:/wt/{branch}");
  assert.equal(patternPath("\\\\srv\\wt\\{branch}", "/r", "r"), "\\\\srv\\wt\\{branch}");
  assert.equal(patternPath("../{repo}-wt/", "/src/fe", "fe"), "/src/fe-wt/{branch}"); // {branch} appended
  assert.equal(patternPath("{repo}/{branch}/{repo}", "/src/fe", "fe"), "/src/fe/fe/{branch}/fe");
});
