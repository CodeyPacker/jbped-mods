import { test } from "node:test";
import assert from "node:assert/strict";
import { github, mapPrs, prSearches, PRS_QUERY } from "../mods/wayfindr/providers/github.js";
import { byRepo } from "../mods/wayfindr/providers/contract.js";
import { loadPullRequests } from "../mods/wayfindr/flow.js";
import { parseCache, serializeCache, cachedPrs, withPrs, withBoard, prsKey } from "../mods/wayfindr/cache.js";

const pr = (n, repo, extra = {}) => ({
  id: `pr-${n}`, number: n, title: `T${n}`, url: `https://github.com/${repo}/pull/${n}`, isDraft: false,
  updatedAt: `2026-11-0${n}T00:00:00Z`, author: { login: "ann", name: "Ann Lee" }, repository: { nameWithOwner: repo }, ...extra,
});

test("PRs map to summaries, drafts marked, odd nodes skipped", () => {
  const [a, b] = mapPrs([pr(1, "o/web", { isDraft: true }), {}, pr(2, "o/api", { author: null })]);
  assert.deepEqual(a, { key: "pr-1", id: "web#1", title: "T1", url: "https://github.com/o/web/pull/1", repo: "o/web", draft: true,
    author: { id: "ann", name: "Ann Lee" }, updatedAt: "2026-11-01T00:00:00Z", head: null, checks: "none" });
  assert.equal(b.draft, false);
  assert.deepEqual(b.author, { id: "ghost", name: "ghost" });
});

test("a GitHub PR row carries its head commit, from headRefOid in the list query (#31)", () => {
  const sha = "a".repeat(40);
  assert.equal(mapPrs([pr(1, "o/web", { headRefOid: sha })])[0].head, sha);
  assert.equal(mapPrs([pr(1, "o/web", { headRefOid: null })])[0].head, null);
  assert.match(PRS_QUERY, /headRefOid/);
});

test("a GitHub PR row's checks come from its head commit's rollup state (#26)", () => {
  const rolled = (state) => pr(1, "o/web", { commits: { nodes: [{ commit: { statusCheckRollup: state === undefined ? null : { state } } }] } });
  assert.deepEqual(mapPrs(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED", undefined].map(rolled)).map((p) => p.checks),
    ["pass", "fail", "fail", "pending", "pending", "none"]);
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

import { azure, mapPrSummary } from "../mods/wayfindr/providers/azure.js";

const ORG = "https://dev.azure.com/acme";
const azPr = (id, project, repo, extra = {}) => ({
  pullRequestId: id, title: `A${id}`, isDraft: false, creationDate: `2026-11-0${id}T00:00:00Z`,
  createdBy: { id: "u-ann", displayName: "Ann Lee" }, repository: { id: `r-${repo}`, name: repo, project: { name: project } }, ...extra,
});

test("Azure PR list entries map to summaries dated by creation", () => {
  assert.deepEqual(mapPrSummary(azPr(4, "My Proj", "web", { isDraft: true }), ORG), {
    key: "r-web!4", id: "web!4", title: "A4", url: `${ORG}/My%20Proj/_git/web/pullrequest/4`, repo: "My Proj/web", draft: true,
    author: { id: "u-ann", name: "Ann Lee" }, updatedAt: null, createdAt: "2026-11-04T00:00:00Z", head: null, checks: null,
  });
  const g = byRepo([mapPrSummary(azPr(1, "P", "web"), ORG), mapPrSummary(azPr(3, "P", "web"), ORG)]);
  assert.deepEqual(g[0].prs.map((p) => p.id), ["web!3", "web!1"]);
});

test("an Azure PR row carries lastMergeSourceCommit as its head, 40 hex chars only (#31)", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(mapPrSummary(azPr(1, "P", "web", { lastMergeSourceCommit: { commitId: sha } }), ORG).head, sha);
  assert.equal(mapPrSummary(azPr(1, "P", "web", { lastMergeSourceCommit: { commitId: "abc" } }), ORG).head, null);
  assert.equal(mapPrSummary(azPr(1, "P", "web"), ORG).head, null);
});

test("Azure lists every project (or the selected repos' projects) with the creator and reviewer filters for the signed-in user", async () => {
  const urls = [];
  const io = {
    profile: "work",
    run: async () => ({ code: 0, stdout: "tok\n", stderr: "" }),
    fetch: async (url, opts) => {
      urls.push(url);
      assert.equal(opts.headers.Authorization, "Bearer tok");
      const u = new URL(url);
      let body;
      if (u.pathname.endsWith("/_apis/connectionData")) body = { authenticatedUser: { id: "u-me" } };
      else if (u.pathname.endsWith("/_apis/projects")) body = { value: [{ name: "A" }, { name: "B c" }] };
      else {
        const project = decodeURIComponent(u.pathname.split("/")[2]);
        assert.equal(u.searchParams.get("searchCriteria.status"), "active");
        assert.equal(u.searchParams.get("api-version"), "7.1");
        body = u.searchParams.get("searchCriteria.creatorId") === "u-me"
          ? { value: project === "A" ? [azPr(1, "A", "web", { createdBy: { id: "u-me", displayName: "Me" }, isDraft: true })] : [] }
          : { value: [azPr(2, project, "api"), azPr(3, project, "self", { createdBy: { id: "u-me" } })] };
      }
      return { status: 200, ok: true, text: async () => JSON.stringify(body) };
    },
  };
  const r = await azure.pullRequests({ org: ORG }, io);
  assert.equal(urls.filter((x) => x.includes("/pullrequests")).length, 4);
  assert.ok(urls.some((x) => x.startsWith(`${ORG}/B%20c/_apis/git/pullrequests?`)));
  assert.deepEqual(r.mine.map((p) => [p.repo, p.id, p.draft]), [["A/web", "web!1", true]]);
  assert.deepEqual(r.needsReview.map((p) => p.repo), ["A/api", "B c/api"]); // the user's own PRs drop out
  assert.equal(r.me, "u-me");
  urls.length = 0;
  await azure.pullRequests({ org: ORG, prRepos: { mode: "selected", selected: ["B c/api"] } }, io);
  assert.equal(urls.some((x) => x.includes("/_apis/projects")), false);
  assert.deepEqual(urls.filter((x) => x.includes("/pullrequests")).map((x) => new URL(x).pathname.split("/")[2]), ["B%20c", "B%20c"]);
});
