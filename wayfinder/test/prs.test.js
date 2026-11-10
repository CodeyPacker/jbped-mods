import { test } from "node:test";
import assert from "node:assert/strict";
import { github, mapPrs, prSearches } from "../mods/wayfinder/providers/github.js";
import { byRepo } from "../mods/wayfinder/providers/contract.js";
import { loadPullRequests } from "../mods/wayfinder/flow.js";
import { parseCache, serializeCache, cachedPrs, withPrs, withBoard, prsKey } from "../mods/wayfinder/cache.js";

const pr = (n, repo, extra = {}) => ({
  id: `pr-${n}`, number: n, title: `T${n}`, url: `https://github.com/${repo}/pull/${n}`, isDraft: false,
  updatedAt: `2026-11-0${n}T00:00:00Z`, author: { login: "ann", name: "Ann Lee" }, repository: { nameWithOwner: repo }, ...extra,
});

test("PRs map to summaries, drafts marked, odd nodes skipped", () => {
  const [a, b] = mapPrs([pr(1, "o/web", { isDraft: true }), {}, pr(2, "o/api", { author: null })]);
  assert.deepEqual(a, { key: "pr-1", id: "web#1", title: "T1", url: "https://github.com/o/web/pull/1", repo: "o/web", draft: true,
    author: { id: "ann", name: "Ann Lee" }, updatedAt: "2026-11-01T00:00:00Z" });
  assert.equal(b.draft, false);
  assert.deepEqual(b.author, { id: "ghost", name: "ghost" });
});

test("both sections come from one request, for the Account's own login", async () => {
  const calls = [];
  const io = {
    run: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, stdout: "tok\n", stderr: "" }; },
    fetch: async (_u, opts) => {
      const { variables } = JSON.parse(opts.body);
      calls.push(variables);
      return { status: 200, ok: true, text: async () => JSON.stringify({ data: { viewer: { login: "jbped" },
        mine: { issueCount: 3, nodes: [pr(1, "o/web", { isDraft: true }), pr(2, "o/web")] }, review: { issueCount: 1, nodes: [pr(3, "x/y")] } } }) };
    },
  };
  const r = await github.pullRequests({ login: "jbped" }, io);
  assert.equal(calls.filter((c) => typeof c === "object").length, 1);
  assert.deepEqual(calls[1], prSearches("jbped"));
  assert.match(calls[1].mine, /is:pr is:open .*author:jbped/);
  assert.match(calls[1].review, /review-requested:jbped/);
  assert.deepEqual(r.mine.map((p) => [p.id, p.draft]), [["web#1", true], ["web#2", false]]);
  assert.deepEqual(r.needsReview.map((p) => p.id), ["y#3"]);
  assert.deepEqual(r.more, { mine: 1, needsReview: 0 });
  await assert.rejects(github.pullRequests({ login: "a b:c" }, io), /isn't a GitHub user name/);
});

test("byRepo groups by repo name, newest first inside", () => {
  const g = byRepo(mapPrs([pr(1, "o/web"), pr(3, "o/api"), pr(2, "o/web")]));
  assert.deepEqual(g.map((x) => [x.repo, x.prs.map((p) => p.id)]), [["o/api", ["api#3"]], ["o/web", ["web#2", "web#1"]]]);
});

test("each Account loads on its own; one failing doesn't stop the others", async () => {
  const registry = {
    good: { capabilities: ["pullRequests"], pullRequests: async (a) => ({ me: a.id, mine: [], needsReview: [], more: { mine: 0, needsReview: 0 } }) },
    bad: { capabilities: ["pullRequests"], pullRequests: async () => { throw new Error("nope"); } },
    none: { capabilities: ["board"] },
  };
  const profile = { accounts: [{ id: "a", provider: "bad" }, { id: "b", provider: "good" }, { id: "c", provider: "none" }] };
  assert.deepEqual(await loadPullRequests(profile, {}, registry), [
    { account: "a", error: "nope" },
    { account: "b", me: "b", mine: [], needsReview: [], more: { mine: 0, needsReview: 0 } },
  ]);
});

test("PRs cache per Profile, only for the same Accounts, beside Boards", () => {
  const accounts = [{ id: "gh", provider: "github", login: "ann" }];
  const key = prsKey(accounts);
  let c = withPrs(parseCache(null), key, [{ account: "gh" }], 100);
  c = withBoard(c, [], { id: "x", account: "gh", ref: {} }, {}, 1);
  c = parseCache(serializeCache(c));
  assert.deepEqual(cachedPrs(c, key), { at: 100, data: [{ account: "gh" }] });
  assert.equal(cachedPrs(c, prsKey([{ ...accounts[0], login: "bob" }])), null);
  assert.equal(withPrs(c, key, [], 50).prs.at, 100); // older data loses
});
