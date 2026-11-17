import { test } from "node:test";
import assert from "node:assert/strict";
import { arrange, act, KEYS, validBranchName } from "../mods/gitr/model.js";

const MAIN = "/home/me/dev/repo";

function deepFreeze(x) {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

function checkout(path, branch, o = {}) {
  return {
    path, main: false, branch, head: "abc123", detached: branch === null,
    prunable: false, locked: false, changes: 0, tracked: 0, ...o,
  };
}

function mainCheckout(branch = "main", o = {}) {
  return checkout(MAIN, branch, { main: true, ...o });
}

function branch(name, o = {}) {
  return { name, sha: "s-" + name, upstream: null, gone: false, ahead: null, behind: null, date: 1000, ...o };
}

function remote(name, o = {}) {
  const [r, ...rest] = name.split("/");
  return { name, remote: r, branch: rest.join("/"), sha: "r-" + name, date: 1000, ...o };
}

function git({ main = MAIN, defaultBranch = "origin/main", checkouts, branches, remotes = [] } = {}) {
  return {
    main, defaultBranch,
    checkouts: checkouts ?? [mainCheckout()],
    branches: branches ?? [branch("main")],
    remotes, at: 0,
  };
}

function space(id, dir, o = {}) {
  return { id, name: id, machine: null, status: "idle", dir, ...o };
}

function pane(space, cwd, title, o = {}) {
  return { space, cwd, title, machine: null, ...o };
}

function world(o = {}) {
  return {
    git: git(), repo: { identity: "github.com/me/repo", name: "repo" }, machine: null, reachable: true,
    spaces: [], panes: [], source: { kind: "standalone", enter: "worktree" },
    query: "", sort: "recent", filter: "all", remotesOpen: false, busy: {}, now: 0, ...o,
  };
}

const view = (w) => arrange(deepFreeze(w));
const run = (w, action) => act(deepFreeze(w), action);
const section = (v, id) => v.sections.find((s) => s.id === id);
const ids = (v, id) => section(v, id)?.rows.map((r) => r.id);
const row = (v, id) => v.sections.flatMap((s) => s.rows).find((r) => r.id === id);
const types = (r) => r.effects.map((e) => e.type);

// A Repo with a Worktree for "feat", a Branch nowhere "old", and a detached Worktree.
function standard(o = {}) {
  return git({
    checkouts: [
      mainCheckout(),
      checkout(MAIN + "/.worktrees/feat", "feat"),
      checkout("/home/me/wt/loose", null),
    ],
    branches: [branch("main"), branch("feat", { date: 3000 }), branch("old", { date: 2000 })],
    remotes: [remote("origin/main"), remote("origin/feat"), remote("origin/theirs", { date: 5000 })],
    ...o,
  });
}

// validBranchName

test("validBranchName follows git's main rules", () => {
  for (const ok of ["feat", "jb/33-gitr", "a.b", "v1@x", "a/b.c"]) assert.equal(validBranchName(ok), true, ok);
  for (const bad of ["", "a b", "a..b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a\x01b", "-a", "/a", "a/", "a.", "a.lock", "a//b", "a@{b", ".a", "a/.b"])
    assert.equal(validBranchName(bad), false, JSON.stringify(bad));
});

test("KEYS lists the footer keys with labels", () => {
  const byKey = Object.fromEntries(KEYS.map((k) => [k.key, k.type]));
  assert.equal(byKey["ctrl-o"], "checkout");
  assert.equal(byKey["ctrl-w"], "worktree");
  assert.equal(byKey["ctrl-x"], "remove");
  assert.ok(KEYS.every((k) => typeof k.label === "string" && k.label));
});

// Occupied

test("a space in a Worktree inside the Main checkout's directory occupies the Worktree, not the Main checkout", () => {
  const v = view(world({ git: standard(), spaces: [space("a", MAIN + "/.worktrees/feat/src"), space("b", MAIN + "/docs")] }));
  assert.deepEqual(ids(v, "main"), ["main", "s:b"]);
  assert.deepEqual(ids(v, "branches").slice(0, 2), ["b:feat", "s:a"]);
});

test("a space is placed by its first terminal; another pane in a Worktree does not move it", () => {
  const w = world({
    git: standard(),
    spaces: [space("a", MAIN)],
    panes: [pane("a", MAIN, "shell"), pane("a", MAIN + "/.worktrees/feat", "nvim")],
  });
  const v = view(w);
  assert.deepEqual(ids(v, "main"), ["main", "s:a"]);
  assert.deepEqual(ids(v, "branches").slice(0, 2), ["b:feat", "b:old"]);
});

test("a space on another Machine occupies nothing", () => {
  const v = view(world({ git: standard(), spaces: [space("a", MAIN, { machine: "wsl" })] }));
  assert.deepEqual(ids(v, "main"), ["main"]);
});

test("spaces match the Machine Gitr shows", () => {
  const v = view(world({ git: standard(), machine: "wsl", spaces: [space("a", MAIN, { machine: "wsl" }), space("b", MAIN)] }));
  assert.deepEqual(ids(v, "main"), ["main", "s:a"]);
});

test("Windows paths match with backslashes and any drive-letter case", () => {
  const g = git({
    main: "C:/dev/repo",
    checkouts: [checkout("C:/dev/repo", "main", { main: true }), checkout("C:/dev/repo/.worktrees/feat", "feat")],
    branches: [branch("main"), branch("feat")],
  });
  const v = view(world({ git: g, spaces: [space("a", "c:\\Dev\\Repo\\.worktrees\\FEAT\\"), space("b", "c:\\dev\\repo")] }));
  assert.deepEqual(ids(v, "main"), ["main", "s:b"]);
  assert.deepEqual(ids(v, "branches"), ["b:feat", "s:a"]);
  assert.equal(row(v, "b:feat").path, ".worktrees/feat");
});

test("a space outside every checkout is not shown", () => {
  const v = view(world({ git: standard(), spaces: [space("a", "/tmp"), space("b", null)] }));
  assert.ok(!v.order.includes("s:a") && !v.order.includes("s:b"));
});

// Sections and rows

test("sections are Main checkout, Branches, remote branches; detached last; create row last", () => {
  const v = view(world({ git: standard() }));
  assert.deepEqual(v.sections.map((s) => s.id), ["main", "branches", "remotes"]);
  assert.deepEqual(ids(v, "main"), ["main"]);
  assert.deepEqual(ids(v, "branches"), ["b:feat", "b:old", "d:/home/me/wt/loose"]);
  const m = row(v, "main");
  assert.equal(m.name, "main");
  assert.equal(m.path, MAIN);
  assert.equal(m.worktree, false);
  assert.deepEqual(m.actions, ["open", "newFrom"]);
  assert.equal(m.enter, "open");
});

test("a Branch with a Worktree shows its directory; a Branch nowhere is dim with no Worktree mark", () => {
  const v = view(world({ git: standard() }));
  const feat = row(v, "b:feat");
  assert.equal(feat.worktree, true);
  assert.equal(feat.path, ".worktrees/feat");
  assert.equal(feat.dir, MAIN + "/.worktrees/feat");
  assert.equal(feat.dim, false);
  assert.deepEqual(feat.actions, ["open", "newFrom", "remove"]);
  const old = row(v, "b:old");
  assert.equal(old.worktree, false);
  assert.equal(old.path, null);
  assert.equal(old.dim, true);
  assert.deepEqual(old.actions, ["worktree", "checkout", "newFrom", "delete", "rename"]);
});

test("a detached Worktree is a row at the end with its absolute directory", () => {
  const v = view(world({ git: standard(), spaces: [space("x", "/home/me/wt/loose")] }));
  const d = row(v, "d:/home/me/wt/loose");
  assert.equal(d.name, "(detached)");
  assert.equal(d.path, "/home/me/wt/loose");
  assert.deepEqual(d.actions, ["open", "remove"]);
  assert.deepEqual(ids(v, "branches").slice(-2), ["d:/home/me/wt/loose", "s:x"]);
});

test("remote branches with a local Branch are left out; the section folds with a count", () => {
  const v = view(world({ git: standard() }));
  const r = section(v, "remotes");
  assert.equal(r.folded, true);
  assert.equal(r.count, 1);
  assert.deepEqual(r.rows, []);
  assert.ok(!v.order.includes("r:origin/theirs"));
  const open = view(world({ git: standard(), remotesOpen: true }));
  assert.deepEqual(ids(open, "remotes"), ["r:origin/theirs"]);
  assert.deepEqual(row(open, "r:origin/theirs").actions, ["worktree", "checkout", "newFrom"]);
});

test("the remotes section is left out when it has no rows; Main checkout stays", () => {
  const v = view(world({ git: git({ remotes: [remote("origin/main")] }) }));
  assert.deepEqual(v.sections.map((s) => s.id), ["main"]);
  const none = view(world({ git: standard(), query: "zzz zzz" }));
  assert.deepEqual(none.sections.map((s) => s.id), ["main"]);
  assert.deepEqual(none.order, []);
  assert.equal(none.empty, 'Nothing matches "zzz zzz"');
});

test("no git state yet gives an empty message", () => {
  const v = view(world({ git: null }));
  assert.deepEqual(v.order, []);
  assert.equal(v.empty, "Nothing read yet");
});

// Marks

test("marks: gone upstream, uncommitted changes, ahead and behind", () => {
  const g = standard({
    checkouts: [mainCheckout("main", { changes: 2, tracked: 1 }), checkout(MAIN + "/.worktrees/feat", "feat", { changes: 4 })],
    branches: [branch("main", { ahead: 0, behind: 2 }), branch("feat", { ahead: 3, behind: 0 }), branch("old", { gone: true })],
  });
  const v = view(world({ git: g }));
  assert.equal(row(v, "main").changes, 2);
  assert.equal(row(v, "main").behind, 2);
  assert.equal(row(v, "b:feat").changes, 4);
  assert.equal(row(v, "b:feat").ahead, 3);
  assert.equal(row(v, "b:old").gone, true);
  assert.equal(row(v, "b:old").changes, null);
});

test("a prunable Worktree allows only remove and has no Enter", () => {
  const g = standard({
    checkouts: [mainCheckout(), checkout(MAIN + "/.worktrees/feat", "feat", { prunable: true, changes: null }), checkout("/home/me/wt/loose", null, { prunable: true, changes: null })],
  });
  const v = view(world({ git: g }));
  for (const id of ["b:feat", "d:/home/me/wt/loose"]) {
    assert.equal(row(v, id).prunable, true);
    assert.deepEqual(row(v, id).actions, ["remove"]);
    assert.equal(row(v, id).enter, null);
  }
});

// Search, sort, filter

test("search matches Branch name, Worktree directory and space name", () => {
  const w = (query) => world({ git: standard(), query, spaces: [space("a", MAIN + "/.worktrees/feat", { name: "33 Gitr spec" })] });
  assert.deepEqual(ids(view(w("OLD")), "branches").filter((i) => !i.startsWith("create")), ["b:old"]);
  assert.deepEqual(ids(view(w(".worktrees")), "branches"), ["b:feat", "s:a"]);
  assert.deepEqual(ids(view(w("loose")), "branches"), ["d:/home/me/wt/loose", "create:loose"]);
  assert.deepEqual(ids(view(w("gitr spec")), "branches"), ["b:feat", "s:a"]);
});

test("a matching Branch keeps all its spaces; a matching space keeps its parent only", () => {
  const spaces = [space("a", MAIN + "/.worktrees/feat", { name: "alpha" }), space("b", MAIN + "/.worktrees/feat", { name: "beta" })];
  assert.deepEqual(ids(view(world({ git: standard(), spaces, query: "feat" })), "branches"), ["b:feat", "s:a", "s:b"]);
  assert.deepEqual(ids(view(world({ git: standard(), spaces, query: "beta" })), "branches"), ["b:feat", "s:b", "create:beta"]);
});

test("search unfolds the remote section", () => {
  const v = view(world({ git: standard(), query: "theirs" }));
  assert.equal(section(v, "remotes").folded, false);
  assert.deepEqual(ids(v, "remotes"), ["r:origin/theirs"]);
});

test("sort recent by date descending, az by name case-insensitive", () => {
  const g = standard({ branches: [branch("main"), branch("feat", { date: 3000 }), branch("Bee", { date: 1000 }), branch("old", { date: 2000 })] });
  assert.deepEqual(ids(view(world({ git: g })), "branches"), ["b:feat", "b:old", "b:Bee", "d:/home/me/wt/loose"]);
  assert.deepEqual(ids(view(world({ git: g, sort: "az" })), "branches"), ["b:Bee", "b:feat", "b:old", "d:/home/me/wt/loose"]);
  const r = git({ remotes: [remote("origin/a", { date: 1 }), remote("origin/b", { date: 9 })] });
  assert.deepEqual(ids(view(world({ git: r, remotesOpen: true })), "remotes"), ["r:origin/b", "r:origin/a"]);
  assert.deepEqual(ids(view(world({ git: r, remotesOpen: true, sort: "az" })), "remotes"), ["r:origin/a", "r:origin/b"]);
});

test("filter: all, with a Worktree, checked out nowhere", () => {
  assert.deepEqual(ids(view(world({ git: standard(), filter: "worktree" })), "branches"), ["b:feat", "d:/home/me/wt/loose"]);
  assert.deepEqual(ids(view(world({ git: standard(), filter: "nowhere" })), "branches"), ["b:old"]);
  assert.equal(section(view(world({ git: standard(), filter: "nowhere" })), "main").rows.length, 1);
});

test("the create row appears for a valid new name only", () => {
  const v = view(world({ git: standard(), query: " new-thing " }));
  const c = row(v, "create:new-thing");
  assert.equal(c.name, 'Create "new-thing"');
  assert.deepEqual(c.actions, ["worktree", "checkout"]);
  assert.equal(ids(v, "branches").at(-1), "create:new-thing");
  for (const query of ["", "old", "theirs", "bad name", "x..y"])
    assert.ok(!view(world({ git: standard(), query })).order.some((i) => i.startsWith("create:")), query);
});

// Enter

test("Enter per row kind with source.enter worktree", () => {
  const w = world({ git: standard(), query: "", remotesOpen: true, spaces: [space("a", MAIN)] });
  const v = view(w);
  assert.equal(row(v, "s:a").enter, "go");
  assert.equal(row(v, "main").enter, "open");
  assert.equal(row(v, "b:feat").enter, "open");
  assert.equal(row(v, "d:/home/me/wt/loose").enter, "open");
  assert.equal(row(v, "b:old").enter, "worktree");
  assert.equal(row(v, "r:origin/theirs").enter, "worktree");
  assert.equal(row(view({ ...w, query: "nu" }), "create:nu").enter, "worktree");
  assert.deepEqual(types(run(w, { type: "enter", row: "b:old" })), ["worktree", "close"]);
});

test("Enter per row kind with source.enter checkout", () => {
  const w = world({ git: standard(), remotesOpen: true, source: { kind: "wranglr", enter: "checkout" } });
  const v = view(w);
  assert.equal(row(v, "b:old").enter, "checkout");
  assert.deepEqual(row(v, "b:old").actions.slice(0, 2), ["checkout", "worktree"]);
  assert.equal(row(v, "r:origin/theirs").enter, "checkout");
  assert.equal(row(view({ ...w, query: "nu" }), "create:nu").enter, "checkout");
  assert.equal(row(v, "b:feat").enter, "open");
  assert.deepEqual(types(run(w, { type: "enter", row: "b:old" })), ["checkout", "space.start", "close"]);
});

// Effects without a question

test("go selects the space and closes", () => {
  const w = world({ git: standard(), spaces: [space("a", MAIN)] });
  assert.deepEqual(run(w, { type: "enter", row: "s:a" }).effects, [{ type: "space.select", id: "a" }, { type: "close" }]);
});

test("open goes to the first occupying space, else starts one there", () => {
  const w = world({ git: standard(), spaces: [space("a", MAIN + "/.worktrees/feat"), space("b", MAIN + "/.worktrees/feat")] });
  assert.deepEqual(run(w, { type: "open", row: "b:feat" }).effects, [{ type: "space.select", id: "a" }, { type: "close" }]);
  assert.deepEqual(run(w, { type: "open", row: "main" }).effects, [{ type: "space.start", dir: MAIN }, { type: "close" }]);
  assert.deepEqual(run(w, { type: "enter", row: "d:/home/me/wt/loose" }).effects, [{ type: "space.start", dir: "/home/me/wt/loose" }, { type: "close" }]);
});

test("worktree for a local Branch, a remote branch, and a new Branch", () => {
  const w = world({ git: standard(), remotesOpen: true });
  assert.deepEqual(run(w, { type: "worktree", row: "b:old" }).effects, [{ type: "worktree", branch: "old" }, { type: "close" }]);
  assert.deepEqual(run(w, { type: "worktree", row: "r:origin/theirs" }).effects, [
    { type: "git", args: ["branch", "--track", "theirs", "origin/theirs"] },
    { type: "worktree", branch: "theirs" },
    { type: "close" },
  ]);
  assert.deepEqual(run({ ...w, query: "nu" }, { type: "enter", row: "create:nu" }).effects, [
    { type: "fetch", ref: "origin/main" },
    { type: "git", args: ["branch", "--no-track", "nu", "origin/main"] },
    { type: "worktree", branch: "nu" },
    { type: "close" },
  ]);
});

test("checkout of a Branch in a clean, free Main checkout, then start a space there", () => {
  const w = world({ git: standard() });
  assert.deepEqual(run(w, { type: "checkout", row: "b:old" }).effects, [
    { type: "checkout", branch: "old", stash: false },
    { type: "space.start", dir: MAIN },
    { type: "close" },
  ]);
});

test("checkout of a remote branch tracks it first", () => {
  const w = world({ git: standard(), remotesOpen: true });
  assert.deepEqual(types(run(w, { type: "checkout", row: "r:origin/theirs" })), ["git", "checkout", "space.start", "close"]);
});

test("checkout on a create row checks out the new Branch", () => {
  const w = world({ git: standard(), query: "nu" });
  assert.deepEqual(run(w, { type: "checkout", row: "create:nu" }).effects, [
    { type: "fetch", ref: "origin/main" },
    { type: "git", args: ["branch", "--no-track", "nu", "origin/main"] },
    { type: "checkout", branch: "nu", stash: false },
    { type: "space.start", dir: MAIN },
    { type: "close" },
  ]);
});

test("create start point: from, else default branch, else main, else master, else none", () => {
  const create = (g, from = null) => run(world({ git: g }), { type: "create", name: "nu", from, mode: "worktree" }).effects;
  assert.deepEqual(create(standard(), "old"), [
    { type: "git", args: ["branch", "--no-track", "nu", "old"] }, { type: "worktree", branch: "nu" }, { type: "close" },
  ]);
  assert.deepEqual(create(standard(), "origin/theirs").slice(0, 2), [
    { type: "fetch", ref: "origin/theirs" }, { type: "git", args: ["branch", "--no-track", "nu", "origin/theirs"] },
  ]);
  assert.deepEqual(create(standard()).slice(0, 2), [
    { type: "fetch", ref: "origin/main" }, { type: "git", args: ["branch", "--no-track", "nu", "origin/main"] },
  ]);
  assert.deepEqual(create(git({ defaultBranch: null }))[0], { type: "git", args: ["branch", "--no-track", "nu", "main"] });
  const master = git({ defaultBranch: null, checkouts: [mainCheckout("master")], branches: [branch("master")] });
  assert.deepEqual(create(master)[0], { type: "git", args: ["branch", "--no-track", "nu", "master"] });
  const none = git({ defaultBranch: null, checkouts: [mainCheckout("dev")], branches: [branch("dev")] });
  assert.deepEqual(create(none)[0], { type: "git", args: ["branch", "--no-track", "nu"] });
});

test("create with mode null follows source.enter", () => {
  const w = world({ git: standard(), source: { kind: "wranglr", enter: "checkout" } });
  assert.deepEqual(types(run(w, { type: "create", name: "nu", from: null, mode: null })), ["fetch", "git", "checkout", "space.start", "close"]);
});

test("delete runs git branch -d with a refuse action", () => {
  const r = run(world({ git: standard() }), { type: "delete", row: "b:old" });
  assert.deepEqual(r.effects, [
    { type: "git", args: ["branch", "-d", "old"], refuse: { type: "delete", row: "b:old", force: true } },
    { type: "refresh" },
  ]);
});

test("rename asks with the current name, then git branch -m", () => {
  const w = world({ git: standard() });
  const r = run(w, { type: "rename", row: "b:old" });
  assert.equal(r.ask.kind, "input");
  assert.equal(r.ask.title, "Rename old");
  assert.equal(r.ask.value, "old");
  assert.deepEqual(run(w, { ...r.ask.action, name: "older" }).effects, [
    { type: "git", args: ["branch", "-m", "old", "older"] }, { type: "refresh" },
  ]);
  const bad = run(w, { ...r.ask.action, name: "a b" });
  assert.equal(bad.ask.title, "Rename old");
  assert.ok(bad.ask.error);
  assert.ok(run(w, { ...r.ask.action, name: "feat" }).ask.error);
});

test("newFrom asks for a name, and the answer comes back as create", () => {
  const w = world({ git: standard(), remotesOpen: true });
  const r = run(w, { type: "newFrom", row: "b:feat" });
  assert.equal(r.ask.kind, "input");
  assert.equal(r.ask.title, "New branch from feat");
  assert.equal(r.ask.value, "");
  assert.deepEqual(r.ask.action, { type: "create", from: "feat", mode: null });
  assert.deepEqual(run(w, { ...r.ask.action, name: "sub" }).effects, [
    { type: "git", args: ["branch", "--no-track", "sub", "feat"] }, { type: "worktree", branch: "sub" }, { type: "close" },
  ]);
  const taken = run(w, { ...r.ask.action, name: "old" });
  assert.equal(taken.ask.title, "New branch from feat");
  assert.equal(taken.ask.value, "old");
  assert.match(taken.ask.error, /already exists/);
  assert.match(run(w, { ...r.ask.action, name: "-x" }).ask.error, /valid/);
  assert.equal(run(w, { type: "newFrom", row: "main" }).ask.action.from, "main");
  assert.equal(run(w, { type: "newFrom", row: "r:origin/theirs" }).ask.action.from, "origin/theirs");
});

test("fetch, refresh, sort, filter and remotes", () => {
  const w = world({ git: standard() });
  assert.deepEqual(run(w, { type: "fetch" }).effects, [
    { type: "git", args: ["fetch", "--all", "--prune"], timeout: 60000 }, { type: "refresh" },
  ]);
  assert.deepEqual(run(w, { type: "refresh" }).effects, [{ type: "refresh" }]);
  assert.deepEqual(run(w, { type: "sort" }).effects, [{ type: "set", key: "sort", value: "az" }]);
  assert.deepEqual(run({ ...w, sort: "az" }, { type: "sort" }).effects, [{ type: "set", key: "sort", value: "recent" }]);
  assert.deepEqual(run(w, { type: "filter" }).effects, [{ type: "set", key: "filter", value: "worktree" }]);
  assert.deepEqual(run({ ...w, filter: "worktree" }, { type: "filter" }).effects, [{ type: "set", key: "filter", value: "nowhere" }]);
  assert.deepEqual(run({ ...w, filter: "nowhere" }, { type: "filter" }).effects, [{ type: "set", key: "filter", value: "all" }]);
  assert.deepEqual(run(w, { type: "remotes" }).effects, [{ type: "set", key: "remotesOpen", value: true }]);
});

// Confirms

test("checkout with tracked changes asks to stash, and the yes carries stash", () => {
  const g = standard({ checkouts: [mainCheckout("main", { changes: 5, tracked: 3 })] });
  const w = world({ git: g });
  const r = run(w, { type: "checkout", row: "b:old" });
  assert.equal(r.ask.kind, "confirm");
  assert.match(r.ask.title, /3 uncommitted changes/);
  assert.equal(r.ask.yes, "Stash, check out and reapply");
  assert.equal(r.ask.action.stash, true);
  assert.deepEqual(run(w, { ...r.ask.action, confirmed: true, checks: {} }).effects, [
    { type: "checkout", branch: "old", stash: true }, { type: "space.start", dir: MAIN }, { type: "close" },
  ]);
});

test("untracked files alone do not ask", () => {
  const g = standard({ checkouts: [mainCheckout("main", { changes: 2, tracked: 0 })] });
  assert.equal(run(world({ git: g }), { type: "checkout", row: "b:old" }).ask, undefined);
});

test("checkout in an Occupied Main checkout names each space and status, then goes to it", () => {
  const w = world({ git: standard(), spaces: [space("a", MAIN, { name: "agent", status: "working" }), space("b", MAIN + "/src", { name: "shell", status: "idle" })] });
  const r = run(w, { type: "enter", row: "b:old", });
  assert.equal(r.ask, undefined);
  const c = run(w, { type: "checkout", row: "b:old" });
  assert.equal(c.ask.kind, "confirm");
  assert.deepEqual(c.ask.lines, ['Space "agent" is in the Main checkout (working)', 'Space "shell" is in the Main checkout (idle)']);
  assert.equal(c.ask.action.stash, undefined);
  assert.deepEqual(run(w, { ...c.ask.action, confirmed: true }).effects, [
    { type: "checkout", branch: "old", stash: false }, { type: "space.select", id: "a" }, { type: "close" },
  ]);
});

test("checkout with both tracked changes and an Occupied Main checkout is one confirm", () => {
  const g = standard({ checkouts: [mainCheckout("main", { changes: 1, tracked: 1 })] });
  const w = world({ git: g, spaces: [space("a", MAIN, { status: "blocked" })] });
  const c = run(w, { type: "checkout", row: "b:old" });
  assert.equal(c.ask.yes, "Stash, check out and reapply");
  assert.equal(c.ask.lines.length, 2);
  assert.match(c.ask.lines[0], /1 uncommitted change /);
  assert.match(c.ask.lines[1], /\(blocked\)/);
  assert.deepEqual(types(run(w, { ...c.ask.action, confirmed: true })), ["checkout", "space.select", "close"]);
  assert.equal(run(w, { ...c.ask.action, confirmed: true }).effects[0].stash, true);
});

test("a create row's checkout confirm comes back as create", () => {
  const g = standard({ checkouts: [mainCheckout("main", { tracked: 2, changes: 2 })] });
  const w = world({ git: g, query: "nu" });
  const c = run(w, { type: "checkout", row: "create:nu" });
  assert.equal(c.ask.action.type, "create");
  assert.deepEqual(types(run(w, { ...c.ask.action, confirmed: true })), ["fetch", "git", "checkout", "space.start", "close"]);
});

test("remove names spaces it closes, other panes left open, and changes", () => {
  const g = standard({ checkouts: [mainCheckout(), checkout(MAIN + "/.worktrees/feat", "feat", { changes: 4, tracked: 4 })] });
  const w = world({
    git: g,
    spaces: [space("a", MAIN + "/.worktrees/feat", { name: "33 gitr spec", status: "working" }), space("b", "/elsewhere", { name: "Wranglr fixes" })],
    panes: [
      pane("a", MAIN + "/.worktrees/feat", "claude"),
      pane("b", MAIN + "/.worktrees/feat/src", "nvim"),
      pane("b", "/elsewhere", "shell"),
      pane("c", MAIN + "/.worktrees/feat", "far", { machine: "wsl" }),
    ],
  });
  const r = run(w, { type: "remove", row: "b:feat" });
  assert.equal(r.ask.kind, "confirm");
  assert.equal(r.ask.danger, true);
  assert.deepEqual(r.ask.lines, [
    'Closes space "33 gitr spec" (working)',
    'Pane "nvim" in space "Wranglr fixes" is inside this Worktree and stays open',
    "4 uncommitted changes will be lost",
  ]);
  assert.deepEqual(r.ask.checks, [{ id: "branch", label: 'Also delete branch "feat"', checked: false }]);
  assert.deepEqual(run(w, { ...r.ask.action, confirmed: true, checks: { branch: true } }).effects, [
    { type: "space.close", id: "a" },
    { type: "git", args: ["worktree", "remove", "--force", MAIN + "/.worktrees/feat"] },
    { type: "git", args: ["branch", "-D", "feat"] },
    { type: "refresh" },
  ]);
  assert.deepEqual(run(w, { ...r.ask.action, confirmed: true, checks: { branch: false } }).effects.map((e) => e.args?.[0] ?? e.type), [
    "space.close", "worktree", "refresh",
  ]);
});

test("remove of a clean Worktree is not dangerous and does not force", () => {
  const w = world({ git: standard() });
  const r = run(w, { type: "remove", row: "b:feat" });
  assert.equal(r.ask.danger, false);
  assert.deepEqual(r.ask.lines, []);
  assert.deepEqual(run(w, { ...r.ask.action, confirmed: true, checks: { branch: false } }).effects, [
    { type: "git", args: ["worktree", "remove", MAIN + "/.worktrees/feat"] }, { type: "refresh" },
  ]);
});

test("remove of a detached Worktree has no branch check", () => {
  const w = world({ git: standard() });
  const r = run(w, { type: "remove", row: "d:/home/me/wt/loose" });
  assert.equal(r.ask.checks, undefined);
  assert.deepEqual(run(w, { ...r.ask.action, confirmed: true, checks: { branch: true } }).effects, [
    { type: "git", args: ["worktree", "remove", "/home/me/wt/loose"] }, { type: "refresh" },
  ]);
});

test("delete refused by git asks, then forces", () => {
  const w = world({ git: standard() });
  const refuse = run(w, { type: "delete", row: "b:old" }).effects[0].refuse;
  const r = run(w, { ...refuse, said: "error: the branch 'old' is not fully merged.\n" });
  assert.equal(r.ask.kind, "confirm");
  assert.equal(r.ask.danger, true);
  assert.equal(r.ask.lines[0], "error: the branch 'old' is not fully merged.");
  assert.deepEqual(run(w, { ...r.ask.action, confirmed: true }).effects, [
    { type: "git", args: ["branch", "-D", "old"] }, { type: "refresh" },
  ]);
});

// Cleanup

test("cleanup lists gone Branches and prunable Worktrees with default ticks", () => {
  const g = git({
    checkouts: [
      mainCheckout("done-main"),
      checkout(MAIN + "/.worktrees/a", "a"),
      checkout(MAIN + "/.worktrees/b", "b", { changes: 1 }),
      checkout(MAIN + "/.worktrees/c", "c"),
      checkout("/gone/dir", null, { prunable: true, changes: null }),
    ],
    branches: [
      branch("done-main", { gone: true }), branch("a", { gone: true }), branch("b", { gone: true }),
      branch("c", { gone: true }), branch("d", { gone: true }), branch("live"),
    ],
  });
  const w = world({ git: g, spaces: [space("s1", MAIN + "/.worktrees/c")] });
  const r = run(w, { type: "cleanup" });
  assert.equal(r.ask.kind, "checklist");
  assert.deepEqual(r.ask.action, { type: "cleanupRun" });
  const items = Object.fromEntries(r.ask.items.map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(items), ["b:a", "b:b", "b:c", "b:d", "p:/gone/dir"]);
  assert.equal(items["b:a"].checked, true);
  assert.match(items["b:a"].detail, /Worktree/);
  assert.equal(items["b:b"].checked, false);
  assert.equal(items["b:c"].checked, false);
  assert.equal(items["b:d"].checked, true);
  assert.equal(items["p:/gone/dir"].checked, true);

  assert.deepEqual(run(w, { ...r.ask.action, items: ["b:a", "b:c", "b:d", "p:/gone/dir"] }).effects, [
    { type: "git", args: ["worktree", "remove", "--force", MAIN + "/.worktrees/a"] },
    { type: "git", args: ["branch", "-D", "a"] },
    { type: "space.close", id: "s1" },
    { type: "git", args: ["worktree", "remove", "--force", MAIN + "/.worktrees/c"] },
    { type: "git", args: ["branch", "-D", "c"] },
    { type: "git", args: ["branch", "-D", "d"] },
    { type: "git", args: ["worktree", "prune"] },
    { type: "refresh" },
  ]);
  assert.deepEqual(run(w, { type: "cleanupRun", items: ["b:d"] }).effects, [
    { type: "git", args: ["branch", "-D", "d"] }, { type: "refresh" },
  ]);
});

test("cleanup with nothing to clean is an info toast", () => {
  assert.deepEqual(run(world({ git: standard() }), { type: "cleanup" }).effects, [{ type: "toast", level: "info", title: "Nothing to clean up" }]);
});

// Not allowed, unreachable, busy

test("an action not allowed on its row, or an unknown row, is a warning toast", () => {
  const w = world({ git: standard() });
  for (const action of [{ type: "remove", row: "main" }, { type: "delete", row: "b:feat" }, { type: "checkout", row: "b:feat" }, { type: "open", row: "nope" }]) {
    const r = run(w, action);
    assert.equal(r.effects.length, 1);
    assert.equal(r.effects[0].type, "toast");
    assert.equal(r.effects[0].level, "warning");
  }
});

test("an unreachable Machine dims rows, removes actions and allows only refresh, sort, filter and remotes", () => {
  const w = world({ git: standard(), reachable: false, spaces: [space("a", MAIN)], remotesOpen: true });
  const v = view(w);
  assert.equal(v.order.length, 6);
  for (const s of v.sections) for (const r of s.rows) {
    assert.equal(r.dim, true, r.id);
    assert.deepEqual(r.actions, [], r.id);
    assert.equal(r.enter, null, r.id);
  }
  assert.ok(!view({ ...w, query: "nu" }).order.includes("create:nu"));
  for (const type of ["fetch", "cleanup", "create"]) assert.equal(run(w, { type, name: "x" }).effects[0].type, "toast");
  assert.equal(run(w, { type: "enter", row: "s:a" }).effects[0].type, "toast");
  assert.deepEqual(run(w, { type: "refresh" }).effects, [{ type: "refresh" }]);
  assert.equal(run(w, { type: "sort" }).effects[0].type, "set");
  assert.equal(run(w, { type: "filter" }).effects[0].type, "set");
  assert.equal(run(w, { type: "remotes" }).effects[0].type, "set");
});

test("a busy row keeps its actions and act says it is still working", () => {
  const w = world({ git: standard(), busy: { "b:old": true } });
  const r = row(view(w), "b:old");
  assert.equal(r.busy, true);
  assert.deepEqual(r.actions, ["worktree", "checkout", "newFrom", "delete", "rename"]);
  assert.deepEqual(run(w, { type: "delete", row: "b:old" }).effects, [{ type: "toast", level: "warning", title: "Still working" }]);
  assert.equal(row(view(w), "b:feat").busy, false);
});

test("act finds a row hidden by the filter or the fold", () => {
  const w = world({ git: standard(), filter: "worktree" });
  assert.deepEqual(types(run(w, { type: "worktree", row: "b:old" })), ["worktree", "close"]);
  assert.deepEqual(types(run(w, { type: "worktree", row: "r:origin/theirs" })), ["git", "worktree", "close"]);
});
