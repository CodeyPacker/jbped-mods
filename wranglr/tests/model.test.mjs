import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyState, mkey, clonedMap, arrange, act, ticketOf, branchWords, workspaceHome,
} from "../mods/wranglr/model.js";

const TICKET = "^(?:[a-z]+/)?#?(\\d{2,})";
const LOCAL = { home: "/home/me", windows: false };
const BOTH = [{ name: null, layout: "ready" }, { name: "wsl", layout: "ready" }];

function deepFreeze(x) {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

function config({ settings = {}, workspaces = [], repos = {} } = {}) {
  return {
    settings: { sort: "kind", plus: "open", worktrees: "{clone}/.worktrees/{branch}", autoname: false, ticket: TICKET, agent: null, ...settings },
    workspaces, repos,
  };
}

function space(id, o = {}) {
  return { id, index: 1, name: id, named: false, folder: "", machine: null, branch: null, active: false, status: null, tabs: [], ...o };
}

function repo(identity, root, main = root) {
  return { identity, name: identity.split("/").pop(), root, main };
}

function world(spaces, o = {}) {
  return { spaces, machines: BOTH, repos: {}, titles: {}, focus: null, local: LOCAL, ...o };
}

function run(action, w, c, s = emptyState()) {
  return act(action, deepFreeze(w), deepFreeze(c), deepFreeze(s));
}

// Sync then arrange, as the view does on every world change.
function view(w, c, s = emptyState()) {
  const r = run({ type: "sync" }, w, c, s);
  return { state: r.state, effects: r.effects, tree: arrange(w, c, r.state) };
}

function group(tree, id) {
  return tree.groups.find((g) => g.id === id);
}

function rowIds(tree, id, sub) {
  const g = group(tree, id);
  if (!g) return undefined;
  return (sub ? g.subgroups.find((s) => s.id === sub).rows : g.rows).map((r) => r.id);
}

const looseIds = (tree) => tree.loose.map((r) => r.id);
const groupIds = (tree) => tree.groups.map((g) => g.id);

const FRONT = "github.com/org/frontend";
const BACK = "github.com/org/backend";
const ARDEN = {
  name: "Arden", repos: [FRONT, BACK], machines: [],
  on: { "": { paths: { [FRONT]: "/home/me/dev/arden/frontend", [BACK]: "/home/me/dev/arden/backend" } } },
};

// Helpers

test("ticketOf and branchWords on typical branches", () => {
  const cases = [
    ["46382-arabic-layout-deviation-in-linux", "46382", ["Arabic", "layout", "deviation", "in", "linux"]],
    ["feature/46382-fix-login", "46382", ["Fix", "login"]],
    ["12-add-palette", "12", ["Add", "palette"]],
    ["fix/login-timeout", null, ["Login", "timeout"]],
    ["main", null, ["Main"]],
    ["ABC-123-rename-thing", null, ["Abc", "123", "rename", "thing"]],
  ];
  for (const [branch, ticket, words] of cases) {
    assert.equal(ticketOf(branch, null, TICKET), ticket, branch);
    assert.deepEqual(branchWords(branch, ticketOf(branch, null, TICKET)), words, branch);
  }
});

test("ticketOf prefers an existing id prefix of the name", () => {
  assert.equal(ticketOf("feature/999-x", "46382 Fix login", TICKET), "46382");
  assert.equal(ticketOf("x", "#12 Palette", TICKET), "#12");
  assert.equal(ticketOf("x", "ABC-123 Rename thing", TICKET), "ABC-123");
  assert.equal(ticketOf("feature/999-x", "frontend", TICKET), "999");
  assert.equal(ticketOf(null, "frontend", TICKET), null);
  assert.deepEqual(branchWords("ABC-123-rename-thing", "ABC-123"), ["Rename", "thing"]);
});

test("mkey, emptyState and clonedMap", () => {
  assert.equal(mkey(null), "");
  assert.equal(mkey("wsl"), "wsl");
  const s = emptyState();
  assert.deepEqual(Object.keys(s).sort(), ["active", "closing", "custom", "dismissed", "folded", "names", "naming", "open", "order", "pending", "pinned", "place", "seen", "snap", "started", "subs", "titles", "v"].sort());
  const state = { ...s, seen: { [FRONT]: { name: "frontend", on: { "": "/old/frontend", wsl: "/w/frontend" } } } };
  const c = config({ workspaces: [ARDEN], repos: { [BACK]: { machines: [], on: { wsl: { path: "/w/backend" } } } } });
  assert.deepEqual(clonedMap(c, state), {
    "": { [FRONT]: "/home/me/dev/arden/frontend", [BACK]: "/home/me/dev/arden/backend" },
    wsl: { [FRONT]: "/w/frontend", [BACK]: "/w/backend" },
  });
});

test("workspaceHome: declared, common parent, and the parents that are refused", () => {
  const ws = (paths, home) => ({ name: "W", repos: Object.keys(paths), machines: [], on: home ? { "": { home } } : {} });
  const cl = (paths, mk = "") => ({ [mk]: paths });
  assert.equal(workspaceHome(ws({ a: "/x/a" }, "/decl"), "", {}, LOCAL), "/decl");
  assert.equal(workspaceHome(ws({ a: 1, b: 1 }), "", cl({ a: "/srv/dev/w/a", b: "/srv/dev/w/b/" }), LOCAL), "/srv/dev/w");
  assert.equal(workspaceHome(ws({ a: 1, b: 1 }), "", cl({ a: "/home/me/a", b: "/home/me/b" }), LOCAL), null);
  assert.equal(workspaceHome(ws({ a: 1, b: 1 }), "", cl({ a: "/mnt/c/a", b: "/mnt/c/b" }), LOCAL), null);
  assert.equal(workspaceHome(ws({ a: 1, b: 1 }), "", cl({ a: "/a", b: "/b" }), LOCAL), null);
  assert.equal(workspaceHome(ws({ a: 1, b: 1 }), "", cl({ a: "C:\\a", b: "C:\\b" }), { home: "C:\\Users\\me", windows: true }), null);
  assert.equal(workspaceHome(ws({ a: 1, b: 1 }), "", cl({ a: "C:\\Users\\me\\a", b: "c:/users/me/b" }), { home: "C:\\Users\\me", windows: true }), null);
  assert.equal(workspaceHome(ws({ a: 1, b: 1 }), "", cl({ a: "C:\\dev\\w\\a", b: "C:\\dev\\w\\b" }), { home: "C:\\Users\\me", windows: true }), "C:\\dev\\w");
  assert.equal(workspaceHome(ws({ a: 1, b: 1 }), "wsl", cl({ a: "/home/jo/a", b: "/home/jo/b" }, "wsl"), LOCAL), null);
  assert.equal(workspaceHome(ws({ a: 1 }), "", cl({ a: "/srv/a" }), LOCAL), null, "one Repo has no common parent");
  assert.equal(workspaceHome(ws({ a: 1, b: 1 }), "", cl({ a: "/srv/w/a" }), LOCAL), null, "every Repo must be known");
});

// Membership

test("the same Repo on two Machines at different paths gives one Repo group", () => {
  const w = world([space("s1", { folder: "/home/me/dev/front" }), space("wsl/s2", { machine: "wsl", folder: "/srv/front" })], {
    repos: { s1: repo(FRONT, "/home/me/dev/front"), "wsl/s2": repo(FRONT, "/srv/front") },
  });
  const { tree } = view(w, config());
  assert.deepEqual(groupIds(tree), ["repo:" + FRONT]);
  const g = group(tree, "repo:" + FRONT);
  assert.equal(g.name, "frontend");
  assert.deepEqual(g.rows.map((r) => [r.id, r.machine]), [["s1", null], ["wsl/s2", "wsl"]]);
});

test("a space in a worktree of a Repo joins that Repo group", () => {
  const w = world([space("s1"), space("s2")], {
    repos: { s1: repo(FRONT, "/d/front"), s2: repo(FRONT, "/d/front/.worktrees/x", "/d/front") },
  });
  assert.deepEqual(rowIds(view(w, config()).tree, "repo:" + FRONT), ["s1", "s2"]);
});

test("a space in one Repo of a Workspace goes to the Repo group", () => {
  const w = world([space("s1", { folder: "/home/me/dev/arden/frontend" })], { repos: { s1: repo(FRONT, "/home/me/dev/arden/frontend") } });
  const { tree } = view(w, config({ workspaces: [ARDEN] }));
  assert.deepEqual(rowIds(tree, "repo:" + FRONT), ["s1"]);
  assert.deepEqual(rowIds(tree, "ws:Arden"), []);
});

test("a space at the common-parent Workspace home joins the Workspace group", () => {
  const w = world([space("s1", { folder: "/home/me/dev/arden/" })], { repos: { s1: null } });
  const { tree } = view(w, config({ workspaces: [ARDEN] }));
  assert.deepEqual(rowIds(tree, "ws:Arden"), ["s1"]);
});

test("a space at a declared Workspace home joins the Workspace group, on another Machine too", () => {
  const ws = { name: "Ops", repos: [FRONT], machines: [], on: { wsl: { home: "/srv/ops" } } };
  const w = world([space("wsl/s1", { machine: "wsl", folder: "/srv/ops" }), space("s2", { folder: "/srv/ops" })], { repos: { "wsl/s1": null, s2: null } });
  const { tree } = view(w, config({ workspaces: [ws] }));
  assert.deepEqual(rowIds(tree, "ws:Ops"), ["wsl/s1"]);
  assert.deepEqual(looseIds(tree), ["s2"]);
});

test("Windows paths on this computer match the home ignoring case and slashes", () => {
  const ws = { name: "Win", repos: [FRONT, BACK], machines: [], on: { "": { paths: { [FRONT]: "C:\\dev\\w\\front", [BACK]: "C:\\dev\\w\\back" } } } };
  const w = world([space("s1", { folder: "c:/DEV/w/" })], { repos: { s1: null }, local: { home: "C:\\Users\\me", windows: true } });
  assert.deepEqual(rowIds(view(w, config({ workspaces: [ws] })).tree, "ws:Win"), ["s1"]);
});

test("no common-parent home when the Repos share only the home directory, a drive or /mnt/c", () => {
  for (const base of ["/home/me", "/mnt/c"]) {
    const ws = { name: "W", repos: [FRONT, BACK], machines: [], on: { "": { paths: { [FRONT]: base + "/front", [BACK]: base + "/back" } } } };
    const w = world([space("s1", { folder: base })], { repos: { s1: null } });
    const { tree } = view(w, config({ workspaces: [ws] }));
    assert.deepEqual(rowIds(tree, "ws:W"), [], base);
    assert.equal(group(tree, "ws:W").can.plus, false);
  }
});

test("a space whose Repo is not resolved yet stays where its snapshot put it", () => {
  const c = config();
  const first = view(world([space("s1")], { repos: { s1: repo(FRONT, "/d/f") } }), c);
  const later = view(world([space("s1")], { repos: {} }), c, first.state);
  assert.deepEqual(rowIds(later.tree, "repo:" + FRONT), ["s1"]);
  assert.deepEqual(looseIds(view(world([space("s9")]), c).tree), ["s9"]);
});

// Starting from a Group

test("a space started from a Workspace group joins it and stays when its folder moves", () => {
  const c = config({ workspaces: [ARDEN] });
  const w0 = world([space("s1")], { repos: { s1: null } });
  const s0 = view(w0, c).state;
  const plus = run({ type: "plus", group: "ws:Arden", sub: null, mode: null }, w0, c, s0);
  assert.deepEqual(plus.effects, [{ type: "start", machine: null, folder: "/home/me/dev/arden", argv: null, name: "Arden", worktree: null }]);
  const w1 = world([space("s1"), space("s2", { folder: "/home/me/dev/arden" })], { repos: { s1: null, s2: null } });
  const s1 = view(w1, c, plus.state).state;
  assert.equal(s1.started.s2, "Arden");
  assert.deepEqual(s1.pending, []);
  const w2 = world([space("s1"), space("s2", { folder: "/home/me/dev/arden/frontend" })], { repos: { s1: null, s2: repo(FRONT, "/home/me/dev/arden/frontend") } });
  assert.deepEqual(rowIds(view(w2, c, s1).tree, "ws:Arden"), ["s2"]);
});

test("a space started from a Subgroup lands in that Subgroup", () => {
  const c = config();
  const w0 = world([space("s1")], { repos: { s1: repo(FRONT, "/d/front") } });
  let s = view(w0, c).state;
  s = run({ type: "addSub", group: "repo:" + FRONT, name: "Review" }, w0, c, s).state;
  const plus = run({ type: "plus", group: "repo:" + FRONT, sub: "review", mode: "open" }, w0, c, s);
  assert.equal(plus.state.pending.length, 1);
  const w1 = world([space("s1"), space("s2", { folder: "/d/front" })], { repos: { s1: repo(FRONT, "/d/front"), s2: repo(FRONT, "/d/front") } });
  const { tree } = view(w1, c, plus.state);
  assert.deepEqual(rowIds(tree, "repo:" + FRONT), ["s1"]);
  assert.deepEqual(rowIds(tree, "repo:" + FRONT, "review"), ["s2"]);
});

test("a space started from a Repo group shows there before git answers, and leaves if git says otherwise", () => {
  const c = config();
  const w0 = world([space("s1")], { repos: { s1: repo(FRONT, "/d/front") } });
  const plus = run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: "open" }, w0, c, view(w0, c).state);
  const w1 = world([space("s1"), space("s2", { folder: "/d/front" })], { repos: { s1: repo(FRONT, "/d/front") } });
  const first = view(w1, c, plus.state);
  assert.deepEqual(rowIds(first.tree, "repo:" + FRONT).sort(), ["s1", "s2"]);
  assert.deepEqual(first.tree.loose, []);
  const w2 = world([space("s1"), space("s2", { folder: "/d/front" })], { repos: { s1: repo(FRONT, "/d/front"), s2: null } });
  const later = view(w2, c, first.state);
  assert.deepEqual(rowIds(later.tree, "repo:" + FRONT), ["s1"]);
  assert.deepEqual(later.tree.loose.map((r) => r.id), ["s2"]);
});

test("a pending entry ignores spaces that existed before and expires after 20 world changes", () => {
  const c = config();
  const w0 = world([space("c1")]);
  let s = run({ type: "addCustom", name: "Scratch" }, w0, c, view(w0, c).state).state;
  s = run({ type: "plus", group: "custom:scratch", sub: null, mode: null }, w0, c, s).state;
  for (let i = 0; i < 19; i++) s = view(w0, c, s).state;
  assert.equal(s.pending.length, 1);
  s = view(w0, c, s).state;
  assert.equal(s.pending.length, 0);
});

test("a space started from a Custom group lands in it, matched at this computer's home", () => {
  const c = config({ settings: { agent: ["claude"] } });
  const w0 = world([]);
  let s = run({ type: "addCustom", name: "Scratch" }, w0, c).state;
  const plus = run({ type: "plus", group: "custom:scratch", sub: null, mode: null }, w0, c, s);
  assert.deepEqual(plus.effects, [{ type: "start", machine: null, folder: "", argv: ["claude"], name: null, worktree: null }]);
  const { tree } = view(world([space("s1", { folder: "/home/me" })]), c, plus.state);
  assert.deepEqual(rowIds(tree, "custom:scratch"), ["s1"]);
});

// Manual placement

test("manual placement beats every automatic rule and survives further syncs", () => {
  const c = config({ workspaces: [ARDEN] });
  const w = world([space("s1", { folder: "/home/me/dev/arden" })], { repos: { s1: repo(FRONT, "/home/me/dev/arden/frontend") } });
  let s = view(w, c).state;
  s = run({ type: "addCustom", name: "Mine" }, w, c, s).state;
  s = run({ type: "move", space: "s1", group: "custom:mine", sub: null }, w, c, s).state;
  for (let i = 0; i < 3; i++) s = view(w, c, s).state;
  const { tree } = view(w, c, s);
  assert.deepEqual(rowIds(tree, "custom:mine"), ["s1"]);
  assert.deepEqual(rowIds(tree, "ws:Arden"), []);
});

test("placing a space loose keeps it loose", () => {
  const c = config();
  const w = world([space("s1")], { repos: { s1: repo(FRONT, "/d/f") } });
  let s = run({ type: "move", space: "s1", group: "", sub: null }, w, c, view(w, c).state).state;
  s = view(w, c, s).state;
  const { tree } = view(w, c, s);
  assert.deepEqual(looseIds(tree), ["s1"]);
  assert.deepEqual(rowIds(tree, "repo:" + FRONT), []);
});

test("a move to a Group or Subgroup that does not exist is ignored", () => {
  const c = config();
  const w = world([space("s1")]);
  const s = view(w, c).state;
  assert.equal(run({ type: "move", space: "s1", group: "custom:nope", sub: null }, w, c, s).state, s);
  assert.equal(run({ type: "drop", space: "s1", group: "", sub: "x", before: null }, w, c, s).state, s);
});

// Groups shown

test("Workspace groups always show and a Repo group stays empty, then goes when dismissed", () => {
  const c = config({ workspaces: [ARDEN] });
  const w0 = world([space("s1")], { repos: { s1: repo(FRONT, "/d/f") } });
  const s0 = view(w0, c).state;
  const w1 = world([]);
  const { state: s1, tree: t1 } = view(w1, c, s0);
  assert.deepEqual(groupIds(t1), ["ws:Arden", "repo:" + FRONT]);
  assert.equal(group(t1, "repo:" + FRONT).can.dismiss, true);
  assert.equal(group(t1, "ws:Arden").can.dismiss, false);
  const s2 = run({ type: "dismiss", group: "repo:" + FRONT }, w1, c, s1).state;
  assert.deepEqual(groupIds(arrange(w1, c, s2)), ["ws:Arden"]);
});

test("a dismissed Repo group returns with its Subgroups when a space opens in the Repo", () => {
  const c = config();
  const w0 = world([space("s1")], { repos: { s1: repo(FRONT, "/d/f") } });
  let s = view(w0, c).state;
  s = run({ type: "addSub", group: "repo:" + FRONT, name: "Working" }, w0, c, s).state;
  s = view(world([]), c, s).state;
  s = run({ type: "dismiss", group: "repo:" + FRONT }, world([]), c, s).state;
  assert.deepEqual(s.dismissed, [FRONT]);
  const { state, tree } = view(world([space("s2")], { repos: { s2: repo(FRONT, "/d/f") } }), c, s);
  assert.deepEqual(state.dismissed, []);
  assert.deepEqual(group(tree, "repo:" + FRONT).subgroups.map((x) => x.id), ["working"]);
});

test("a Repo group with a space cannot be dismissed", () => {
  const c = config();
  const w = world([space("s1")], { repos: { s1: repo(FRONT, "/d/f") } });
  const s = view(w, c).state;
  assert.equal(run({ type: "dismiss", group: "repo:" + FRONT }, w, c, s).state, s);
});

test("two Repo groups with the same name show the last two segments", () => {
  const w = world([space("s1"), space("s2")], { repos: { s1: repo("github.com/a/app", "/a"), s2: repo("github.com/b/app", "/b") } });
  assert.deepEqual(view(w, config()).tree.groups.map((g) => g.name), ["a/app", "b/app"]);
});

// Sorts

function sortScene() {
  const ws = { name: "Zeta", repos: [FRONT, BACK], machines: [], on: { "": { home: "/ws/zeta" } } };
  const tab = (t) => [{ id: "t", index: 1, name: "1", named: false, active: true, status: null, panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: t, working_since: null }];
  const w = world([
    space("r1", { name: "beta", tabs: tab(10) }),
    space("r2", { name: "Alpha", tabs: tab(30) }),
    space("w1", { name: "gamma", folder: "/ws/zeta", tabs: tab(20) }),
    space("l1", { name: "zed", tabs: tab(50) }),
    space("l2", { name: "Ant", tabs: tab(5) }),
  ], { repos: { r1: repo(FRONT, "/f"), r2: repo(FRONT, "/f"), w1: null, l1: null, l2: null } });
  let s = emptyState();
  const c = config({ workspaces: [ws] });
  s = run({ type: "addCustom", name: "Aaa" }, w, c, s).state;
  return { w, ws, s };
}

test("sort kind: Workspace, Repo, Custom groups each A to Z, rows A to Z, loose last", () => {
  const { w, ws, s } = sortScene();
  const { tree } = view(w, config({ workspaces: [ws] }), s);
  assert.deepEqual(groupIds(tree), ["ws:Zeta", "repo:" + FRONT, "custom:aaa"]);
  assert.deepEqual(rowIds(tree, "repo:" + FRONT), ["r2", "r1"]);
  assert.deepEqual(looseIds(tree), ["l2", "l1"]);
  assert.deepEqual(tree.order, ["w1", "r2", "r1", "l2", "l1"]);
});

test("sort az: Groups A to Z regardless of kind", () => {
  const { w, ws, s } = sortScene();
  const { tree } = view(w, config({ workspaces: [ws], settings: { sort: "az" } }), s);
  assert.deepEqual(groupIds(tree), ["custom:aaa", "repo:" + FRONT, "ws:Zeta"]);
  assert.deepEqual(rowIds(tree, "repo:" + FRONT), ["r2", "r1"]);
  assert.deepEqual(looseIds(tree), ["l2", "l1"]);
});

test("sort recent: Groups and rows newest first, empty Groups last, loose last", () => {
  const { w, ws, s } = sortScene();
  const { tree } = view(w, config({ workspaces: [ws], settings: { sort: "recent" } }), s);
  assert.deepEqual(groupIds(tree), ["repo:" + FRONT, "ws:Zeta", "custom:aaa"]);
  assert.deepEqual(rowIds(tree, "repo:" + FRONT), ["r2", "r1"]);
  assert.deepEqual(looseIds(tree), ["l1", "l2"]);
  assert.deepEqual(tree.order.slice(-2), ["l1", "l2"]);
});

test("sort manual: stored order first, the rest in kind order and Herdr's order", () => {
  const { w, ws, s } = sortScene();
  const c = config({ workspaces: [ws], settings: { sort: "manual" } });
  const order = { groups: ["custom:aaa"], spaces: { ["repo:" + FRONT]: ["r2"], "": [] } };
  const { tree } = view(w, c, { ...s, order });
  assert.deepEqual(groupIds(tree), ["custom:aaa", "ws:Zeta", "repo:" + FRONT]);
  assert.deepEqual(rowIds(tree, "repo:" + FRONT), ["r2", "r1"]);
  assert.deepEqual(looseIds(tree), ["l1", "l2"]);
});

test("drop orders spaces from different Machines freely inside one Group", () => {
  const c = config({ settings: { sort: "manual" } });
  const w = world([space("a"), space("wsl/b", { machine: "wsl" }), space("c")], {
    repos: { a: repo(FRONT, "/f"), "wsl/b": repo(FRONT, "/srv/f"), c: repo(FRONT, "/f") },
  });
  let s = view(w, c).state;
  assert.deepEqual(rowIds(arrange(w, c, s), "repo:" + FRONT), ["a", "wsl/b", "c"]);
  s = run({ type: "drop", space: "c", group: "repo:" + FRONT, sub: null, before: "a" }, w, c, s).state;
  s = run({ type: "drop", space: "a", group: "repo:" + FRONT, sub: null, before: "wsl/b" }, w, c, s).state;
  assert.deepEqual(rowIds(view(w, c, s).tree, "repo:" + FRONT), ["c", "a", "wsl/b"]);
  assert.deepEqual(s.place.c, { group: "repo:" + FRONT, sub: null });
});

test("dropGroup sets the manual order of Groups", () => {
  const c = config({ workspaces: [ARDEN], settings: { sort: "manual" } });
  const w = world([space("s1")], { repos: { s1: repo(FRONT, "/f") } });
  let s = view(w, c).state;
  s = run({ type: "dropGroup", group: "repo:" + FRONT, before: "ws:Arden" }, w, c, s).state;
  assert.deepEqual(groupIds(arrange(w, c, s)), ["repo:" + FRONT, "ws:Arden"]);
});

// Selection

test("select, next and prev follow the order shown, wrap, and skip dim rows", () => {
  const c = config();
  const w0 = world([space("a", { name: "a" }), space("wsl/b", { machine: "wsl", name: "b" }), space("c", { name: "c" })]);
  const s = view(w0, c).state;
  const w = world(w0.spaces.filter((x) => x.id !== "wsl/b"), { machines: [{ name: null, layout: "ready" }, { name: "wsl", layout: "unavailable" }], focus: "c" });
  const { tree } = view(w, c, s);
  assert.deepEqual(looseIds(tree), ["a", "wsl/b", "c"]);
  assert.deepEqual(tree.order, ["a", "c"]);
  assert.deepEqual(run({ type: "select", index: 2 }, w, c, s).effects, [{ type: "select", id: "c" }]);
  assert.deepEqual(run({ type: "select", index: 3 }, w, c, s).effects, []);
  assert.deepEqual(run({ type: "next" }, w, c, s).effects, [{ type: "select", id: "a" }]);
  assert.deepEqual(run({ type: "prev" }, w, c, s).effects, [{ type: "select", id: "a" }]);
  assert.deepEqual(run({ type: "prev" }, { ...w, focus: "a" }, c, s).effects, [{ type: "select", id: "c" }]);
});

// Machines

test("an unavailable Machine keeps its spaces in their Groups, dimmed, and forgets nothing", () => {
  const c = config();
  const w0 = world([space("wsl/s1", { machine: "wsl", name: "one" })], { repos: { "wsl/s1": repo(FRONT, "/srv/f") } });
  let s = view(w0, c).state;
  s = run({ type: "addCustom", name: "Box" }, w0, c, s).state;
  s = run({ type: "move", space: "wsl/s1", group: "custom:box", sub: null }, w0, c, s).state;
  const down = world([], { machines: [{ name: null, layout: "ready" }, { name: "wsl", layout: "unavailable" }] });
  const after = view(down, c, s);
  assert.deepEqual(after.state.place, s.place);
  assert.deepEqual(group(after.tree, "custom:box").rows, [{ id: "wsl/s1", space: null, name: "one", machine: "wsl", dim: true }]);
  const missing = view(world([], { machines: [{ name: null, layout: "ready" }] }), c, s);
  assert.deepEqual(rowIds(missing.tree, "custom:box"), ["wsl/s1"], "a Machine not listed is not ready");
  const back = view(world([]), c, after.state);
  assert.deepEqual(back.state.place, {});
  assert.deepEqual(back.state.snap, {});
  assert.deepEqual(rowIds(back.tree, "custom:box"), []);
});

// Plus

const MULTI = { [FRONT]: { machines: ["wsl", ""], on: { wsl: { path: "/srv/front" }, "": { path: "/home/me/front" } } } };

test("plus on a Repo group opens the main root on the first ready Machine of its priority list", () => {
  const c = config({ repos: MULTI });
  const w = world([], { repos: {} });
  const s = { ...emptyState(), seen: { [FRONT]: { name: "frontend", on: {} } } };
  const r = run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: null }, w, c, s);
  assert.deepEqual(r.effects, [{ type: "start", machine: "wsl", folder: "/srv/front", argv: null, name: null, worktree: null }]);
  assert.equal(r.state.pending.length, 1, "remembered, so the new space shows in the Group before git answers");
  assert.deepEqual(arrange(w, c, s).groups[0].machines, ["wsl", ""]);
  const wslDown = world([], { machines: [{ name: null, layout: "ready" }, { name: "wsl", layout: "loading" }] });
  assert.equal(run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: null }, wslDown, c, s).effects[0].machine, null);
});

test("plus on a Repo group falls back to this computer, and an explicit Machine wins", () => {
  const c = config({ repos: { [FRONT]: { machines: [], on: { wsl: { path: "/srv/front" }, "": { path: "/home/me/front" } } } } });
  const s = { ...emptyState(), seen: { [FRONT]: { name: "frontend", on: {} } } };
  const w = world([]);
  assert.equal(run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: null }, w, c, s).effects[0].machine, null);
  assert.equal(run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: null, machine: "wsl" }, w, c, s).effects[0].folder, "/srv/front");
});

test("plus warns when the Repo is cloned on no reachable Machine", () => {
  const c = config({ repos: { [FRONT]: { machines: ["wsl"], on: { wsl: { path: "/srv/front" } } } } });
  const s = { ...emptyState(), seen: { [FRONT]: { name: "frontend", on: {} } } };
  const w = world([], { machines: [{ name: null, layout: "ready" }, { name: "wsl", layout: "unavailable" }] });
  const r = run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: null }, w, c, s);
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].type, "toast");
  assert.equal(r.effects[0].level, "warning");
  assert.equal(group(arrange(w, c, s), "repo:" + FRONT).can.plus, false);
});

test("plus in worktree mode starts in a new worktree under the Repo, and needs a branch", () => {
  const c = config({ repos: MULTI, settings: { plus: "worktree" } });
  const s = { ...emptyState(), seen: { [FRONT]: { name: "frontend", on: {} } } };
  const w = world([]);
  const r = run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: null, machine: null, branch: "feature/46382-x" }, w, c, s);
  assert.deepEqual(r.effects, [{
    type: "start", machine: null, folder: "/home/me/front/.worktrees/feature/46382-x", argv: null, name: null,
    worktree: { main: "/home/me/front", branch: "feature/46382-x", path: "/home/me/front/.worktrees/feature/46382-x", from: null },
  }]);
  const abs = config({ repos: MULTI, settings: { worktrees: "/wt/{branch}" } });
  assert.equal(run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: "worktree", machine: null, branch: "b" }, w, abs, s).effects[0].folder, "/wt/b");
  assert.equal(run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: "worktree", machine: null }, w, c, s).effects[0].type, "toast");
});

test("a worktree goes where the Repo says, else the setting, and carries the Repo's from ref", () => {
  const s = { ...emptyState(), seen: { [FRONT]: { name: "frontend", on: { "": "/d/front" } }, [BACK]: { name: "backend", on: { "": "/d/back" } } } };
  const w = world([]);
  const start = (c, id) => run({ type: "plus", group: "repo:" + id, sub: null, mode: "worktree", machine: null, branch: "b" }, w, c, s).effects[0];
  const c = config({
    workspaces: [{ name: "Arden", repos: [FRONT, BACK], machines: [], on: { "": { home: "/d" } }, worktrees: "/ignored/{branch}" }],
    repos: { [FRONT]: { machines: [], on: {}, worktrees: "{clone}/../wt/{branch}/{repo}", from: "origin/staging" } },
  });
  assert.deepEqual(start(c, FRONT).worktree, { main: "/d/front", branch: "b", path: "/d/wt/b/frontend", from: "origin/staging" }, "{clone} is the main root and .. is resolved");
  assert.deepEqual(start(c, BACK).worktree, { main: "/d/back", branch: "b", path: "/d/back/.worktrees/b", from: null }, "a Workspace does not set a Repo's worktrees");
});

test("{clone} expands to the Repo's clone on each Machine, so one pattern works on all of them", () => {
  const c = config({ repos: { [FRONT]: { machines: [], on: { wsl: { path: "/mnt/c/dev/arden/front" }, "": { path: "C:/dev/arden/front" } }, worktrees: "{clone}/../.worktrees/{branch}/{repo}" } } });
  const s = { ...emptyState(), seen: { [FRONT]: { name: "frontend", on: {} } } };
  const w = world([], { local: { home: "C:\\Users\\me", windows: true } });
  const at = (machine) => run({ type: "plus", group: "repo:" + FRONT, sub: null, mode: "worktree", machine, branch: "foo" }, w, c, s).effects[0].folder;
  assert.equal(at("wsl"), "/mnt/c/dev/arden/.worktrees/foo/frontend");
  assert.equal(at(null), "C:/dev/arden/.worktrees/foo/frontend");
});

test("plus on a Workspace passes Repos outside the home to Claude as added directories", () => {
  const ws = { name: "Mix", repos: [FRONT, BACK], machines: ["wsl"], on: { wsl: { home: "/srv/mix", paths: { [FRONT]: "/srv/mix/front", [BACK]: "/opt/back" } } } };
  const c = config({ workspaces: [ws], settings: { agent: ["/usr/bin/claude", "--x"] } });
  const r = run({ type: "plus", group: "ws:Mix", sub: null, mode: null }, world([]), c);
  assert.deepEqual(r.effects, [{
    type: "start", machine: "wsl", folder: "/srv/mix", name: "Mix", worktree: null,
    argv: ["env", "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1", "/usr/bin/claude", "--x", "--add-dir", "/opt/back"],
  }]);
  assert.deepEqual(r.state.pending.map((p) => [p.group, p.workspace, p.machine, p.folder]), [["ws:Mix", "Mix", "wsl", "/srv/mix"]]);
});

test("plus on a Workspace on this Windows computer passes added directories with no env prefix", () => {
  const ws = { name: "Win", repos: [FRONT, BACK], machines: [], on: { "": { home: "C:\\w", paths: { [FRONT]: "C:\\w\\front", [BACK]: "D:\\back" } } } };
  const c = config({ workspaces: [ws], settings: { agent: ["claude.exe"] } });
  const w = world([], { local: { home: "C:\\Users\\me", windows: true } });
  assert.deepEqual(run({ type: "plus", group: "ws:Win", sub: null, mode: null }, w, c).effects[0].argv, ["claude.exe", "--add-dir", "D:\\back"]);
  const other = config({ workspaces: [ws], settings: { agent: ["codex"] } });
  assert.deepEqual(run({ type: "plus", group: "ws:Win", sub: null, mode: null }, w, other).effects[0].argv, ["codex"]);
});

test("plus on a Workspace in worktree mode, or with no home anywhere, warns", () => {
  const c = config({ workspaces: [ARDEN] });
  const wt = run({ type: "plus", group: "ws:Arden", sub: null, mode: "worktree" }, world([]), c);
  assert.deepEqual(wt.effects, [{ type: "toast", level: "warning", title: "Wranglr", body: "A Workspace has no single Repo to make a worktree in." }]);
  const lone = { name: "Lone", repos: [FRONT], machines: [], on: {} };
  const r = run({ type: "plus", group: "ws:Lone", sub: null, mode: null }, world([]), config({ workspaces: [lone] }));
  assert.equal(r.effects[0].type, "toast");
  assert.deepEqual(r.state.pending, []);
});

// Naming

const named = (o) => config({ settings: { autoname: true, ...o } });

test("a short branch gets an immediate rename to the ticket and its words", () => {
  const w = world([space("s1", { branch: "feature/46382-fix-login" })]);
  const { state, effects } = view(w, named());
  assert.deepEqual(effects, [{ type: "rename", id: "s1", name: "46382 Fix login" }]);
  assert.equal(state.names.s1, "46382 Fix login");
  assert.equal(state.naming.s1, "done");
  const w2 = world([space("s1", { branch: "feature/46382-fix-login", name: "46382 Fix login", named: true })]);
  assert.deepEqual(view(w2, named(), state).effects, []);
});

test("a long branch waits, asks once on the first title, and the answer renames it", () => {
  const c = named();
  const b = "46382-arabic-layout-deviation-in-linux";
  let r = view(world([space("s1", { branch: b })]), c);
  assert.deepEqual(r.effects, []);
  assert.equal(r.state.naming.s1, "wait");
  r = view(world([space("s1", { branch: b })], { titles: { s1: "Fix Arabic layout" } }), c, r.state);
  assert.deepEqual(r.effects, [{ type: "ask", space: "s1", ticket: "46382", branch: b, title: "Fix Arabic layout" }]);
  r = view(world([space("s1", { branch: b })], { titles: { s1: "Another title" } }), c, r.state);
  assert.deepEqual(r.effects, [], "a second title never asks again");
  assert.equal(r.state.titles.s1, "Fix Arabic layout");
  const done = run({ type: "named", space: "s1", words: " Arabic layout  fix \n" }, world([space("s1", { branch: b })]), c, r.state);
  assert.deepEqual(done.effects, [{ type: "rename", id: "s1", name: "46382 Arabic layout fix" }]);
  assert.equal(done.state.naming.s1, "done");
});

test("named with five words or null does not rename", () => {
  const c = named();
  const w = world([space("s1", { branch: "46382-a-b-c-d-e" })], { titles: { s1: "t" } });
  const asked = view(w, c).state;
  assert.equal(asked.naming.s1, "asked");
  for (const words of ["one two three four five", null, "  "]) {
    const r = run({ type: "named", space: "s1", words }, w, c, asked);
    assert.deepEqual(r.effects, []);
    assert.equal(r.state.naming.s1, "done");
  }
});

test("a space the user named is never renamed", () => {
  const w = world([space("s1", { branch: "feature/46382-fix-login", name: "my work", named: true })]);
  const { state, effects } = view(w, named());
  assert.deepEqual(effects, []);
  assert.equal(state.naming.s1, "done");
});

test("main and similar branches are not named until the branch changes", () => {
  const c = named();
  let r = view(world([space("s1", { branch: "main" })]), c);
  assert.deepEqual(r.effects, []);
  assert.equal(r.state.naming.s1, undefined);
  r = view(world([space("s1", { branch: "12-add-palette" })]), c, r.state);
  assert.deepEqual(r.effects, [{ type: "rename", id: "s1", name: "12 Add palette" }]);
});

test("name (redo) keeps an existing ticket prefix and asks for a long branch", () => {
  const c = named();
  const w = world([space("s1", { name: "46382 Old name", named: true, branch: "fix/login-timeout" })]);
  assert.deepEqual(run({ type: "name", space: "s1" }, w, c).effects, [{ type: "rename", id: "s1", name: "46382 Login timeout" }]);
  const long = world([space("s1", { name: "46382 Old", named: true, branch: "a-b-c-d-e-f" })]);
  const s = { ...emptyState(), titles: { s1: "first" } };
  const r = run({ type: "name", space: "s1" }, long, c, s);
  assert.deepEqual(r.effects, [{ type: "ask", space: "s1", ticket: "46382", branch: "a-b-c-d-e-f", title: "first" }]);
  assert.equal(r.state.naming.s1, "asked");
});

test("autoname off emits nothing", () => {
  const w = world([space("s1", { branch: "feature/46382-fix-login" })], { titles: { s1: "x" } });
  const { effects, state } = view(w, config());
  assert.deepEqual(effects, []);
  assert.deepEqual(state.naming, {});
});

// Folding, sort and Custom groups

test("fold toggles a Group or Subgroup, and foldFocused folds the focused space's Group", () => {
  const c = config();
  const w = world([space("s1")], { repos: { s1: repo(FRONT, "/f") }, focus: "s1" });
  let s = view(w, c).state;
  s = run({ type: "addSub", group: "repo:" + FRONT, name: "Review" }, w, c, s).state;
  s = run({ type: "fold", group: "repo:" + FRONT, sub: "review" }, w, c, s).state;
  assert.equal(group(arrange(w, c, s), "repo:" + FRONT).subgroups[0].folded, true);
  s = run({ type: "foldFocused" }, w, c, s).state;
  const t = arrange(w, c, s);
  assert.equal(group(t, "repo:" + FRONT).folded, true);
  assert.deepEqual(t.order, ["s1"], "folded Groups stay in the order");
  s = run({ type: "fold", group: "repo:" + FRONT, sub: null }, w, c, s).state;
  assert.equal(group(arrange(w, c, s), "repo:" + FRONT).folded, false);
});

test("sort cycles recent, kind, az, manual and writes the setting", () => {
  const w = world([]);
  assert.deepEqual(run({ type: "sort", value: null }, w, config()).effects, [{ type: "setting", key: "sort", value: "az" }]);
  assert.deepEqual(run({ type: "sort", value: null }, w, config({ settings: { sort: "manual" } })).effects, [{ type: "setting", key: "sort", value: "recent" }]);
  assert.deepEqual(run({ type: "sort", value: "recent" }, w, config()).effects, [{ type: "setting", key: "sort", value: "recent" }]);
});

test("settings writes each given setting and ignores unknown keys", () => {
  const w = world([]);
  assert.deepEqual(run({ type: "settings", values: { plus: "worktree", autoname: true, agent: null, machine: "wsl", nope: 1 } }, w, config()).effects, [
    { type: "settings", values: { plus: "worktree", autoname: true, agent: null, machine: "wsl" } },
  ]);
  assert.deepEqual(run({ type: "settings" }, w, config()).effects, []);
  assert.deepEqual(run({ type: "settings", values: { nope: 1 } }, w, config()).effects, []);
  assert.deepEqual(run({ type: "settings", values: "sort" }, w, config()).effects, []);
});

// The default Machine and a Group's own settings

const SEEN = { ...emptyState(), seen: { [FRONT]: { name: "frontend", on: {} } } };
const ON_BOTH = { wsl: { path: "/srv/front" }, "": { path: "/home/me/front" } };
const plusOn = (id) => ({ type: "plus", group: id, sub: null, mode: null });

test("the default Machine is where + starts when the Group has no list of its own", () => {
  const c = config({ settings: { machine: "wsl" }, repos: { [FRONT]: { machines: [], on: ON_BOTH } } });
  const w = world([]);
  assert.deepEqual(arrange(w, c, SEEN).groups[0].machines, ["wsl", ""]);
  assert.equal(run(plusOn("repo:" + FRONT), w, c, SEEN).effects[0].folder, "/srv/front");
  const own = config({ settings: { machine: "wsl" }, repos: { [FRONT]: { machines: [""], on: ON_BOTH } } });
  assert.deepEqual(arrange(w, own, SEEN).groups[0].machines, ["", "wsl"], "the Group's own list comes first");
});

test("a default Machine that is away, unknown or not usable falls back to this computer", () => {
  const repos = { [FRONT]: { machines: [], on: ON_BOTH } };
  const away = world([], { machines: [{ name: null, layout: "ready" }, { name: "wsl", layout: "unavailable" }] });
  assert.equal(run(plusOn("repo:" + FRONT), away, config({ settings: { machine: "wsl" }, repos }), SEEN).effects[0].machine, null);
  assert.equal(run(plusOn("repo:" + FRONT), world([]), config({ settings: { machine: "gone" }, repos }), SEEN).effects[0].machine, null);
  const notThere = config({ settings: { machine: "wsl" }, repos: { [FRONT]: { machines: [], on: { "": { path: "/home/me/front" } } } } });
  assert.equal(run(plusOn("repo:" + FRONT), world([]), notThere, SEEN).effects[0].folder, "/home/me/front");
  for (const machine of [null, undefined, 7, ["wsl"]])
    assert.equal(run(plusOn("repo:" + FRONT), world([]), config({ settings: { machine }, repos }), SEEN).effects[0].machine, null);
});

test("a Custom group starts on its own Machines, else the default Machine, else this computer", () => {
  const w = world([]);
  let s = run({ type: "addCustom", name: "Box" }, w, config()).state;
  assert.deepEqual(group(arrange(w, config(), s), "custom:box").machines, ["", "wsl"]);
  assert.equal(run(plusOn("custom:box"), w, config(), s).effects[0].machine, null);
  assert.equal(run(plusOn("custom:box"), w, config({ settings: { machine: "wsl" } }), s).effects[0].machine, "wsl");
  s = run({ type: "groupSettings", group: "custom:box", values: { machines: ["wsl", "wsl", 3, ""] } }, w, config(), s).state;
  assert.deepEqual(s.custom, [{ id: "box", name: "Box", machines: ["wsl", ""] }]);
  const start = run(plusOn("custom:box"), w, config(), s);
  assert.deepEqual(start.effects, [{ type: "start", machine: "wsl", folder: "", argv: null, name: null, worktree: null }]);
  assert.equal(start.state.pending[0].machine, "wsl");
  const away = world([], { machines: [{ name: null, layout: "ready" }, { name: "wsl", layout: "loading" }] });
  assert.equal(run(plusOn("custom:box"), away, config(), s).effects[0].machine, null);
  assert.equal(run({ ...plusOn("custom:box"), machine: null }, w, config(), s).effects[0].machine, null, "an explicit Machine wins");
});

test("groupSettings sends a Workspace's and a Repo's settings to the config file", () => {
  const c = config({ workspaces: [ARDEN] });
  const w = world([]);
  const ws = run({ type: "groupSettings", group: "ws:Arden", values: { machines: ["wsl"] } }, w, c);
  assert.deepEqual(ws.effects, [{ type: "group", kind: "workspace", key: "Arden", values: { machines: ["wsl"] } }]);
  const rp = run({ type: "groupSettings", group: "repo:" + FRONT, values: { from: "origin/dev" } }, w, c);
  assert.deepEqual(rp.effects, [{ type: "group", kind: "repo", key: FRONT, values: { from: "origin/dev" } }]);
});

test("groupSettings does nothing for a Group that is not there or values that are not settings", () => {
  const c = config({ workspaces: [ARDEN] });
  const w = world([]);
  const s = emptyState();
  for (const a of [
    { group: "ws:Nope", values: { machines: [] } }, { group: "custom:nope", values: { machines: [] } },
    { group: "repo:", values: { from: "x" } }, { group: "", values: { machines: [] } }, { group: null, values: { machines: [] } },
    { group: "ws:Arden", values: {} }, { group: "ws:Arden", values: null }, { group: "ws:Arden", values: ["x"] }, { group: "ws:Arden" },
  ]) {
    const r = run({ type: "groupSettings", ...a }, w, c, s);
    assert.deepEqual(r.effects, [], JSON.stringify(a));
    assert.equal(r.state, s, JSON.stringify(a));
  }
});

test("Custom groups get readable ids, and removing one frees its spaces", () => {
  const c = config();
  const w = world([space("s1")], { repos: { s1: repo(FRONT, "/f") } });
  let s = view(w, c).state;
  s = run({ type: "addCustom", name: "My Stuff" }, w, c, s).state;
  s = run({ type: "addCustom", name: "my stuff" }, w, c, s).state;
  assert.deepEqual(s.custom, [{ id: "my-stuff", name: "My Stuff" }, { id: "my-stuff-2", name: "my stuff" }]);
  s = run({ type: "renameGroup", group: "custom:my-stuff-2", name: "Other" }, w, c, s).state;
  assert.equal(s.custom[1].name, "Other");
  s = run({ type: "move", space: "s1", group: "custom:my-stuff", sub: null }, w, c, s).state;
  s = run({ type: "removeCustom", group: "custom:my-stuff" }, w, c, s).state;
  const t = arrange(w, c, s);
  assert.deepEqual(groupIds(t), ["repo:" + FRONT, "custom:my-stuff-2"]);
  assert.deepEqual(rowIds(t, "repo:" + FRONT), ["s1"]);
});

test("removing a Subgroup keeps its spaces in the Group", () => {
  const c = config();
  const w = world([space("s1")]);
  let s = run({ type: "addCustom", name: "Box" }, w, c).state;
  s = run({ type: "addSub", group: "custom:box", name: "Review" }, w, c, s).state;
  s = run({ type: "renameSub", group: "custom:box", sub: "review", name: "Reviewing" }, w, c, s).state;
  s = run({ type: "move", space: "s1", group: "custom:box", sub: "review" }, w, c, s).state;
  assert.deepEqual(rowIds(arrange(w, c, s), "custom:box", "review"), ["s1"]);
  assert.equal(group(arrange(w, c, s), "custom:box").subgroups[0].name, "Reviewing");
  s = run({ type: "removeSub", group: "custom:box", sub: "review" }, w, c, s).state;
  const t = arrange(w, c, s);
  assert.deepEqual(group(t, "custom:box").subgroups, []);
  assert.deepEqual(rowIds(t, "custom:box"), ["s1"]);
});

// Purity

test("act never mutates frozen inputs and returns the identical state when nothing changed", () => {
  const c = config({ workspaces: [ARDEN] });
  const w = world([space("s1")], { repos: { s1: repo(FRONT, "/f") }, focus: "s1" });
  const s = view(w, c).state;
  for (const a of [{ type: "sync" }, { type: "next" }, { type: "select", index: 1 }, { type: "sort", value: null }, { type: "unknown" }])
    assert.equal(run(a, w, c, s).state, s, a.type);
  const moved = run({ type: "move", space: "s1", group: "", sub: null }, w, c, s);
  assert.notEqual(moved.state, s);
  assert.equal(s.place.s1, undefined);
});

// Pins, tabs and closing a Group

const HM = repo("github.com/o/hm", "/r/hm");
function pinWorld(extra = {}) {
  return world([space("a", { folder: "/r/hm" }), space("b", { folder: "/r/hm" }), space("c")], { repos: { a: HM, b: HM, c: null }, ...extra });
}

test("a pinned space leaves its Group for the pinned list and returns on unpin", () => {
  const w = pinWorld(), c = config();
  let r = view(w, c);
  assert.deepEqual(r.tree.pinned, []);
  r = run({ type: "pin", space: "b" }, w, c, r.state);
  let tree = arrange(w, c, r.state);
  assert.deepEqual(tree.pinned.map((x) => x.id), ["b"]);
  assert.deepEqual(rowIds(tree, "repo:github.com/o/hm"), ["a"]);
  assert.deepEqual(tree.order, ["b", "a", "c"]);
  r = run({ type: "pin", space: "c" }, w, c, r.state);
  tree = arrange(w, c, r.state);
  assert.deepEqual(tree.pinned.map((x) => x.id), ["b", "c"]);
  assert.deepEqual(looseIds(tree), []);
  r = run({ type: "pin", space: "b" }, w, c, r.state);
  tree = arrange(w, c, r.state);
  assert.deepEqual(tree.pinned.map((x) => x.id), ["c"]);
  assert.deepEqual(rowIds(tree, "repo:github.com/o/hm"), ["a", "b"]);
});

test("pin with `on` sets it, an unknown space is ignored, and a Group whose only space is pinned stays", () => {
  const w = world([space("a", { folder: "/r/hm" })], { repos: { a: HM } }), c = config();
  let r = view(w, c);
  assert.equal(run({ type: "pin", space: "zz" }, w, c, r.state).state, r.state);
  r = run({ type: "pin", space: "a", on: true }, w, c, r.state);
  assert.equal(run({ type: "pin", space: "a", on: true }, w, c, r.state).state, r.state);
  const tree = arrange(w, c, r.state);
  assert.deepEqual(rowIds(tree, "repo:github.com/o/hm"), []);
  assert.equal(group(tree, "repo:github.com/o/hm").can.dismiss, false);
  r = run({ type: "pin", space: "a", on: false }, w, c, r.state);
  assert.deepEqual(r.state.pinned, []);
});

test("moving or dropping a pinned space takes its pin off, and a closed space's pin and open tabs are forgotten", () => {
  const w = pinWorld(), c = config();
  let r = view(w, c);
  r = run({ type: "pin", space: "a" }, w, c, r.state);
  r = run({ type: "expand", space: "a" }, w, c, r.state);
  assert.deepEqual(r.state.open, { a: true });
  r = run({ type: "move", space: "a", group: "", sub: null }, w, c, r.state);
  assert.deepEqual(r.state.pinned, []);
  r = run({ type: "pin", space: "a" }, w, c, r.state);
  r = run({ type: "drop", space: "a", group: "repo:github.com/o/hm", sub: null, before: null }, w, c, r.state);
  assert.deepEqual(r.state.pinned, []);
  r = run({ type: "pin", space: "a" }, w, c, r.state);
  const gone = world([space("b", { folder: "/r/hm" }), space("c")], { repos: { b: HM, c: null } });
  r = view(gone, c, r.state);
  assert.deepEqual(r.state.pinned, []);
  assert.deepEqual(r.state.open, {});
});

test("expand flips a space's tabs open and shut", () => {
  const w = pinWorld(), c = config();
  let r = view(w, c);
  r = run({ type: "expand", space: "a" }, w, c, r.state);
  assert.deepEqual(r.state.open, { a: true });
  r = run({ type: "expand", space: "a" }, w, c, r.state);
  assert.deepEqual(r.state.open, {});
  assert.equal(run({ type: "expand", space: "zz" }, w, c, r.state).state, r.state);
});

test("closing a Repo group closes its spaces, Subgroups included, and the group goes with the last one", () => {
  const w = pinWorld(), c = config();
  let r = view(w, c);
  r = run({ type: "addSub", group: "repo:github.com/o/hm", name: "Review" }, w, c, r.state);
  const sub = r.state.subs["repo:github.com/o/hm"][0].id;
  r = run({ type: "move", space: "b", group: "repo:github.com/o/hm", sub }, w, c, r.state);
  r = run({ type: "closeGroup", group: "repo:github.com/o/hm" }, w, c, r.state);
  assert.deepEqual(r.effects, [{ type: "close", ids: ["a", "b"] }]);
  // One space still open: the group stays.
  const half = world([space("b", { folder: "/r/hm" }), space("c")], { repos: { b: HM, c: null } });
  r = view(half, c, r.state);
  assert.ok(group(r.tree, "repo:github.com/o/hm"));
  const none = world([space("c")], { repos: { c: null } });
  r = view(none, c, r.state);
  assert.equal(group(r.tree, "repo:github.com/o/hm"), undefined);
  assert.deepEqual(r.state.closing, []);
  // A new space in that Repo brings the group back.
  r = view(world([space("d", { folder: "/r/hm" })], { repos: { d: HM } }), c, r.state);
  assert.deepEqual(rowIds(r.tree, "repo:github.com/o/hm"), ["d"]);
});

test("closing a group leaves pinned spaces open and keeps a Repo group that still has one", () => {
  const w = pinWorld(), c = config();
  let r = view(w, c);
  r = run({ type: "pin", space: "b" }, w, c, r.state);
  r = run({ type: "closeGroup", group: "repo:github.com/o/hm" }, w, c, r.state);
  assert.deepEqual(r.effects, [{ type: "close", ids: ["a"] }]);
  assert.deepEqual(r.state.closing, []);
});

test("closing a Custom group closes its spaces and keeps the group, an empty Repo group is dismissed, an unknown one is ignored", () => {
  const w = pinWorld(), c = config();
  let r = view(w, c);
  r = run({ type: "addCustom", name: "Mine" }, w, c, r.state);
  const gid = "custom:" + r.state.custom[0].id;
  r = run({ type: "move", space: "c", group: gid, sub: null }, w, c, r.state);
  r = run({ type: "closeGroup", group: gid }, w, c, r.state);
  assert.deepEqual(r.effects, [{ type: "close", ids: ["c"] }]);
  assert.ok(group(arrange(w, c, r.state), gid));
  assert.deepEqual(run({ type: "closeGroup", group: "custom:nope" }, w, c, r.state).effects, []);
  const empty = world([space("c")], { repos: { c: null } });
  r = view(empty, c, r.state);
  assert.ok(group(r.tree, "repo:github.com/o/hm"));
  r = run({ type: "closeGroup", group: "repo:github.com/o/hm" }, empty, c, r.state);
  assert.deepEqual(r.effects, []);
  assert.equal(group(arrange(empty, c, r.state), "repo:github.com/o/hm"), undefined);
});
