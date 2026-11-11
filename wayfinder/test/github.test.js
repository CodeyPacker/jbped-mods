import { test } from "node:test";
import assert from "node:assert/strict";
import { mapItems, mapColumns, github } from "../mods/wayfinder/providers/github.js";
import { byColumn, initials, NO_COLUMN, can } from "../mods/wayfinder/providers/contract.js";
import { loadBoard } from "../mods/wayfinder/flow.js";

const issue = (n, opt, extra = {}) => ({
  id: `item-${n}`, type: "ISSUE", isArchived: false,
  status: opt ? { optionId: opt, name: opt } : null,
  priority: extra.priority ? { name: extra.priority } : null,
  content: {
    __typename: extra.kind ?? "Issue", id: `c-${n}`, number: extra.kind === "DraftIssue" ? undefined : n, title: `T${n}`,
    url: extra.kind === "DraftIssue" ? undefined : `https://github.com/o/web/issues/${n}`,
    repository: extra.kind === "DraftIssue" ? undefined : { name: "web", nameWithOwner: "o/web" },
    assignees: { nodes: extra.assignees ?? [] },
  },
});

const field = { id: "F", name: "Status", options: [{ id: "todo", name: "Todo" }, { id: "doing", name: "Doing" }, { id: "done", name: "Done" }] };

test("items map to TicketSummaries", () => {
  const [t] = mapItems([issue(12, "doing", { priority: "P1", assignees: [{ login: "ann", name: "Ann Lee" }] })]);
  assert.deepEqual(t, {
    ref: { itemId: "item-12", contentId: "c-12", kind: "Issue", url: "https://github.com/o/web/issues/12" },
    key: "item-12", id: "web#12", title: "T12", type: "Issue", url: "https://github.com/o/web/issues/12",
    columnId: "doing", status: "doing", assignees: [{ id: "ann", name: "Ann Lee" }], priority: "P1",
  });
});

test("archived items and items without content are skipped; drafts have no number", () => {
  const items = mapItems([{ ...issue(1, "todo"), isArchived: true }, { ...issue(2, "todo"), content: null }, issue(3, null, { kind: "DraftIssue" })]);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "Draft");
  assert.equal(items[0].type, "Draft");
  assert.equal(items[0].columnId, NO_COLUMN);
});

test("Status options are Columns in order; No Status leads only when needed", () => {
  assert.deepEqual(mapColumns(field, mapItems([issue(1, "todo")])).map((c) => c.name), ["Todo", "Doing", "Done"]);
  assert.deepEqual(mapColumns(field, mapItems([issue(1, null)])).map((c) => c.name), ["No Status", "Todo", "Doing", "Done"]);
});

test("byColumn groups in Column order and filters Mine", () => {
  const tickets = mapItems([issue(1, "done"), issue(2, "todo", { assignees: [{ login: "me" }] }), issue(3, "todo")]);
  const board = { me: "me", columns: mapColumns(field, tickets), tickets };
  assert.deepEqual(byColumn(board).map((g) => g.tickets.map((t) => t.id)), [["web#2", "web#3"], [], ["web#1"]]);
  assert.deepEqual(byColumn(board, { mine: true }).map((g) => g.tickets.length), [1, 0, 0]);
});

test("initials", () => {
  assert.equal(initials("Ann Lee"), "AL");
  assert.equal(initials("jbped"), "JB");
  assert.equal(initials(""), "?");
});

function fakeIo(pages) {
  const calls = [];
  return {
    calls,
    run: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, stdout: "tok\n", stderr: "" }; },
    fetch: async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(`fetch after=${body.variables.after}`);
      assert.equal(opts.headers.Authorization, "bearer tok");
      return { status: 200, ok: true, text: async () => JSON.stringify(pages.shift()) };
    },
  };
}
const page = (nodes, next) => ({ data: { viewer: { login: "me" }, repositoryOwner: { projectV2: {
  title: "P", url: "u", field, items: { pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null }, nodes } } } } });

test("board pages through items and gets the token from gh for the account", async () => {
  const io = fakeIo([page([issue(1, "todo")], "c1"), page([issue(2, "done")])]);
  const b = await github.board({ login: "jbped" }, { owner: "o", number: 1 }, io);
  assert.equal(b.tickets.length, 2);
  assert.equal(b.me, "me");
  assert.ok(io.calls[0].startsWith("gh auth token --user jbped"));
  assert.ok(io.calls.includes("fetch after=c1"));
});

test("scope errors become a sign-in hint", async () => {
  const io = fakeIo([{ errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes" }] }]);
  await assert.rejects(github.board({ login: "x" }, { owner: "o", number: 1 }, io), /read:project/);
});

test("the flow picks the Provider by the account and checks capabilities", async () => {
  const profile = { accounts: [{ id: "a", provider: "fake" }, { id: "b", provider: "none" }] };
  const fake = { id: "fake", capabilities: ["board"], board: async (acc, ref) => ({ acc: acc.id, ref }) };
  assert.deepEqual(await loadBoard(profile, { id: "x", account: "a", ref: 1 }, {}, { fake }), { acc: "a", ref: 1 });
  await assert.rejects(loadBoard(profile, { id: "x", account: "b", ref: 1 }, {}, { fake }), /aren't supported/);
  await assert.rejects(loadBoard(profile, { id: "x", account: "zz", ref: 1 }, {}, { fake }), /isn't in this profile/);
  assert.ok(can(github, "board"));
});

test("issue bodies and comments lose non-http links (security F3)", async () => {
  const { mapTicket } = await import("../mods/wayfinder/providers/github.js");
  const t = mapTicket({ content: { __typename: "Issue", number: 1, title: "t", body: "[docs](ms-msdt:/id x) [ok](https://ok)",
    repository: { name: "r" }, comments: { totalCount: 1, nodes: [{ author: { login: "a" }, body: "<file:///C:/x.exe>" }] } } }, { itemId: "I" });
  assert.equal(t.description, "\\[docs](ms-msdt:/id x) [ok](https://ok)"); // not a link: its "[" is escaped
  assert.equal(t.comments[0].body, "file:///C:/x.exe");
});
