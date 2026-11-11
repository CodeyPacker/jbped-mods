import { test } from "node:test";
import assert from "node:assert/strict";
import { moveTarget } from "../mods/wayfinder/providers/contract.js";
import { azure, moveOps } from "../mods/wayfinder/providers/azure.js";
import { github } from "../mods/wayfinder/providers/github.js";

const azData = { columns: [
  { id: "New", name: "New", states: { Bug: "New", "User Story": "New" } },
  { id: "Active", name: "Active", states: { Bug: "Active", "User Story": "Active" } },
] };

test("moveTarget: a Provider Column or a Tracked Status", () => {
  assert.deepEqual(moveTarget(azData, {}, "Active"), { status: null, column: azData.columns[1] });
  const t = moveTarget(azData, { trackedStatuses: ["Blocked", "Active"] }, "status:blocked");
  assert.deepEqual(t, { status: "Blocked", column: null });
  assert.equal(moveTarget(azData, { trackedStatuses: ["Active"] }, "status:active").column, azData.columns[1]);
  assert.throws(() => moveTarget(azData, {}, "Nope"), /isn't on this Board/);
});

test("Azure Move patches the state, and the board's Column field for a Provider Column", () => {
  const ref = { id: 7, columnField: "WEF_X_Kanban.Column" };
  assert.deepEqual(moveOps(ref, { status: null, column: azData.columns[1] }, "Bug"), [
    { op: "add", path: "/fields/System.State", value: "Active" },
    { op: "add", path: "/fields/WEF_X_Kanban.Column", value: "Active" },
  ]);
  assert.deepEqual(moveOps(ref, { status: "Blocked", column: null }, "Bug"), [{ op: "add", path: "/fields/System.State", value: "Blocked" }]);
  assert.throws(() => moveOps(ref, { status: null, column: azData.columns[1] }, "Epic"), /no state for a Epic/);
  // A Tracked Status wins over the same-named Column's mapping, and the Column field isn't written.
  const col = { id: "Active", name: "Active", states: { Task: "In Progress" } };
  assert.deepEqual(moveOps(ref, { status: "Active", column: col }, "Task"), [{ op: "add", path: "/fields/System.State", value: "Active" }]);
});

test("Azure Move sends one JSON Patch with a fresh token", async () => {
  const sent = [];
  const io = {
    profile: "work",
    run: async () => ({ code: 0, stdout: "tok\n", stderr: "" }),
    fetch: async (url, opts) => { sent.push({ url, ...opts }); return { ok: true, status: 200, text: async () => "{}" }; },
  };
  await azure.move({ org: "https://dev.azure.com/o" }, { id: 7, columnField: null }, { status: "Blocked", column: null }, { type: "Bug" }, io);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "PATCH");
  assert.match(sent[0].url, /^https:\/\/dev\.azure\.com\/o\/_apis\/wit\/workitems\/7\?api-version=/);
  assert.equal(sent[0].headers["Content-Type"], "application/json-patch+json");
  assert.equal(sent[0].headers.Authorization, "Bearer tok");
});

test("GitHub Move sets the Status option, and a missing scope says how to add it", async () => {
  let body = null, answer = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "i" } } } };
  const io = {
    run: async () => ({ code: 0, stdout: "tok\n", stderr: "" }),
    fetch: async (_u, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => JSON.stringify(answer) }; },
  };
  const ref = { itemId: "I", projectId: "P", fieldId: "F" };
  await github.move({ login: "me" }, ref, { status: null, column: { id: "opt2", name: "Done" } }, {}, io);
  assert.match(body.query, /updateProjectV2ItemFieldValue/);
  assert.deepEqual(body.variables, { project: "P", item: "I", field: "F", option: "opt2" });
  answer = { errors: [{ type: "INSUFFICIENT_SCOPES", message: "Your token has not been granted the required scopes" }] };
  await assert.rejects(github.move({ login: "me" }, ref, { status: null, column: { id: "opt2", name: "Done" } }, {}, io), /-s project/);
  await assert.rejects(github.move({ login: "me" }, { itemId: "I" }, { status: null, column: { id: "o", name: "x" } }, {}, io), /Refresh the Board/);
});
