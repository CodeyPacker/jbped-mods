import { test } from "node:test";
import assert from "node:assert/strict";
import { mapTicket, linkedPullRequests, github } from "../mods/wayfinder/providers/github.js";
import { loadTicket } from "../mods/wayfinder/flow.js";

const pr = (n, extra = {}) => ({ number: n, title: `PR${n}`, url: `https://github.com/o/web/pull/${n}`, state: "OPEN", isDraft: false, repository: { name: "web" }, ...extra });
const ref = { itemId: "item-1", contentId: "c-1", kind: "Issue", url: "u", statusField: "Status", priorityField: "Priority" };

const issueData = {
  item: { status: { name: "Doing" }, priority: { name: "P1" } },
  content: {
    __typename: "Issue", number: 7, title: "Fix it", url: "https://github.com/o/web/issues/7", body: "## Steps\n1. a",
    repository: { name: "web" }, issueType: { name: "Bug" },
    labels: { nodes: [{ name: "bug" }, { name: "ui" }] },
    assignees: { nodes: [{ login: "ann", name: "" }] },
    parent: { number: 2, title: "Epic", url: "https://github.com/o/web/issues/2", repository: { name: "web" } },
    comments: { totalCount: 3, nodes: [{ author: null, body: "hi", createdAt: "2026-01-02T00:00:00Z", url: "c1" }, { author: { login: "bob" }, body: "ok", createdAt: "2026-01-03T00:00:00Z", url: "c2" }] },
    closedByPullRequestsReferences: { nodes: [pr(9)] },
    timelineItems: { nodes: [
      { __typename: "CrossReferencedEvent", source: pr(9) },
      { __typename: "ConnectedEvent", subject: pr(10, { state: "MERGED" }) },
      { __typename: "CrossReferencedEvent", source: {} },
      { __typename: "CrossReferencedEvent", source: pr(11, { isDraft: true }) },
    ] },
  },
};

test("an Issue maps to every D11 field", () => {
  const t = mapTicket(issueData, ref);
  assert.equal(t.id, "web#7");
  assert.equal(t.type, "Bug");
  assert.equal(t.column, "Doing");
  assert.equal(t.priority, "P1");
  assert.deepEqual(t.assignees, [{ id: "ann", name: "ann" }]);
  assert.deepEqual(t.tags, ["bug", "ui"]);
  assert.deepEqual(t.parent, { id: "web#2", title: "Epic", url: "https://github.com/o/web/issues/2" });
  assert.equal(t.description, "## Steps\n1. a");
  assert.equal(t.acceptanceCriteria, null);
  assert.deepEqual(t.comments.map((c) => c.author), ["ghost", "bob"]);
  assert.equal(t.moreComments, 1);
  assert.equal(t.url, "https://github.com/o/web/issues/7");
});

test("linked PRs: closing references first, then the timeline, without duplicates or non-PRs", () => {
  assert.deepEqual(linkedPullRequests(issueData.content).map((p) => [p.id, p.state, p.draft]),
    [["web#9", "open", false], ["web#10", "merged", false], ["web#11", "open", true]]);
});

test("drafts and PRs: no number, no linked PRs, type from kind", () => {
  const d = mapTicket({ item: null, content: { __typename: "DraftIssue", title: "Idea", body: null, assignees: { nodes: [] } } }, ref);
  assert.equal(d.id, "Draft");
  assert.equal(d.type, "Draft");
  assert.equal(d.description, "");
  assert.equal(d.column, null);
  assert.deepEqual(d.pullRequests, []);
  const p = mapTicket({ item: null, content: { __typename: "PullRequest", ...pr(4), body: "x", labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0, nodes: [] } } }, ref);
  assert.equal(p.type, "Pull request");
  assert.deepEqual(p.pullRequests, []);
});

test("a missing item is an error fit to show", () => {
  assert.throws(() => mapTicket({ item: null, content: null }, ref), /gone/);
});

test("ticket() queries with the ref's ids and field names", async () => {
  let vars;
  const io = {
    run: async () => ({ code: 0, stdout: "tok", stderr: "" }),
    fetch: async (_u, o) => { vars = JSON.parse(o.body).variables; return { status: 200, ok: true, text: async () => JSON.stringify({ data: issueData }) }; },
  };
  const t = await github.ticket({ login: "ann" }, { ...ref, statusField: "Stage" }, io);
  assert.deepEqual(vars, { item: "item-1", content: "c-1", status: "Stage", priority: "Priority" });
  assert.equal(t.title, "Fix it");
});

test("the flow checks the ticket capability", async () => {
  const profile = { accounts: [{ id: "a", provider: "fake" }, { id: "b", provider: "board-only" }] };
  const reg = { fake: { capabilities: ["ticket"], ticket: async (_a, r) => ({ r }) }, "board-only": { capabilities: ["board"] } };
  assert.deepEqual(await loadTicket(profile, { id: "x", account: "a" }, { ref: 5 }, {}, reg), { r: 5 });
  await assert.rejects(loadTicket(profile, { id: "x", account: "b" }, { ref: 5 }, {}, reg), /aren't supported/);
});
