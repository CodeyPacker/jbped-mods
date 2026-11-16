import { test } from "node:test";
import assert from "node:assert/strict";
import { azure } from "../mods/wayfindr/providers/azure.js";
import { github } from "../mods/wayfindr/providers/github.js";

const recorder = (answer = "{}") => {
  const sent = [];
  return {
    sent,
    io: {
      profile: "work",
      run: async () => ({ code: 0, stdout: "tok\n", stderr: "" }),
      fetch: async (url, opts) => { sent.push({ url, ...opts, json: JSON.parse(opts.body ?? "null") }); return { ok: true, status: 200, text: async () => answer }; },
    },
  };
};

test("Azure: a title edit is one patch, a comment posts markdown to the comments API", async () => {
  const a = { org: "https://dev.azure.com/o" }, ref = { id: 5, project: "My P" };
  let r = recorder();
  await azure.update(a, ref, { title: "  New title " }, r.io);
  assert.equal(r.sent[0].method, "PATCH");
  assert.deepEqual(r.sent[0].json, [{ op: "add", path: "/fields/System.Title", value: "New title" }]);
  await assert.rejects(azure.update(a, ref, { title: " " }, r.io), /can't be empty/);
  r = recorder();
  await azure.comment(a, ref, "**done**", r.io);
  assert.equal(r.sent[0].method, "POST");
  assert.match(r.sent[0].url, /\/My%20P\/_apis\/wit\/workItems\/5\/comments\?format=markdown&api-version=7\.1-preview\.4$/);
  assert.deepEqual(r.sent[0].json, { text: "**done**" });
});

test("GitHub: titles by content type, comments on issues and PRs only", async () => {
  let r = recorder(JSON.stringify({ data: {} }));
  await github.update({ login: "me" }, { kind: "PullRequest", contentId: "PR1" }, { title: "T" }, r.io);
  assert.match(r.sent[0].json.query, /updatePullRequest/);
  assert.deepEqual(r.sent[0].json.variables, { id: "PR1", title: "T" });
  await github.comment({ login: "me" }, { kind: "Issue", contentId: "I1" }, "hi", r.io);
  assert.match(r.sent[1].json.query, /addComment/);
  assert.deepEqual(r.sent[1].json.variables, { id: "I1", body: "hi" });
  await assert.rejects(github.comment({ login: "me" }, { kind: "DraftIssue", contentId: "D" }, "hi", r.io), /Draft issues/);
});

test("GitHub: a missing scope on a title or comment names the scope that write needs (verify-move-update F9)", async () => {
  const r = recorder(JSON.stringify({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes" }] }));
  await assert.rejects(github.update({ login: "me" }, { kind: "DraftIssue", contentId: "D" }, { title: "T" }, r.io), /needs the project scope to edit titles\. Run: gh auth refresh -h github\.com -s project$/);
  await assert.rejects(github.update({ login: "me" }, { kind: "Issue", contentId: "I" }, { title: "T" }, r.io), /needs the repo scope.*-s repo$/);
  await assert.rejects(github.comment({ login: "me" }, { kind: "Issue", contentId: "I" }, "hi", r.io), /needs the repo scope to post comments/);
  const other = recorder(JSON.stringify({ errors: [{ message: "Could not resolve to a node" }] }));
  await assert.rejects(github.update({ login: "me" }, { kind: "Issue", contentId: "I" }, { title: "T" }, other.io), /^Error: Could not resolve to a node$/);
});

// ---- Posting a review and replying (#27). Fake io only: nothing reaches a real Pull Request. ----
import { mapPrDetail as ghMapPrDetail } from "../mods/wayfindr/providers/github.js";
import { mapThreads, mapPrDetail as azMapPrDetail } from "../mods/wayfindr/providers/azure.js";

const TOKEN = "s3cret-token";
const writer = (answer) => {
  const sent = [];
  return {
    sent,
    io: {
      profile: "work",
      run: async () => ({ code: 0, stdout: `${TOKEN}\n`, stderr: "" }),
      fetch: async (url, opts) => {
        sent.push({ url, method: opts.method, headers: opts.headers, json: JSON.parse(opts.body ?? "null") });
        const [status, body] = answer(url, opts, sent.length);
        return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
      },
    },
  };
};
const ghDetail = { repo: "acme/web", id: "web#42", url: "https://github.com/acme/web/pull/42", head: "a".repeat(40) };

test("GitHub postReview: one POST to the reviews API with the verdict, the summary and the line comments", async () => {
  const r = writer(() => [200, { id: 1, html_url: "https://github.com/acme/web/pull/42#pullrequestreview-1" }]);
  const out = await github.postReview({ login: "me" }, { key: "PR_1" }, ghDetail, { event: "changes", body: " Fix it ", comments: [
    { path: "src/a.js", line: 12, side: "new", startLine: 10, startSide: "new", body: "range" },
    { path: "/src/b.js", line: 3, side: "old", body: "removed line" },
  ] }, r.io);
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].method, "POST");
  assert.equal(r.sent[0].url, "https://api.github.com/repos/acme/web/pulls/42/reviews");
  assert.equal(r.sent[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(r.sent[0].headers["Content-Type"], "application/json");
  assert.deepEqual(r.sent[0].json, { commit_id: "a".repeat(40), event: "REQUEST_CHANGES", body: "Fix it", comments: [
    { path: "src/a.js", line: 12, side: "RIGHT", body: "range", start_line: 10, start_side: "RIGHT" },
    { path: "src/b.js", line: 3, side: "LEFT", body: "removed line" },
  ] });
  assert.deepEqual(out, { url: "https://github.com/acme/web/pull/42#pullrequestreview-1" });
});

test("GitHub postReview: an empty summary says to see the comments, except on an approval", async () => {
  let r = writer(() => [200, {}]);
  const out = await github.postReview({ login: "me" }, {}, ghDetail, { event: "comment", body: "", comments: [{ path: "a", line: 1, side: "new", body: "x" }] }, r.io);
  assert.equal(r.sent[0].json.event, "COMMENT");
  assert.equal(r.sent[0].json.body, "See the inline comments.");
  assert.deepEqual(out, { url: ghDetail.url }); // no review link in the answer: the PR's
  r = writer(() => [200, {}]);
  await github.postReview({ login: "me" }, {}, ghDetail, { event: "approve", body: "  ", comments: [] }, r.io);
  assert.deepEqual(r.sent[0].json, { commit_id: "a".repeat(40), event: "APPROVE", comments: [] });
  await assert.rejects(github.postReview({ login: "me" }, {}, ghDetail, { event: "merge", comments: [] }, r.io), /isn't a review verdict/);
  await assert.rejects(github.postReview({ login: "me" }, {}, { ...ghDetail, repo: "acme/web/../x" }, { event: "comment", body: "x", comments: [] }, r.io), /no repo or number/);
});

test("GitHub postReview: a refused review says why, never with the token", async () => {
  let r = writer(() => [422, { message: "Unprocessable Entity", errors: ["Can not approve your own pull request"] }]);
  await assert.rejects(github.postReview({ login: "me" }, {}, ghDetail, { event: "approve", body: "", comments: [] }, r.io), (e) => {
    assert.equal(e.message, "GitHub answered 422: Unprocessable Entity: Can not approve your own pull request");
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
  r = writer(() => [403, { message: "Resource not accessible by personal access token" }]);
  await assert.rejects(github.postReview({ login: "me" }, {}, ghDetail, { event: "comment", body: "x", comments: [] }, r.io), (e) => {
    assert.match(e.message, /needs the repo scope to post reviews\. Run: gh auth refresh -h github\.com -s repo$/);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
  r = writer(() => [502, `<html>${TOKEN}</html>`]);
  await assert.rejects(github.postReview({ login: "me" }, {}, ghDetail, { event: "comment", body: "x", comments: [] }, r.io), (e) => !e.message.includes(TOKEN) && /^GitHub answered 502$/.test(e.message));
  const thrown = { profile: "w", run: r.io.run, fetch: async () => { throw new Error(`fetch failed with Bearer ${TOKEN}`); } };
  await assert.rejects(github.postReview({ login: "me" }, {}, ghDetail, { event: "comment", body: "x", comments: [] }, thrown), (e) => !e.message.includes(TOKEN) && /failed before it was answered/.test(e.message));
});

test("GitHub reply: POST under the thread's first comment", async () => {
  const r = writer(() => [201, { id: 9 }]);
  await github.reply({ login: "me" }, {}, ghDetail, { id: "T1", reply: 777 }, "  thanks ", r.io);
  assert.equal(r.sent[0].method, "POST");
  assert.equal(r.sent[0].url, "https://api.github.com/repos/acme/web/pulls/42/comments/777/replies");
  assert.deepEqual(r.sent[0].json, { body: "thanks" });
  await assert.rejects(github.reply({ login: "me" }, {}, ghDetail, { id: "T1", reply: null }, "x", r.io), /can't take replies/);
  await assert.rejects(github.reply({ login: "me" }, {}, ghDetail, { id: "T1", reply: 1 }, " ", r.io), /Write a reply/);
  assert.equal(r.sent.length, 1);
});

test("GitHub detail: me from the viewer, reply from the thread's first comment's databaseId", () => {
  const node = { headRefName: "f", number: 42, repository: { nameWithOwner: "acme/web" }, state: "OPEN", author: { login: "ann" },
    reviewThreads: { totalCount: 1, nodes: [{ id: "T1", path: "a.js", line: 2, isResolved: false, isOutdated: false, diffSide: "RIGHT",
      comments: { totalCount: 1, nodes: [{ databaseId: 555, author: { login: "bo" }, body: "x", createdAt: "2026-11-01T00:00:00Z" }] } }] } };
  const d = ghMapPrDetail(node, [], { key: "K" }, { login: "me", name: "Me Too" });
  assert.deepEqual(d.me, { id: "me", name: "Me Too" });
  assert.equal(d.threads[0].reply, 555);
  assert.equal(ghMapPrDetail(node, [], { key: "K" }).me, null);
});

const AZ = { org: "https://dev.azure.com/acme" }, azPr = { key: "r1!5", repo: "My P/web", url: "https://dev.azure.com/acme/My%20P/_git/web/pullrequest/5" };
const PR_PATH = "https://dev.azure.com/acme/My%20P/_apis/git/repositories/r1/pullRequests/5";

test("Azure postReview: a thread per comment, the summary thread, then the vote", async () => {
  const r = writer(() => [200, {}]);
  const out = await azure.postReview(AZ, azPr, { url: azPr.url, me: { id: "u-1", name: "Me" } }, { event: "changes", body: " Sum ", comments: [
    { path: "src/a.js", line: 12, side: "new", startLine: 10, startSide: "new", body: "range" },
    { path: "src/b.js", line: 3, side: "old", body: "old line" },
  ] }, r.io);
  assert.deepEqual(r.sent.map((s) => `${s.method} ${s.url}`), [
    `POST ${PR_PATH}/threads?api-version=7.1`,
    `POST ${PR_PATH}/threads?api-version=7.1`,
    `POST ${PR_PATH}/threads?api-version=7.1`,
    `PUT ${PR_PATH}/reviewers/u-1?api-version=7.1`,
  ]);
  assert.deepEqual(r.sent[0].json, { comments: [{ parentCommentId: 0, content: "range", commentType: 1 }], status: 1,
    threadContext: { filePath: "/src/a.js", rightFileStart: { line: 10, offset: 1 }, rightFileEnd: { line: 12, offset: 1 } } });
  assert.deepEqual(r.sent[1].json.threadContext, { filePath: "/src/b.js", leftFileStart: { line: 3, offset: 1 }, leftFileEnd: { line: 3, offset: 1 } });
  assert.deepEqual(r.sent[2].json, { comments: [{ parentCommentId: 0, content: "Sum", commentType: 1 }], status: 1 });
  assert.deepEqual(r.sent[3].json, { vote: -10, id: "u-1" });
  assert.equal(r.sent[3].headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(out, { url: azPr.url });
});

test("Azure postReview: a comment casts no vote, an approval votes 10, asking who is signed in when the detail doesn't say", async () => {
  let r = writer(() => [200, {}]);
  await azure.postReview(AZ, azPr, { url: azPr.url, me: { id: "u-1" } }, { event: "comment", body: "", comments: [{ path: "a", line: 1, side: "new", body: "x" }] }, r.io);
  assert.deepEqual(r.sent.map((s) => s.method), ["POST"]);
  r = writer((url) => [200, url.includes("connectionData") ? { authenticatedUser: { id: "u-2" } } : {}]);
  await azure.postReview(AZ, azPr, { url: azPr.url, me: null }, { event: "approve", body: "", comments: [] }, r.io);
  assert.deepEqual(r.sent.map((s) => s.method), ["GET", "PUT"]);
  assert.match(r.sent[0].url, /\/_apis\/connectionData\?/);
  assert.equal(r.sent[1].url, `${PR_PATH}/reviewers/u-2?api-version=7.1`);
  assert.deepEqual(r.sent[1].json, { vote: 10, id: "u-2" });
});

test("Azure postReview: a refusal says how far it got, never with the token", async () => {
  let r = writer((_u, _o, n) => (n === 1 ? [200, {}] : [400, { message: "The line is outside the file" }]));
  const review = { event: "comment", body: "", comments: [{ path: "a", line: 1, side: "new", body: "x" }, { path: "a", line: 900, side: "new", body: "y" }] };
  await assert.rejects(azure.postReview(AZ, azPr, { me: { id: "u" } }, review, r.io), (e) => {
    assert.equal(e.message, "Posted 1 of 2 threads, then: The line is outside the file");
    return !e.message.includes(TOKEN);
  });
  r = writer(() => [401, ""]);
  await assert.rejects(azure.postReview(AZ, azPr, { me: { id: "u" } }, review, r.io), (e) => /refused the login \(401\)/.test(e.message) && !e.message.includes(TOKEN));
  await assert.rejects(azure.postReview(AZ, { key: "bad", repo: "P/web" }, {}, review, r.io), /no Pull Request to post to/);
});

test("Azure reply: POST a comment under the thread's first comment", async () => {
  const r = writer(() => [200, {}]);
  await azure.reply(AZ, azPr, {}, { id: 7, reply: { threadId: 7, commentId: 1 } }, " ok ", r.io);
  assert.equal(r.sent[0].method, "POST");
  assert.equal(r.sent[0].url, `${PR_PATH}/threads/7/comments?api-version=7.1`);
  assert.deepEqual(r.sent[0].json, { parentCommentId: 1, content: "ok", commentType: 1 });
  await assert.rejects(azure.reply(AZ, azPr, {}, { id: 7, reply: null }, "x", r.io), /can't take replies/);
  assert.equal(r.sent.length, 1);
});

test("Azure detail: me from connectionData, reply from the thread's root comment", () => {
  const { threads } = mapThreads([{ id: 7, status: "active", threadContext: { filePath: "/a.js", rightFileStart: { line: 2 } },
    comments: [{ id: 3, parentCommentId: 0, author: { displayName: "Bo" }, content: "x", publishedDate: "2026-11-01", commentType: "text" },
      { id: 4, parentCommentId: 3, author: { displayName: "Cy" }, content: "y", publishedDate: "2026-11-02", commentType: "text" }] }]);
  assert.deepEqual(threads[0].reply, { threadId: 7, commentId: 3 });
  const pr = { sourceRefName: "refs/heads/f", pullRequestId: 5, repository: { id: "r1", name: "web", project: { name: "P" } }, createdBy: { id: "u-9" } };
  const d = azMapPrDetail(pr, { org: AZ.org, threads: [], files: [], moreFiles: 0, truncated: false, me: { id: "u-9", providerDisplayName: "Me" } });
  assert.deepEqual(d.me, { id: "u-9", name: "Me" });
  assert.equal(d.author.id, d.me.id); // the account's own PR
  assert.equal(azMapPrDetail(pr, { org: AZ.org, threads: [], files: [], moreFiles: 0, truncated: false }).me, null);
});

import { postPrReview, replyToPrThread } from "../mods/wayfindr/flow.js";

test("flow: postPrReview and replyToPrThread go through the capability", async () => {
  const got = [];
  const registry = {
    github: { capabilities: ["postReview", "reply"], postReview: async (...a) => { got.push(["review", ...a]); return { url: "u" }; }, reply: async (...a) => { got.push(["reply", ...a]); } },
    azure: { capabilities: ["prDetail"] },
  };
  const profile = { accounts: [{ id: "gh", provider: "github" }, { id: "az", provider: "azure" }] };
  assert.deepEqual(await postPrReview(profile, "gh", { key: "K" }, { id: "d" }, { event: "comment" }, "io", registry), { url: "u" });
  await replyToPrThread(profile, "gh", { key: "K" }, { id: "d" }, { id: "T" }, "hi", "io", registry);
  assert.deepEqual(got, [
    ["review", { id: "gh", provider: "github" }, { key: "K" }, { id: "d" }, { event: "comment" }, "io"],
    ["reply", { id: "gh", provider: "github" }, { key: "K" }, { id: "d" }, { id: "T" }, "hi", "io"],
  ]);
  await assert.rejects(postPrReview(profile, "az", {}, {}, {}, "io", registry), /Posting reviews on azure isn't supported/);
  await assert.rejects(replyToPrThread(profile, "az", {}, {}, {}, "x", "io", registry), /Replies on azure aren't supported/);
  await assert.rejects(postPrReview(profile, "nope", {}, {}, {}, "io", registry), /No account/);
});
