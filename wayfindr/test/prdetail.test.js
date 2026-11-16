import { test } from "node:test";
import assert from "node:assert/strict";
import { github, PR_DETAIL_QUERY, mapChecks as ghChecks } from "../mods/wayfindr/providers/github.js";
import { azure, fileStatus, mapChecks as azChecks } from "../mods/wayfindr/providers/azure.js";
import { CAPABILITIES, checksState } from "../mods/wayfindr/providers/contract.js";
import { loadPullRequestDetail } from "../mods/wayfindr/flow.js";

const json = (data, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });

// ---- GitHub ----

const ghNode = (extra = {}) => ({
  number: 12, title: "Add x", url: "https://github.com/o/web/pull/12", repository: { nameWithOwner: "o/web" },
  body: "See [here](javascript:alert(1)) and [docs](https://x.dev)", state: "OPEN", isDraft: true,
  mergedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z",
  headRefName: "feat/x", baseRefName: "main", changedFiles: 250,
  author: { login: "ann", name: "Ann Lee" },
  reviewRequests: { nodes: [{ requestedReviewer: { login: "bob", name: "Bob" } }, { requestedReviewer: { name: "core-team" } }, { requestedReviewer: { login: "cy" } }] },
  latestReviews: { nodes: [
    { author: { login: "cy" }, state: "APPROVED" }, { author: { login: "dee" }, state: "CHANGES_REQUESTED" },
    { author: { login: "eve" }, state: "COMMENTED" }, { author: { login: "fay" }, state: "PENDING" }, { author: { login: "gus" }, state: "DISMISSED" },
  ] },
  comments: { totalCount: 103, nodes: [
    { author: { login: "ann" }, body: "first", createdAt: "2026-11-01T01:00:00Z" },
    { author: null, body: "[x](vbscript:y)", createdAt: "2026-11-01T03:00:00Z" },
  ] },
  reviewThreads: { totalCount: 1, nodes: [{ path: "src/a.js", line: 7, comments: { totalCount: 21, nodes: [{ author: { login: "dee" }, body: "nit", createdAt: "2026-11-01T02:00:00Z" }] } }] },
  ...extra,
});

const ghFile = (i, extra = {}) => ({ filename: `f${i}.js`, status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b", ...extra });

function ghIo(node, pages) {
  const calls = [];
  return {
    calls,
    run: async () => ({ code: 0, stdout: "tok\n", stderr: "" }),
    fetch: async (url, opts) => {
      calls.push({ url, ...opts });
      if (url === "https://api.github.com/graphql") return json({ data: { node } });
      const page = Number(new URL(url).searchParams.get("page"));
      return json(pages[page - 1] ?? []);
    },
  };
}

test("GitHub pullRequest: one query, REST files paged with the right headers, mapped to a PrDetail", async () => {
  const page = (from, n) => Array.from({ length: n }, (_, i) => ghFile(from + i));
  const pages = [
    [ghFile(0, { status: "removed" }), ghFile(1, { status: "renamed", previous_filename: "old1.js" }), ghFile(2, { status: "copied" }),
      ghFile(3, { status: "changed" }), ghFile(4, { status: "added", patch: undefined }), ...page(5, 95)],
    page(100, 100), page(200, 100), page(300, 100),
  ];
  const io = ghIo(ghNode(), pages);
  const pr = { key: "PR_node", id: "web#12", repo: "o/web" };
  const d = await github.pullRequest({ login: "me" }, pr, io);

  const gql = JSON.parse(io.calls[0].body);
  assert.equal(gql.query, PR_DETAIL_QUERY);
  assert.deepEqual(gql.variables, { id: "PR_node" });
  const rest = io.calls.slice(1);
  assert.deepEqual(rest.map((c) => c.url), [1, 2, 3].map((p) => `https://api.github.com/repos/o/web/pulls/12/files?per_page=100&page=${p}`));
  for (const c of rest) {
    assert.equal(c.method, "GET");
    assert.equal(c.headers.Authorization, "Bearer tok");
    assert.equal(c.headers.Accept, "application/vnd.github+json");
    assert.equal(c.headers["X-GitHub-Api-Version"], "2022-11-28");
  }

  assert.equal(d.files.length, 300);
  assert.equal(d.moreFiles, 0); // changedFiles 250 < 300: GitHub's count rules, never below zero
  assert.deepEqual(d.files.slice(0, 5).map((f) => f.status), ["deleted", "renamed", "added", "modified", "added"]);
  assert.equal(d.files[1].oldPath, "old1.js");
  assert.equal(d.files[0].oldPath, null);
  assert.deepEqual(d.files[4], { path: "f4.js", oldPath: null, status: "added", additions: 1, deletions: 1, patch: null, binary: true });
  assert.equal(d.files[3].patch, "@@ -1 +1 @@\n-a\n+b");
  assert.equal(d.truncated, false);

  assert.equal(d.description, "See here and [docs](https://x.dev)"); // the javascript: link is text now
  assert.deepEqual({ key: d.key, id: d.id, title: d.title, url: d.url, repo: d.repo, state: d.state, draft: d.draft, branch: d.branch, target: d.target },
    { key: "PR_node", id: "web#12", title: "Add x", url: "https://github.com/o/web/pull/12", repo: "o/web", state: "open", draft: true, branch: "feat/x", target: "main" });
  assert.deepEqual(d.author, { id: "ann", name: "Ann Lee" });
  assert.deepEqual([d.createdAt, d.updatedAt, d.mergedAt], ["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", null]);
  assert.deepEqual(d.reviewers, [
    { name: "cy", state: "approved" }, { name: "dee", state: "changes" }, { name: "eve", state: "commented" },
    { name: "fay", state: "pending" }, { name: "gus", state: "commented" }, { name: "bob", state: "waiting" }, { name: "core-team", state: "waiting" },
  ]);
  assert.deepEqual(d.comments, [
    { author: "ann", createdAt: "2026-11-01T01:00:00Z", body: "first", path: null, line: null },
    { author: "dee", createdAt: "2026-11-01T02:00:00Z", body: "nit", path: "src/a.js", line: 7 },
    { author: "ghost", createdAt: "2026-11-01T03:00:00Z", body: "x", path: null, line: null },
  ]);
  assert.equal(d.moreComments, 101 + 20);
});

test("GitHub pullRequest: few files fetch one page, the rest counted, merged state", async () => {
  const io = ghIo(ghNode({ changedFiles: 3, state: "MERGED", mergedAt: "2026-11-03T00:00:00Z" }), [[ghFile(0), ghFile(1)]]);
  const d = await github.pullRequest({ login: "me" }, { key: "K", repo: "o/web" }, io);
  assert.equal(io.calls.length, 2);
  assert.equal(d.moreFiles, 1);
  assert.equal(d.state, "merged");
  assert.equal(d.mergedAt, "2026-11-03T00:00:00Z");
});

test("GitHub pullRequest: a refused files request is a message without the token", async () => {
  const io = ghIo(ghNode(), []);
  io.fetch = async (url) => (url.endsWith("graphql") ? json({ data: { node: ghNode() } }) : json({ message: "Not Found" }, 404));
  await assert.rejects(github.pullRequest({ login: "me" }, { key: "K" }, io), (e) => /GitHub answered 404: Not Found/.test(e.message) && !e.message.includes("tok"));
});

// ---- Azure ----

const ORG = "https://dev.azure.com/acme";
const SRC = "a".repeat(40), TGT = "b".repeat(40);
const azPr = {
  pullRequestId: 5, title: "Fix y", status: "completed", isDraft: false, closedDate: "2026-11-04T00:00:00Z",
  description: "Body [bad](javascript:x)", creationDate: "2026-11-01T00:00:00Z",
  createdBy: { id: "u1", displayName: "Ann Lee" }, sourceRefName: "refs/heads/feat/y", targetRefName: "refs/heads/main",
  repository: { id: "r1", name: "web", project: { name: "P" } },
  lastMergeSourceCommit: { commitId: SRC }, lastMergeTargetCommit: { commitId: TGT },
  reviewers: [10, 5, 0, -5, -10, 3].map((vote, i) => ({ displayName: `R${i}`, vote })),
};
const threads = { value: [
  { id: 1, comments: [{ author: { displayName: "Bob" }, content: "Looks good", publishedDate: "2026-11-02T00:00:00Z", commentType: "text" }] },
  { id: 2, isDeleted: true, comments: [{ author: { displayName: "X" }, content: "gone", publishedDate: "2026-11-01T00:00:00Z" }] },
  { id: 3, comments: [{ author: { displayName: "System" }, content: "voted 10", publishedDate: "2026-11-01T00:00:00Z", commentType: "system" }] },
  { id: 4, threadContext: { filePath: "/src/a.js", rightFileStart: { line: 3, offset: 1 } },
    comments: [{ author: { displayName: "Cy" }, content: "[p](data:text/html,x) why?", publishedDate: "2026-11-01T12:00:00Z", commentType: "text" }] },
] };
const change = (path, changeType, extra = {}) => ({ item: { path, gitObjectType: "blob" }, changeType, ...extra });
const textItem = (content) => ({ gitObjectType: "blob", content });

function azIo(entries, items) {
  const calls = [];
  return {
    calls, profile: "work",
    run: async () => ({ code: 0, stdout: "tok\n", stderr: "" }),
    fetch: async (url, opts) => {
      calls.push(url);
      assert.equal(opts.headers.Authorization, "Bearer tok");
      assert.match(url, /api-version=7\.1$/);
      const u = new URL(url), p = u.pathname;
      if (p === "/acme/P/_apis/git/repositories/r1/pullRequests/5") return json(azPr);
      if (p.endsWith("/pullRequests/5/threads")) return json(threads);
      if (p.endsWith("/pullRequests/5/iterations")) return json({ value: [{ id: 1 }, { id: 2, commonRefCommit: { commitId: "c".repeat(40) } }] });
      if (p.endsWith("/pullRequests/5/iterations/2/changes")) return json({ changeEntries: entries });
      if (p === "/acme/P/_apis/git/repositories/r1/items") {
        assert.equal(u.searchParams.get("includeContent"), "true");
        assert.equal(u.searchParams.get("versionDescriptor.versionType"), "commit");
        const k = `${u.searchParams.get("versionDescriptor.version") === SRC ? "new" : "old"}:${u.searchParams.get("path")}`;
        return k in items ? json(items[k]) : json({ message: "not found" }, 404);
      }
      return json({ message: `no route ${url}` }, 404);
    },
  };
}

test("Azure pullRequest: PR, threads, iterations, changes and items, mapped to a PrDetail", async () => {
  const entries = [
    change("/src/a.js", "edit"),
    change("/src/new.js", "add"),
    change("/src/gone.js", "delete"),
    change("/src/b.js", "edit, rename", { originalPath: "/src/old-b.js" }),
    change("/img/logo.png", "edit"),
    { item: { path: "/src", isFolder: true }, changeType: "edit" },
  ];
  const items = {
    "old:/src/a.js": textItem("a\nb\nc\n"), "new:/src/a.js": textItem("a\nB\nc\n"),
    "new:/src/new.js": textItem("x\n"),
    "old:/src/gone.js": textItem("y\n"),
    "old:/src/old-b.js": textItem("k\n"), "new:/src/b.js": textItem("k\nl\n"),
    "old:/img/logo.png": { gitObjectType: "blob", contentMetadata: { isBinary: true } }, "new:/img/logo.png": { gitObjectType: "blob", isBinary: true },
  };
  const io = azIo(entries, items);
  const d = await azure.pullRequest({ org: ORG }, { key: "r1!5", repo: "P/web" }, io);

  const kinds = new Set(io.calls.map((c) => new URL(c).pathname.replace(/^\/acme\/P\/_apis\/git\/repositories\/r1\//, "").replace(/\/\d+(\/|$)/g, "/N$1")));
  assert.deepEqual([...kinds].sort(), ["items", "pullRequests/N", "pullRequests/N/iterations", "pullRequests/N/iterations/N/changes", "pullRequests/N/statuses", "pullRequests/N/threads"]);
  assert.ok(io.calls.some((c) => c.includes("/changes?$top=100&")));
  assert.equal(io.calls.filter((c) => c.includes("/items?")).length, 8); // add and delete fetch one side only
  // The old side is the iteration's merge base, not the target branch's tip.
  const olds = io.calls.filter((c) => c.includes("/items?") && !c.includes(`versionDescriptor.version=${SRC}`));
  assert.ok(olds.length > 0 && olds.every((c) => c.includes(`versionDescriptor.version=${"c".repeat(40)}`)));
  assert.ok(!io.calls.some((c) => c.includes(TGT)));

  assert.deepEqual(d.files, [
    { path: "/src/a.js", oldPath: null, status: "modified", additions: 1, deletions: 1, patch: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c", binary: false },
    { path: "/src/new.js", oldPath: null, status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+x", binary: false },
    { path: "/src/gone.js", oldPath: null, status: "deleted", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-y", binary: false },
    { path: "/src/b.js", oldPath: "/src/old-b.js", status: "renamed", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n k\n+l", binary: false },
    { path: "/img/logo.png", oldPath: null, status: "modified", additions: 0, deletions: 0, patch: null, binary: true },
  ]);
  assert.equal(d.moreFiles, 0);
  assert.equal(d.truncated, false);

  assert.deepEqual(d.reviewers.map((r) => r.state), ["approved", "approved", "waiting", "commented", "rejected", "waiting"]);
  assert.deepEqual(d.comments, [
    { author: "Cy", createdAt: "2026-11-01T12:00:00Z", body: "p why?", path: "/src/a.js", line: 3 },
    { author: "Bob", createdAt: "2026-11-02T00:00:00Z", body: "Looks good", path: null, line: null },
  ]);
  assert.equal(d.moreComments, 0);
  assert.equal(d.description, "Body bad");
  assert.deepEqual({ key: d.key, id: d.id, repo: d.repo, state: d.state, draft: d.draft, branch: d.branch, target: d.target, mergedAt: d.mergedAt, updatedAt: d.updatedAt, createdAt: d.createdAt },
    { key: "r1!5", id: "web!5", repo: "P/web", state: "merged", draft: false, branch: "feat/y", target: "main", mergedAt: "2026-11-04T00:00:00Z", updatedAt: null, createdAt: "2026-11-01T00:00:00Z" });
  assert.deepEqual(d.author, { id: "u1", name: "Ann Lee" });
});

test("Azure pullRequest: only the first 50 files are diffed, the rest counted", async () => {
  const entries = Array.from({ length: 60 }, (_, i) => change(`/f${i}.txt`, "edit"));
  const items = Object.fromEntries(entries.flatMap((e, i) => [[`old:${e.item.path}`, textItem(`${i}\n`)], [`new:${e.item.path}`, textItem(`${i}!\n`)]]));
  const io = azIo(entries, items);
  const d = await azure.pullRequest({ org: ORG }, { key: "r1!5", repo: "P/web" }, io);
  assert.equal(d.files.length, 50);
  assert.equal(d.moreFiles, 10);
  assert.equal(io.calls.filter((c) => c.includes("/items?")).length, 100);
  assert.equal(d.files[49].path, "/f49.txt");
});

test("Azure change types map to the four statuses", () => {
  assert.deepEqual(["add", "edit", "delete", "rename", "edit, rename"].map(fileStatus), ["added", "modified", "deleted", "renamed", "renamed"]);
});

// ---- Contract and flow ----

test("prDetail is a capability of GitHub and Azure, not ClickUp, and the flow refuses a Provider without it", async () => {
  assert.ok(CAPABILITIES.includes("prDetail"));
  const profile = { accounts: [{ id: "gh", provider: "github" }, { id: "cu", provider: "clickup" }] };
  let seen = null;
  const registry = {
    github: { capabilities: ["prDetail"], pullRequest: async (account, pr) => { seen = [account.id, pr.key]; return { ok: 1 }; } },
    clickup: { capabilities: ["board"] },
  };
  assert.deepEqual(await loadPullRequestDetail(profile, "gh", { key: "K" }, {}, {}, registry), { ok: 1 });
  assert.deepEqual(seen, ["gh", "K"]);
  await assert.rejects(loadPullRequestDetail(profile, "cu", { key: "K" }, {}, {}, registry), /isn't supported/);
  await assert.rejects(loadPullRequestDetail(profile, "nope", { key: "K" }, {}, {}, registry), /No account/);
  const { clickup } = await import("../mods/wayfindr/providers/clickup.js");
  assert.ok(!clickup.capabilities.includes("prDetail"));
  assert.ok(github.capabilities.includes("prDetail") && azure.capabilities.includes("prDetail"));
});

test("GitHub pullRequest with patches false: the GraphQL query only, no files", async () => {
  const io = ghIo(ghNode(), [[ghFile(0)]]);
  const d = await github.pullRequest({ login: "me" }, { key: "PR_node", repo: "o/web" }, io, { patches: false });
  assert.equal(io.calls.length, 1);
  assert.equal(io.calls[0].url, "https://api.github.com/graphql");
  assert.ok(d.files.every((f) => f.patch === null));
  assert.equal(d.branch, "feat/x");
});

test("Azure pullRequest with patches false: no item fetches, files with patch null", async () => {
  const entries = [change("/src/a.js", "edit"), change("/src/new.js", "add"), change("/src/b.js", "rename", { originalPath: "/src/old-b.js" })];
  const io = azIo(entries, {});
  const d = await azure.pullRequest({ org: ORG }, { key: "r1!5", repo: "P/web" }, io, { patches: false });
  assert.equal(io.calls.filter((c) => c.includes("/items?")).length, 0);
  assert.deepEqual(d.files.map((f) => [f.path, f.status, f.patch, f.oldPath]),
    [["/src/a.js", "modified", null, null], ["/src/new.js", "added", null, null], ["/src/b.js", "renamed", null, "/src/old-b.js"]]);
});

test("loadPullRequestDetail hands opts to the Provider", async () => {
  let got = null;
  const registry = { github: { capabilities: ["prDetail"], pullRequest: async (_a, _p, _io, opts) => { got = opts; return {}; } } };
  await loadPullRequestDetail({ accounts: [{ id: "gh", provider: "github" }] }, "gh", { key: "K" }, {}, { patches: false }, registry);
  assert.deepEqual(got, { patches: false });
});

// ---- Threads and head (#24, #25) ----

test("GitHub mapPrDetail: head from headRefOid, review threads with side, resolved and outdated", async () => {
  assert.match(PR_DETAIL_QUERY, /headRefOid/);
  assert.match(PR_DETAIL_QUERY, /nodes \{ id path line isResolved isOutdated diffSide comments/);
  const c = (author, at, body) => ({ author: { login: author }, body, createdAt: at });
  const node = ghNode({
    headRefOid: "f".repeat(40),
    reviewThreads: { totalCount: 4, nodes: [
      { id: "T2", path: "src/a.js", line: 9, isResolved: true, isOutdated: false, diffSide: "RIGHT",
        comments: { totalCount: 2, nodes: [c("cy", "2026-11-01T05:00:00Z", "why"), c("ann", "2026-11-01T06:00:00Z", "[x](javascript:y) because")] } },
      { id: "T1", path: "src/b.js", line: 3, isResolved: false, isOutdated: false, diffSide: "LEFT",
        comments: { totalCount: 1, nodes: [c("dee", "2026-11-01T04:00:00Z", "old line")] } },
      { id: "T3", path: "src/c.js", line: 4, isResolved: false, isOutdated: true, diffSide: "RIGHT",
        comments: { totalCount: 1, nodes: [c("eve", "2026-11-01T07:00:00Z", "stale")] } },
      { id: "T4", path: "src/d.js", line: 1, isResolved: false, isOutdated: false, diffSide: "RIGHT", comments: { totalCount: 0, nodes: [] } },
    ] },
  });
  const d = await github.pullRequest({ login: "me" }, { key: "PR_node", repo: "o/web" }, ghIo(node, []), { patches: false });
  assert.equal(d.head, "f".repeat(40));
  assert.deepEqual(d.threads, [
    { id: "T1", path: "src/b.js", line: 3, side: "old", resolved: false, comments: [{ author: "dee", createdAt: "2026-11-01T04:00:00Z", body: "old line" }] },
    { id: "T2", path: "src/a.js", line: 9, side: "new", resolved: true, comments: [
      { author: "cy", createdAt: "2026-11-01T05:00:00Z", body: "why" }, { author: "ann", createdAt: "2026-11-01T06:00:00Z", body: "x because" }] },
    { id: "T3", path: "src/c.js", line: null, side: "new", resolved: false, comments: [{ author: "eve", createdAt: "2026-11-01T07:00:00Z", body: "stale" }] },
  ]);
  assert.equal(d.comments.filter((x) => x.path).length, 4); // the flat list is unchanged
  assert.equal((await github.pullRequest({ login: "me" }, { key: "K", repo: "o/web" }, ghIo(ghNode(), []), { patches: false })).head, null);
});

test("Azure mapPrDetail: head from lastMergeSourceCommit, file threads with side and resolved, path without the slash", async () => {
  const text = (author, at, content) => ({ author: { displayName: author }, content, publishedDate: at, commentType: "text" });
  const value = [
    { id: 10, status: "fixed", threadContext: { filePath: "/src/a.js", rightFileStart: { line: 3 } },
      comments: [text("Cy", "2026-11-01T02:00:00Z", "why"), text("Ann", "2026-11-01T03:00:00Z", "because")] },
    { id: 11, status: "active", threadContext: { filePath: "/src/b.js", leftFileStart: { line: 7 } }, comments: [text("Bob", "2026-11-01T01:00:00Z", "gone line")] },
    { id: 12, threadContext: { filePath: "/src/c.js" }, comments: [text("Dee", "2026-11-01T04:00:00Z", "on the file")] },
    { id: 13, status: "wontFix", threadContext: { filePath: "/src/d.js", rightFileStart: { line: 1 } }, comments: [text("Eve", "2026-11-01T05:00:00Z", "no")] },
    { id: 14, status: "pending", threadContext: { filePath: "/src/e.js", rightFileStart: { line: 2 } }, comments: [text("Fay", "2026-11-01T06:00:00Z", "hm")] },
    { id: 15, status: "active", comments: [text("Gus", "2026-11-01T00:00:00Z", "general")] },
    { id: 16, status: "active", threadContext: { filePath: "/src/f.js" }, comments: [{ ...text("S", "2026-11-01T00:00:00Z", "x"), commentType: "system" }] },
  ];
  const io = azIo([change("/src/a.js", "edit")], {});
  const fetch = io.fetch;
  io.fetch = async (url, opts) => (new URL(url).pathname.endsWith("/threads") ? json({ value }) : fetch(url, opts));
  const d = await azure.pullRequest({ org: ORG }, { key: "r1!5", repo: "P/web" }, io, { patches: false });
  assert.equal(d.head, SRC);
  assert.deepEqual(d.threads.map((t) => [t.id, t.path, t.line, t.side, t.resolved, t.comments.map((c) => c.author).join(",")]), [
    [11, "src/b.js", 7, "old", false, "Bob"],
    [10, "src/a.js", 3, "new", true, "Cy,Ann"],
    [12, "src/c.js", null, "new", null, "Dee"],
    [13, "src/d.js", 1, "new", true, "Eve"],
    [14, "src/e.js", 2, "new", false, "Fay"],
  ]);
  assert.deepEqual(d.threads[1].comments[1], { author: "Ann", createdAt: "2026-11-01T03:00:00Z", body: "because" });
  assert.equal(d.comments.length, 7); // the flat list keeps the general thread too
});

// ---- Checks (#26) ----

test("checksState: fail over pending over pass, none when nothing passed, failed or ran", () => {
  const s = (...states) => checksState(states.map((state) => ({ state })));
  assert.equal(s("pass", "pending", "fail", "skipped"), "fail");
  assert.equal(s("pass", "pending", "skipped"), "pending");
  assert.equal(s("pass", "skipped"), "pass");
  assert.equal(s("skipped"), "none");
  assert.equal(s(), "none");
});

test("GitHub mapChecks: CheckRun conclusions and StatusContext states, names, groups and links", () => {
  const run = (name, conclusion, extra = {}) => ({ __typename: "CheckRun", name, conclusion, status: conclusion ? "COMPLETED" : "IN_PROGRESS", detailsUrl: `https://github.com/o/web/runs/${name}`, ...extra });
  const wf = { checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } } };
  const nodes = [
    ...["SUCCESS", "NEUTRAL", "FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "CANCELLED", "SKIPPED", "STALE", null].map((c, i) => run(`r${i}`, c, wf)),
    run("app", "SUCCESS", { checkSuite: { app: { name: "Codecov" }, workflowRun: null } }),
    run("bare", "SUCCESS", { detailsUrl: "javascript:alert(1)" }),
    ...["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"].map((state, i) => ({ __typename: "StatusContext", context: `s${i}`, state, targetUrl: `https://ci.example/${i}`, description: i ? "" : "All good" })),
    null,
  ];
  const r = ghChecks({ state: "FAILURE", contexts: { totalCount: nodes.length - 1, nodes } });
  assert.equal(r.state, "fail");
  assert.deepEqual(r.list.slice(0, 10).map((c) => c.state), ["pass", "pass", "fail", "fail", "fail", "fail", "fail", "skipped", "skipped", "pending"]);
  assert.deepEqual(r.list[0], { name: "r0", group: "CI", state: "pass", url: "https://github.com/o/web/runs/r0", description: null });
  assert.equal(r.list[10].group, "Codecov");
  assert.deepEqual([r.list[11].group, r.list[11].url], [null, null]);
  assert.deepEqual(r.list.slice(12).map((c) => c.state), ["pass", "fail", "fail", "pending", "pending"]);
  assert.deepEqual(r.list[12], { name: "s0", group: null, state: "pass", url: "https://ci.example/0", description: "All good" });
  assert.equal(r.list[13].description, null);
  assert.deepEqual(ghChecks(null), { state: "none", list: [] });
});

test("GitHub pullRequest: the detail query asks for the rollup and the PrDetail carries its checks", async () => {
  assert.match(PR_DETAIL_QUERY, /statusCheckRollup \{ state contexts\(first: 100\)/);
  const node = ghNode({ commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING", contexts: { totalCount: 1, nodes: [
    { __typename: "CheckRun", name: "build", conclusion: null, status: "QUEUED", detailsUrl: "https://github.com/x", checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } } },
  ] } } } }] } });
  const d = await github.pullRequest({ login: "me" }, { key: "K", repo: "o/web" }, ghIo(node, []), { patches: false });
  assert.deepEqual(d.checks, { state: "pending", list: [{ name: "build", group: "CI", state: "pending", url: "https://github.com/x", description: null }] });
  const none = await github.pullRequest({ login: "me" }, { key: "K", repo: "o/web" }, ghIo(ghNode(), []), { patches: false });
  assert.deepEqual(none.checks, { state: "none", list: [] });
});

test("Azure mapChecks: evaluation and status states, names, groups, and only openable links", () => {
  const ev = (status, extra = {}) => ({ evaluationId: status, status, configuration: { isBlocking: true, type: { displayName: "Minimum number of reviewers" } }, ...extra });
  const r = azChecks({
    evaluations: [
      ...["approved", "rejected", "broken", "queued", "running", "notApplicable"].map((s) => ev(s)),
      ev("approved", { configuration: { type: { displayName: "Build" } }, context: { buildId: 9, buildDefinitionName: "web-ci" },
        _links: { self: { href: "https://dev.azure.com/acme/P/_apis/policy/evaluations/x" }, web: { href: "https://dev.azure.com/acme/P/_build/results?buildId=9" } } }),
      ev("approved", { _links: { self: { href: "https://dev.azure.com/acme/P/_apis/policy/evaluations/y" } } }),
      ev("approved", { _links: { web: { href: "http://insecure.example/x" } } }),
    ],
    statuses: ["succeeded", "failed", "error", "pending", "notSet", "notApplicable"].map((state, i) => ({
      state, description: i ? undefined : "Passed", context: { name: `st${i}`, genre: i === 1 ? "" : "sonar" }, targetUrl: i === 2 ? "file:///c:/x" : `https://sonar.example/${i}`,
    })),
  });
  assert.equal(r.state, "fail");
  assert.deepEqual(r.list.slice(0, 6).map((c) => c.state), ["pass", "fail", "fail", "pending", "pending", "skipped"]);
  assert.deepEqual(r.list[0], { name: "Minimum number of reviewers", group: "Policy", state: "pass", url: null, description: null });
  assert.deepEqual(r.list[6], { name: "Build: web-ci", group: "Policy", state: "pass", url: "https://dev.azure.com/acme/P/_build/results?buildId=9", description: null });
  assert.deepEqual([r.list[7].url, r.list[8].url], [null, null]);
  assert.deepEqual(r.list.slice(9).map((c) => c.state), ["pass", "fail", "fail", "pending", "skipped", "skipped"]);
  assert.deepEqual(r.list[9], { name: "st0", group: "sonar", state: "pass", url: "https://sonar.example/0", description: "Passed" });
  assert.deepEqual([r.list[10].group, r.list[11].url], [null, null]);
  assert.deepEqual(azChecks({ evaluations: [], statuses: [] }), { state: "none", list: [] });
});

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
function azChecksIo({ evaluations, statuses }) {
  const io = azIo([change("/src/a.js", "edit")], {});
  const fetch = io.fetch;
  io.policy = [];
  io.fetch = async (url, opts) => {
    const u = new URL(url), p = u.pathname;
    if (p === "/acme/P/_apis/git/repositories/r1/pullRequests/5") return json({ ...azPr, repository: { ...azPr.repository, project: { name: "P", id: PROJECT_ID } } });
    if (p === "/acme/P/_apis/policy/evaluations") {
      io.policy.push(url);
      assert.equal(u.searchParams.get("api-version"), "7.1-preview.1");
      assert.equal(u.searchParams.get("artifactId"), `vstfs:///CodeReview/CodeReviewId/${PROJECT_ID}/5`);
      return evaluations;
    }
    if (p.endsWith("/pullRequests/5/statuses")) return statuses;
    return fetch(url, opts);
  };
  return io;
}

test("Azure pullRequest: checks from the policy evaluations and the PR statuses", async () => {
  const io = azChecksIo({
    evaluations: json({ value: [{ status: "running", configuration: { type: { displayName: "Build" } }, context: { buildDefinitionName: "web-ci" } }] }),
    statuses: json({ value: [{ state: "succeeded", context: { name: "scan", genre: "sonar" }, targetUrl: "https://sonar.example/1", description: "ok" }] }),
  });
  const d = await azure.pullRequest({ org: ORG }, { key: "r1!5", repo: "P/web" }, io, { patches: false });
  assert.equal(io.policy.length, 1);
  assert.deepEqual(d.checks, { state: "pending", list: [
    { name: "Build: web-ci", group: "Policy", state: "pending", url: null, description: null },
    { name: "scan", group: "sonar", state: "pass", url: "https://sonar.example/1", description: "ok" },
  ] });
});

test("Azure pullRequest: a failed evaluations call leaves only the statuses, a failed statuses call only the evaluations", async () => {
  const evals = () => json({ value: [{ status: "rejected", configuration: { type: { displayName: "Comment requirements" } } }] });
  const sts = () => json({ value: [{ state: "succeeded", context: { name: "scan", genre: "sonar" }, targetUrl: "https://sonar.example/1" }] });
  const a = await azure.pullRequest({ org: ORG }, { key: "r1!5", repo: "P/web" }, azChecksIo({ evaluations: json({ message: "denied" }, 403), statuses: sts() }), { patches: false });
  assert.deepEqual(a.checks.list.map((c) => c.name), ["scan"]);
  assert.equal(a.checks.state, "pass");
  assert.equal(a.files.length, 1); // the detail itself still loads
  const b = await azure.pullRequest({ org: ORG }, { key: "r1!5", repo: "P/web" }, azChecksIo({ evaluations: evals(), statuses: json({ message: "boom" }, 500) }), { patches: false });
  assert.deepEqual(b.checks, { state: "fail", list: [{ name: "Comment requirements", group: "Policy", state: "fail", url: null, description: null }] });
});
