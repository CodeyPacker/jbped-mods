import { test } from "node:test";
import assert from "node:assert/strict";
import { clickup, mapColumns, mapTasks, mapTicket } from "../mods/wayfinder/providers/clickup.js";
import { moveTarget, byColumn } from "../mods/wayfinder/providers/contract.js";
import { parseConfig } from "../mods/wayfinder/config.js";
import { addAccount, showsBoard } from "../mods/wayfinder/settings.js";

const NOW = Date.parse("2026-11-10T00:00:00Z");
const LIST = { name: "Sprint", statuses: [{ status: "done", orderindex: 2, type: "closed" }, { status: "to do", orderindex: 0, type: "open" }, { status: "in progress", orderindex: 1, type: "custom" }] };
const TASKS = [
  { id: "a1", custom_id: "DEV-1", name: "One", url: "https://app.clickup.com/t/a1", status: { status: "in progress", type: "custom" }, assignees: [{ id: 7, username: "jo" }], priority: { id: "2" } },
  { id: "a2", name: "Old", status: { status: "done", type: "closed" }, date_closed: String(NOW - 60 * 86400000) },
  { id: "a3", name: "New done", parent: "a1", status: { status: "done", type: "closed" }, date_closed: String(NOW - 86400000) },
];

test("a List's statuses become Columns in order, and old closed tasks drop", () => {
  assert.deepEqual(mapColumns(LIST).map((c) => c.name), ["to do", "in progress", "done"]);
  const t = mapTasks(TASKS, NOW);
  assert.deepEqual(t.map((x) => x.id), ["DEV-1", "a3"]);
  assert.equal(t[0].priority, "P2"); assert.equal(t[1].type, "Subtask");
  assert.deepEqual(t[0].assignees, [{ id: "7", name: "jo" }]);
  const cols = byColumn({ columns: mapColumns(LIST), tickets: t });
  assert.deepEqual(cols.map((c) => c.tickets.length), [0, 1, 1]);
  // A ClickUp Column isn't mistaken for a Tracked Status, so Move finds it.
  assert.equal(moveTarget({ columns: mapColumns(LIST) }, {}, "cu:done").column.name, "done");
});

const api = (routes) => {
  const sent = [];
  return {
    sent,
    io: {
      run: async (cmd, args) => { sent.push({ run: [cmd, ...args] }); return { code: 0, stdout: "pk_tok\n", stderr: "" }; },
      fetch: async (url, opts) => {
        sent.push({ url, method: opts.method, auth: opts.headers.Authorization, body: opts.body && JSON.parse(opts.body) });
        const path = url.replace("https://api.clickup.com/api/v2/", "").split("?")[0];
        const hit = routes[path];
        return { ok: Boolean(hit), status: hit ? 200 : 404, text: async () => JSON.stringify(hit ?? { err: "nope" }) };
      },
    },
  };
};

test("board reads the List, the user and every page, with the token from the runner", async () => {
  const r = api({ "list/9": LIST, user: { user: { id: 7 } }, "list/9/task": { tasks: TASKS.slice(0, 1), last_page: true } });
  const b = await clickup.board({ provider: "clickup" }, { list: "9", team: "1" }, r.io);
  assert.equal(b.title, "Sprint"); assert.equal(b.me, "7"); assert.equal(b.tickets.length, 1);
  assert.equal(b.url, "https://app.clickup.com/1/v/li/9");
  assert.deepEqual(r.sent[0].run, ["bash", "-lc", 'printenv "$1"', "wayfinder-env", "CLICKUP_API_TOKEN"]);
  assert.ok(r.sent.filter((x) => x.url).every((x) => x.auth === "pk_tok"));
  await assert.rejects(clickup.board({}, { list: "../x" }, r.io), /isn't a ClickUp id/);
});

test("move, title and comment write the task", async () => {
  const r = api({ "task/a1": {}, "task/a1/comment": {} });
  await clickup.move({}, { id: "a1" }, { status: null, column: { name: "done" } }, {}, r.io);
  await clickup.update({}, { id: "a1" }, { title: " T " }, r.io);
  await clickup.comment({}, { id: "a1" }, "hi", r.io);
  const w = r.sent.filter((x) => x.url);
  assert.deepEqual(w.map((x) => [x.method, x.body]), [["PUT", { status: "done" }], ["PUT", { name: "T" }], ["POST", { comment_text: "hi", notify_all: false }]]);
});

test("config, settings and Board matching know ClickUp", () => {
  const ok = parseConfig(JSON.stringify({ profiles: { p: { accounts: [{ id: "cu", provider: "clickup" }], boards: [{ id: "b", account: "cu", ref: { list: "9" } }] } } }), "linux");
  assert.deepEqual(ok.errors, []);
  const bad = parseConfig(JSON.stringify({ profiles: { p: { accounts: [{ id: "cu", provider: "clickup", tokenEnv: "a b" }], boards: [{ id: "b", account: "cu", ref: {} }] } } }), "linux");
  assert.ok(bad.errors.some((e) => /tokenEnv/.test(e))); assert.ok(bad.errors.some((e) => /needs "list"/.test(e)));
  // A lower-case name or a pasted pk_ token is refused, and not repeated (F2).
  for (const v of ["clickup_token", "pk_81234567_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"]) {
    const e = parseConfig(JSON.stringify({ profiles: { p: { accounts: [{ id: "cu", provider: "clickup", tokenEnv: v }] } } }), "linux").errors;
    assert.ok(e.some((x) => /tokenEnv: must be an environment variable name in upper case/.test(x)), v);
    assert.ok(!e.join("\n").includes(v));
  }
  const raw = addAccount({ profiles: { p: { accounts: [] } } }, "p", { provider: "clickup" });
  assert.deepEqual(raw.profiles.p.accounts, [{ id: "cu", provider: "clickup" }]);
  assert.throws(() => addAccount(raw, "p", { provider: "clickup" }), /already/);
  assert.ok(showsBoard({ account: "cu", ref: { list: "9" } }, "cu", { ref: { list: "9", team: "1" } }));
});

const tokIo = (stdout, fetch) => ({
  run: async () => ({ code: 0, stdout, stderr: "" }),
  fetch: fetch ?? (async (_u, o) => ({ ok: true, status: 200, text: async () => JSON.stringify({ auth: o.headers.Authorization }) })),
});

test("the token is the last non-empty line, a value with spaces is refused, and fetch errors hide their text (F1)", async () => {
  const heads = [];
  await clickup.signInState({}, tokIo("motd\npk_x", async (_u, o) => { heads.push(o.headers.Authorization); return { ok: true, status: 200, text: async () => "{}" }; }));
  assert.deepEqual(heads, ["pk_x"]);
  const st = await clickup.signInState({}, tokIo("pk x"));
  assert.equal(st.ok, false); assert.ok(!/pk/.test(st.reason)); assert.match(st.reason, /CLICKUP_API_TOKEN holds spaces/);
  const boom = async () => { throw new Error('Headers.append: "motd\npk_SECRET" is an invalid header value.'); };
  await assert.rejects(clickup.move({}, { id: "a1" }, { status: "done" }, {}, tokIo("pk_SECRET", boom)), (e) => e.message === "The request to ClickUp failed before it was answered");
  await assert.rejects(clickup.board({ tokenEnv: "pk_SECRET" }, { list: "9" }, tokIo("x")), (e) => !/pk_SECRET/.test(e.message));
});

test("done tasks age out like closed ones, a full comment page says there are more, and links are filtered", () => {
  const old = String(NOW - 60 * 86400000);
  assert.deepEqual(mapTasks([{ id: "d", status: { status: "shipped", type: "done" }, date_closed: old }, { id: "o", status: { status: "x", type: "open" }, date_updated: old }], NOW).map((t) => t.key), ["o"]);
  const c = (n) => ({ comments: Array.from({ length: n }, (_, i) => ({ date: String(i), comment_text: "[x](file:///C:/x.exe)" })) });
  const t = { id: "a1", markdown_description: "[f](file:///C:/x.exe) [h](https://h)" };
  assert.equal(mapTicket(t, c(25), {}).moreComments, 1);
  assert.equal(mapTicket(t, c(24), {}).moreComments, 0);
  assert.equal(mapTicket(t, c(1), {}).comments[0].body, "x");
  assert.equal(mapTicket(t, c(0), {}).description, "f [h](https://h)");
});
