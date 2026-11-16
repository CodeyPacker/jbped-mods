// cmdroute.js: which Wingman copy acts on a wingman.<command> that reached several shown copies.
import { kindOf, nameOf, rank, winner, prune, WINDOW_MS, KEEP_MS, GIT_COMMANDS, ownerView, ownedAction, handoff, HANDOFF_MS } from "../mods/wingman/cmdroute.js";
import { ACTIONS } from "../mods/wingman/keymap.js";
import assert from "node:assert/strict";

// Kinds: reloads reach every copy; a dialog's, the tree menu's and "focus" are each copy's own; the rest is one copy's.
assert.equal(kindOf("settings"), "all");
assert.equal(kindOf("hook"), "all");
for (const c of ["focus", "treeRename", "treeNewFile", "cpNext", "cpRestore", "cpConfirm", "settingsTab"]) assert.equal(kindOf(c), "self", c);
for (const c of ["checkpoints", "addComment", "commentList", "openSettings", "checkProblems", "problemsShow", "inlineEdit", "prompt", "rejectReason", "rejectComment", "clear"]) assert.equal(kindOf(c), "one", c);
for (const a of ACTIONS) assert.equal(kindOf(a.id), "one", `every key action is one copy's: ${a.id}`);
assert.equal(nameOf("inlineEdit:use async/await: now"), "inlineEdit");
assert.equal(kindOf(nameOf("inlineEdit:x")), "one");

// Rank: the menu's own copy, then the copy with the keyboard, then the command's owner, then a panel copy.
assert.ok(rank({ menu: true }) > rank({ focused: true, owner: true, panel: true }));
assert.ok(rank({ focused: true }) > rank({ owner: true, panel: true }));
assert.ok(rank({ owner: true }) > rank({ panel: true }));
assert.ok(rank({ panel: true }) > rank({}));

// Winner: of the copies that got the same command at about the same time, exactly one acts.
const t = 1000;
const got = [
  { id: "pane1", c: "addComment", at: t, rank: rank({}) },
  { id: "review", c: "addComment", at: t + 3, rank: rank({ panel: true }) },
  { id: "pane0", c: "addComment", at: t + 5, rank: rank({}) },
];
const acting = got.filter((e) => winner(got, e) === e.id).map((e) => e.id);
assert.deepEqual(acting, ["review"], "one copy acts: the panel copy over two panes");
// Ties go to the lowest id, the same answer in every copy.
const panes = got.filter((e) => e.id !== "review");
assert.deepEqual(panes.filter((e) => winner(panes, e) === e.id).map((e) => e.id), ["pane0"]);
// The copy with the keyboard wins over the panel copy (a keys.json key pressed in a pane).
const keyed = [...got.slice(0, 2), { ...got[2], rank: rank({ focused: true }) }];
assert.deepEqual(keyed.filter((e) => winner(keyed, e) === e.id).map((e) => e.id), ["pane0"]);
// Another command, or the same one long after, is a delivery of its own.
assert.equal(winner([...got, { id: "a", c: "save", at: t, rank: 99 }], got[0]), "review");
assert.equal(winner([...got, { id: "a", c: "addComment", at: t + WINDOW_MS + 10, rank: 99 }], got[0]), "review");
// A key pressed twice quickly in one copy: both presses act in that copy.
const twice = [{ id: "edit", c: "moveLineUp", at: t, rank: 5 }, { id: "edit", c: "moveLineUp", at: t + 40, rank: 5 }, { id: "pane", c: "moveLineUp", at: t + 1, rank: 0 }, { id: "pane", c: "moveLineUp", at: t + 41, rank: 0 }];
assert.deepEqual(twice.map((e) => winner(twice, e) === e.id), [true, true, false, false]);
// Alone: it acts.
assert.equal(winner([], { id: "only", c: "x", at: t, rank: 0 }), "only");

// Old entries are dropped.
const list = [{ at: 0 }, { at: KEEP_MS }, { at: KEEP_MS + 10 }];
assert.equal(prune(list, KEEP_MS + 5).length, 2);

// Changes' git commands: one copy, the Changes copy's rule. They are "one" commands like the rest,
// owned by the Changes view: the shown Changes copy acts; any other winner shows Changes and hands over.
for (const c of ["fetch", "pull", "push:r1", "publish", "syncConfirm", "branches", "branchSwitch:main", "branchNew:x y", "discardChange", "discardChangeConfirm", "genMessage", "genCancel"]) {
  assert.equal(kindOf(nameOf(c)), "one", c);
  assert.equal(ownerView(nameOf(c)), "changes", c);
  assert.ok(GIT_COMMANDS.test(c), c);
}
for (const c of ["checkProblems", "inlineEdit", "pushover", "fetchAll", "undo"]) assert.equal(ownerView(c), null, c);
assert.equal(ownedAction("changes", true, "changes"), "act");
assert.equal(ownedAction("changes", false, "changes"), "hand"); // a Changes copy that isn't shown can't act
assert.equal(ownedAction("review", true, "changes"), "hand");
assert.equal(ownedAction(null, true, "changes"), "hand"); // a pane copy
// A Changes copy beside a focused Wingman pane: the pane outranks it (keyboard), so the pane wins and
// hands over; the Changes copy, not the winner, does nothing then; it takes the hand-over once.
{
  const t0 = 1000, pane = { id: "a-pane", c: "push", at: t0, rank: rank({ focused: true }) };
  const chg = { id: "b-changes", c: "push", at: t0 + 5, rank: rank({ owner: true, panel: true }) };
  assert.equal(winner([pane, chg], chg), "a-pane");
  assert.equal(winner([pane, chg], pane), "a-pane");
  const taken = new Map(), req = { space: "s1", cmd: "push", stamp: t0 + 70 };
  // two Changes copies (the panel's and a Changes pane): the first that's shown takes it, the other skips
  assert.equal(handoff(req, { seen: 0, taken, space: "s1", shown: false, now: t0 + 100 }), "wait");
  assert.equal(handoff(req, { seen: 0, taken, space: "s1", shown: true, now: t0 + 300 }), "take");
  taken.set(req.stamp, t0 + 300);
  assert.equal(handoff(req, { seen: 0, taken, space: "s1", shown: true, now: t0 + 310 }), "skip");
  assert.equal(handoff(req, { seen: req.stamp, taken: new Map(), space: "s1", shown: true, now: t0 + 310 }), "skip"); // seen
  assert.equal(handoff(req, { seen: 0, taken: new Map(), space: "s2", shown: true, now: t0 + 310 }), "skip"); // another space
  assert.equal(handoff(req, { seen: 0, taken: new Map(), space: "s1", shown: true, now: req.stamp + HANDOFF_MS + 1 }), "skip"); // too old
  assert.equal(handoff(null, { seen: 0, taken, space: "s1", shown: true, now: 0 }), "skip");
}
// Without a pane, the shown Changes copy is the only one that got it: it wins and acts.
assert.equal(winner([{ id: "z", c: "fetch", at: 5, rank: rank({ owner: true, panel: true }) }], { id: "z", c: "fetch", at: 5, rank: 3 }), "z");
