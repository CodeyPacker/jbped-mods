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

test("PR repos: All, Selected or Ignored, each mode with its own list", () => {
  assert.throws(() => e.toggleRepo(raw(), "work", "gh", "o/web"), /Selected or Ignored first/);
  let r = e.setRepoMode(raw(), "work", "gh", "selected");
  r = e.toggleRepo(r, "work", "gh", "o/web");
  r = e.toggleRepo(r, "work", "gh", "o/api");
  assert.deepEqual(r.profiles.work.accounts[0].prRepos, { mode: "selected", selected: ["o/api", "o/web"] });
  valid(r);
  r = e.toggleRepo(e.setRepoMode(r, "work", "gh", "ignored"), "work", "gh", "o/bot");
  assert.deepEqual(r.profiles.work.accounts[0].prRepos, { mode: "ignored", selected: ["o/api", "o/web"], ignored: ["o/bot"] });
  valid(r);
  r = e.setRepoMode(r, "work", "gh", "all");
  assert.equal(r.profiles.work.accounts[0].prRepos.mode, "all"); // lists kept for later
  r = e.toggleRepo(e.toggleRepo(e.toggleRepo(e.setRepoMode(r, "work", "gh", "selected"), "work", "gh", "o/api"), "work", "gh", "o/web"), "work", "gh", "o/web");
  r = e.toggleRepo(e.setRepoMode(r, "work", "gh", "ignored"), "work", "gh", "o/bot");
  assert.equal("prRepos" in e.setRepoMode(e.toggleRepo(e.setRepoMode(r, "work", "gh", "selected"), "work", "gh", "o/web"), "work", "gh", "all").profiles.work.accounts[0], false);
  assert.throws(() => e.setRepoMode(raw(), "work", "gh", "some"), /Unknown repo mode/);
  const rows = e.repoRows(["a/x", "b/y", "c/z"], ["b/y", "gone/q"], "z", 50);
  assert.deepEqual(rows, { rows: ["b/y", "gone/q", "c/z"], hidden: 0 });
  assert.equal(e.repoRows(["a/1", "a/2", "a/3"], [], "", 2).hidden, 1);
  assert.ok(parseConfig(JSON.stringify({ profiles: { p: { accounts: [{ id: "a", provider: "github", login: "x", prRepos: { mode: "some" } }] } } }), "linux").errors.some((x) => /prRepos/.test(x)));
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

test("the repo filter keeps an Account's PRs: all, only selected, all but ignored", async () => {
  const pr = (repo) => ({ repo });
  const registry = { x: { capabilities: ["pullRequests"], pullRequests: async () => ({ me: "m", mine: [pr("o/a"), pr("o/b")], needsReview: [pr("o/b")], more: { mine: 0, needsReview: 0 } }) } };
  const [sel, ign, all, none] = await loadPullRequests({ accounts: [
    { id: "1", provider: "x", prRepos: { mode: "selected", selected: ["o/b"], ignored: ["o/a"] } },
    { id: "2", provider: "x", prRepos: { mode: "ignored", selected: ["o/b"], ignored: ["o/b"] } },
    { id: "3", provider: "x", prRepos: { mode: "all", ignored: ["o/b"] } },
    { id: "4", provider: "x", prRepos: { mode: "selected" } },
  ] }, {}, registry);
  assert.deepEqual([sel.mine, sel.needsReview], [[pr("o/b")], [pr("o/b")]]);
  assert.deepEqual([ign.mine, ign.needsReview], [[pr("o/a")], []]);
  assert.equal(all.mine.length, 2);
  assert.deepEqual([none.mine, none.needsReview], [[], []]);
});
