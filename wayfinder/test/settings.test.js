import { test } from "node:test";
import assert from "node:assert/strict";
import * as e from "../mods/wayfinder/settings.js";
import { parseConfig } from "../mods/wayfinder/config.js";
import { loadPullRequests } from "../mods/wayfinder/flow.js";

const raw = () => ({
  activeProfile: "work",
  profiles: {
    work: { accounts: [{ id: "gh", provider: "github", login: "ann" }, { id: "ado", provider: "azure", org: "https://dev.azure.com/acme", projects: ["P"] }],
      boards: [{ id: "team", account: "ado", ref: { project: "P", team: "T" } }] },
    home: { accounts: [], boards: [] },
  },
});
const valid = (r) => assert.deepEqual(parseConfig(JSON.stringify(r), "linux").errors, []);

test("follow and unfollow a discovered Board, with a unique id; the original is untouched", () => {
  const r0 = raw();
  const r1 = e.followBoard(r0, "work", "gh", { title: "Team · Board", ref: { owner: "o", number: 3 } });
  const r2 = e.followBoard(r1, "work", "gh", { title: "Team · Board", ref: { owner: "o", number: 4 } });
  assert.deepEqual(r2.profiles.work.boards.slice(1).map((b) => [b.id, b.name, b.ref.number]), [["team-board", "Team · Board", 3], ["team-board-2", "Team · Board", 4]]);
  assert.equal(r0.profiles.work.boards.length, 1);
  valid(r2);
  assert.deepEqual(e.unfollowBoard(r2, "work", "team-board").profiles.work.boards.map((b) => b.id), ["team", "team-board-2"]);
});

test("an Azure config without a board name shows the team's first board", () => {
  const cfg = raw().profiles.work.boards[0];
  const d = (board) => ({ ref: { project: "P", team: "T", board } });
  assert.equal(e.showsBoard(cfg, "ado", d("Stories"), true), true);
  assert.equal(e.showsBoard(cfg, "ado", d("Bugs"), false), false);
  assert.equal(e.showsBoard({ ...cfg, ref: { ...cfg.ref, board: "Bugs" } }, "ado", d("Bugs")), true);
  assert.equal(e.showsBoard({ account: "gh", ref: { owner: "o", number: 1 } }, "gh", { ref: { owner: "o", number: 1 } }), true);
});

test("Tracked Statuses tick, reorder, and clear to the Board's own Columns", () => {
  let list = e.toggleStatus([], "Active");
  list = e.toggleStatus(list, "New");
  assert.deepEqual(e.move(list, 1, -1), ["New", "Active"]);
  assert.deepEqual(e.move(list, 0, -1), list);
  const r = e.setTrackedStatuses(raw(), "work", "team", ["New", "Active"]);
  assert.deepEqual(r.profiles.work.boards[0].trackedStatuses, ["New", "Active"]);
  valid(r);
  assert.equal("trackedStatuses" in e.setTrackedStatuses(r, "work", "team", []).profiles.work.boards[0], false);
});

test("followed repos toggle, sorted; none left removes the field", () => {
  let r = e.toggleRepo(raw(), "work", "gh", "o/web");
  r = e.toggleRepo(r, "work", "gh", "o/api");
  assert.deepEqual(r.profiles.work.accounts[0].followedRepos, ["o/api", "o/web"]);
  valid(r);
  r = e.toggleRepo(e.toggleRepo(r, "work", "gh", "o/api"), "work", "gh", "o/web");
  assert.equal("followedRepos" in r.profiles.work.accounts[0], false);
  const rows = e.repoRows(["a/x", "b/y", "c/z"], ["b/y", "gone/q"], "z", 50);
  assert.deepEqual(rows, { rows: ["b/y", "gone/q", "c/z"], hidden: 0 });
  assert.equal(e.repoRows(["a/1", "a/2", "a/3"], [], "", 2).hidden, 1);
});

test("Profiles add and remove; the last stays; removing the active one picks another", () => {
  assert.throws(() => e.addProfile(raw(), "bad name"), /letters, digits/);
  assert.throws(() => e.addProfile(raw(), "work"), /already exists/);
  const r = e.addProfile(raw(), "client-x");
  assert.deepEqual(r.profiles["client-x"], { accounts: [], repos: [], boards: [] });
  valid(r);
  assert.equal(e.removeProfile(raw(), "work").activeProfile, "home");
  assert.throws(() => e.removeProfile({ profiles: { a: {} } }, "a"), /last profile/);
  const first = e.addProfile({}, "solo");
  assert.deepEqual(Object.keys(first.profiles), ["solo"]);
});

test("Accounts add with an id from their name, no duplicates, and removing one drops its Boards", () => {
  let r = e.addAccount(raw(), "home", { provider: "github", login: " Ann-Lee " });
  r = e.addAccount(r, "home", { provider: "azure", org: "https://dev.azure.com/Acme/" });
  assert.deepEqual(r.profiles.home.accounts, [
    { id: "gh-ann-lee", provider: "github", login: "Ann-Lee" },
    { id: "ado-acme", provider: "azure", org: "https://dev.azure.com/Acme", projects: [] },
  ]);
  valid(r);
  assert.throws(() => e.addAccount(r, "home", { provider: "github", login: "ann-lee" }), /already in this profile/);
  assert.throws(() => e.addAccount(r, "home", { provider: "github", login: "" }), /user name/);
  const gone = e.removeAccount(raw(), "work", "ado").profiles.work;
  assert.deepEqual([gone.accounts.map((a) => a.id), gone.boards], [["gh"], []]);
});

test("followed repos filter an Account's PRs; none followed shows all", async () => {
  const pr = (repo) => ({ repo });
  const registry = { x: { capabilities: ["pullRequests"], pullRequests: async () => ({ me: "m", mine: [pr("o/a"), pr("o/b")], needsReview: [pr("o/b")], more: { mine: 0, needsReview: 0 } }) } };
  const [f, all] = await loadPullRequests({ accounts: [{ id: "1", provider: "x", followedRepos: ["o/b"] }, { id: "2", provider: "x" }] }, {}, registry);
  assert.deepEqual([f.mine, f.needsReview], [[pr("o/b")], [pr("o/b")]]);
  assert.equal(all.mine.length, 2);
});
