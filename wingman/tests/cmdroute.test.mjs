// cmdroute.js: which Wingman copy acts on a wingman.<command> that reached several shown copies.
import { kindOf, nameOf, rank, winner, prune, WINDOW_MS, KEEP_MS } from "../mods/wingman/cmdroute.js";
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
