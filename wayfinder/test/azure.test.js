import { test } from "node:test";
import assert from "node:assert/strict";
import { azure, azArgs, azDir, loginCommand, validOrg, boardWiql, boardShape, mapWorkItems } from "../mods/wayfinder/providers/azure.js";
import { parseConfig } from "../mods/wayfinder/config.js";
import { signInStates } from "../mods/wayfinder/flow.js";
import { byColumn } from "../mods/wayfinder/providers/contract.js";

const ORG = "https://dev.azure.com/acme";
const COLUMN_FIELD = "WEF_ABC_Kanban.Column";
const BOARD = {
  name: "Stories",
  fields: { columnField: { referenceName: COLUMN_FIELD } },
  columns: [
    { name: "New", columnType: "incoming", stateMappings: { "User Story": "New", Bug: "New" } },
    { name: "Doing", columnType: "inProgress", stateMappings: { "User Story": "Active", Bug: "Active" } },
    { name: "Review", columnType: "inProgress", stateMappings: { "User Story": "Active", Bug: "Active" } },
    { name: "Closed", columnType: "outgoing", stateMappings: { "User Story": "Closed", Bug: "Closed" } },
  ],
};
const item = (id, f = {}) => ({ id, fields: { "System.Title": `T${id}`, "System.WorkItemType": "User Story", "System.State": "New", ...f } });

test("each Profile gets its own az config folder, passed as argv to a fixed script", () => {
  const work = azArgs("work", ["account", "show"]), home = azArgs("home", ["account", "show"]);
  assert.equal(work[1], home[1]); // the same script
  assert.equal(work[3], "work");
  assert.equal(home[3], "home");
  assert.deepEqual(work.slice(4), ["az", "account", "show"]);
  assert.match(work[1], /AZURE_CONFIG_DIR="\$d" AZURE_DEVOPS_EXT_CONFIG_DIR="\$d\/azuredevops" exec "\$@"/);
  assert.equal(azDir("../x y"), "___x_y");
  assert.equal(loginCommand("work"), "AZURE_CONFIG_DIR=~/.config/wayfinder/azure/work AZURE_DEVOPS_EXT_CONFIG_DIR=~/.config/wayfinder/azure/work/azuredevops az login --allow-no-subscriptions");
});

test("only Azure DevOps organization URLs are accepted", () => {
  for (const ok of ["https://dev.azure.com/acme", "https://dev.azure.com/acme/", "https://acme.visualstudio.com"]) assert.ok(validOrg(ok), ok);
  for (const bad of ["http://dev.azure.com/acme", "https://evil.com/dev.azure.com/acme", "https://dev.azure.com/acme/proj", "https://dev.azure.com.evil.com/x", ""]) assert.ok(!validOrg(bad), bad);
});

test("config: an Azure Board needs project and team", () => {
  const cfg = (ref, org = ORG) => JSON.stringify({ profiles: { w: { runner: "native", accounts: [{ id: "a", provider: "azure", org, projects: ["P"] }], boards: [{ id: "b", account: "a", ref }] } } });
  assert.deepEqual(parseConfig(cfg({ project: "P", team: "T" }), "linux").errors, []);
  assert.match(parseConfig(cfg({ project: "P" }), "linux").errors.join(), /"project" and "team"/);
  assert.match(parseConfig(cfg({ project: "P", team: "T" }, "https://example.com"), "linux").errors.join(), /organization URL/);
});

test("the board's shape: Columns in order, the types it shows, the done states", () => {
  assert.deepEqual(boardShape(BOARD), {
    columns: [{ id: "New", name: "New" }, { id: "Doing", name: "Doing" }, { id: "Review", name: "Review" }, { id: "Closed", name: "Closed" }],
    types: ["User Story", "Bug"], doneStates: ["Closed"], columnField: COLUMN_FIELD,
  });
});

test("WIQL quotes values and limits done items to recent ones", () => {
  const q = boardWiql({ types: ["User Story", "Bug"], teamField: "System.AreaPath", areas: [{ value: "P\\Team's", includeChildren: true }, { value: "P", includeChildren: false }], doneStates: ["Closed"], orderField: "Microsoft.VSTS.Common.StackRank" });
  assert.equal(q, "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('User Story', 'Bug') AND ([System.AreaPath] UNDER 'P\\Team''s' OR [System.AreaPath] = 'P') AND [System.State] <> 'Removed' AND ([System.State] NOT IN ('Closed') OR [System.ChangedDate] >= @Today - 30) ORDER BY [Microsoft.VSTS.Common.StackRank] ASC, [System.Id] ASC");
  assert.throws(() => boardWiql({ types: ["X"], teamField: "Bad]Field", areas: [{ value: "a" }], doneStates: [], orderField: null }), /Unexpected field/);
});

test("work items map to TicketSummaries in their team's Column", () => {
  const [a, b] = mapWorkItems([
    item(7, { [COLUMN_FIELD]: "Review", "System.State": "Active", "System.AssignedTo": { id: "u1", displayName: "Ann Lee" }, "Microsoft.VSTS.Common.Priority": 2 }),
    item(8, { "System.State": "Active" }), // not placed on this board yet: by state
  ], BOARD, { org: ORG, project: "My Proj" });
  assert.deepEqual(a, {
    ref: { id: 7, project: "My Proj" }, key: "7", id: "7", title: "T7", type: "User Story", url: `${ORG}/My%20Proj/_workitems/edit/7`,
    columnId: "Review", assignees: [{ id: "u1", name: "Ann Lee" }], priority: "P2",
  });
  assert.equal(b.columnId, "Doing");
  assert.deepEqual(b.assignees, []);
  assert.equal(b.priority, null);
});

// A fake runner and Azure DevOps: records calls, answers by URL.
function fakeIo(profile, routes, { tokenCode = 0 } = {}) {
  const calls = [];
  return {
    calls, profile,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (tokenCode) return { code: tokenCode, stdout: "", stderr: "ERROR: Please run 'az login' to setup account." };
      return { code: 0, stdout: args.includes("accessToken") ? "tok\n" : "2026-11-09 15:00:00\n", stderr: "" };
    },
    fetch: async (url, opts) => {
      calls.push(`${opts.method} ${url}`);
      assert.equal(opts.headers.Authorization, "Bearer tok");
      assert.ok(url.startsWith(`${ORG}/`) && /api-version=7\.1(-preview)?($|&)/.test(url), url);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) return { status: 404, ok: false, text: async () => JSON.stringify({ message: `no route ${url}` }) };
      const body = typeof hit[1] === "function" ? hit[1](JSON.parse(opts.body ?? "null")) : hit[1];
      return { status: 200, ok: true, text: async () => JSON.stringify(body) };
    },
  };
}

test("board rebuilds the team board: Columns in order, items in backlog order, Mine by identity", async () => {
  let wiql = null;
  const io = fakeIo("work", {
    "_apis/connectionData": { authenticatedUser: { id: "me-id" } },
    "_apis/work/boards/Stories": BOARD,
    "_apis/work/boards?": { value: [{ name: "Stories" }, { name: "Features" }] },
    "teamfieldvalues": { field: { referenceName: "System.AreaPath" }, values: [{ value: "P", includeChildren: true }] },
    "processconfiguration": { typeFields: { Order: { referenceName: "Microsoft.VSTS.Common.StackRank" } } },
    "_apis/wit/wiql": (b) => { wiql = b.query; return { workItems: [{ id: 3 }, { id: 1 }, { id: 2 }] }; },
    "workitemsbatch": (b) => ({ value: b.ids.slice().sort().map((id) => item(id, id === 1 ? { [COLUMN_FIELD]: "Closed", "System.State": "Closed", "System.AssignedTo": { id: "me-id", displayName: "Me" } } : {})) }),
  });
  const board = await azure.board({ org: ORG }, { project: "P", team: "T" }, io);
  assert.equal(board.title, "T · Stories");
  assert.equal(board.url, `${ORG}/P/_boards/board/t/T/Stories`);
  assert.equal(board.me, "me-id");
  assert.deepEqual(board.columns.map((c) => c.name), ["New", "Doing", "Review", "Closed"]);
  assert.deepEqual(board.tickets.map((t) => t.id), ["3", "1", "2"]);
  assert.deepEqual(byColumn(board).map((g) => g.tickets.map((t) => t.id)), [["3", "2"], [], [], ["1"]]);
  assert.deepEqual(byColumn(board, { mine: true }).map((g) => g.tickets.length), [0, 0, 0, 1]);
  assert.match(wiql, /\[System.AreaPath\] UNDER 'P'/);
  assert.match(wiql, /ORDER BY \[Microsoft.VSTS.Common.StackRank\]/);
  // a fresh token for the refresh, through this Profile's az folder (R3)
  const tokenCall = io.calls.find((c) => Array.isArray(c));
  assert.deepEqual(tokenCall.slice(0, 1), ["sh"]);
  assert.equal(tokenCall[4], "work");
  assert.ok(!io.calls.flat().some((c) => String(c).includes("tok") && !String(c).includes("token")), "the token is never on a command line");
});

test("sign-in states: ok, not signed in with this Profile's login command, az unreachable", async () => {
  assert.deepEqual(await azure.signInState({}, fakeIo("work", {})), { ok: true });
  assert.deepEqual(await azure.signInState({}, fakeIo("work", {}, { tokenCode: 1 })), { ok: false, reason: "Not signed in to Azure for this Profile", command: loginCommand("work") });
  assert.equal((await azure.signInState({}, fakeIo("work", {}, { tokenCode: 127 }))).command, null);
});

test("two Profiles' sign-in checks use different az folders", async () => {
  const profile = (name) => ({ name, accounts: [{ id: "ado", provider: "azure", org: ORG, projects: [] }], boards: [] });
  const work = fakeIo("work", {}), home = fakeIo("home", {});
  await signInStates(profile("work"), work);
  await signInStates(profile("home"), home);
  assert.equal(work.calls[0][4], "work");
  assert.equal(home.calls[0][4], "home");
});

test("a refused login tells how to sign in", async () => {
  const io = fakeIo("work", {});
  io.fetch = async () => ({ status: 401, ok: false, text: async () => "" });
  await assert.rejects(azure.board({ org: ORG }, { project: "P", team: "T", board: "Stories" }, io), /refused the login.*az login/);
});
