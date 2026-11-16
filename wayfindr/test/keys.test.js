import { test } from "node:test";
import assert from "node:assert/strict";
import { keyAction, keyHints, coreHints, HINT_KEYS, RESERVED } from "../mods/wayfindr/keys.js";

const ALL_FACTS = { url: true, canLaunch: true, canReview: true, canUpdate: true, canMove: true, canComment: true, canPost: true, hasFile: true, hasRows: true, pane: false, full: false };
const NONE = {};
const LAYERS = ["board", "ticket", "move", "launch", "prs", "pr", "review", "confirm", "help", "settings"];
const a = (layer, k, facts = ALL_FACTS) => keyAction(layer, k, facts)?.action ?? null;

test("shared movement: j/k, arrows, ctrl-n/ctrl-p, g/G, enter, r, q, ?", () => {
  for (const layer of ["board", "ticket", "prs"]) {
    for (const k of ["j", "down", "ctrl-n"]) assert.equal(a(layer, k), "next", `${layer} ${k}`);
    for (const k of ["k", "up", "ctrl-p"]) assert.equal(a(layer, k), "prev", `${layer} ${k}`);
    assert.equal(a(layer, "g"), "first");
    assert.equal(a(layer, "shift-g"), "last");
    assert.equal(a(layer, "enter"), "open");
    assert.equal(a(layer, "r"), "refresh");
    assert.equal(a(layer, "q"), "close");
    assert.equal(a(layer, "?"), "help");
    assert.equal(a(layer, "shift-/"), "help");
  }
});

test("modifiers make another key: ctrl-left is not left, ctrl-j is not j", () => {
  assert.equal(a("board", "left"), "colPrev");
  assert.equal(a("board", "ctrl-left"), null);
  assert.equal(a("board", "alt-right"), null);
  assert.equal(a("board", "ctrl-j"), null);
  assert.equal(a("prs", "ctrl-a"), null);
  assert.equal(a("prs", "shift-a"), null);
  assert.equal(a("pr", "ctrl-v"), null);
});

test("board: columns, moving a card, browser, copy, launch, views", () => {
  assert.equal(a("board", "h"), "colPrev");
  assert.equal(a("board", "l"), "colNext");
  assert.equal(a("board", "right"), "colNext");
  for (const k of ["shift-h", "shift-left"]) assert.equal(a("board", k), "moveLeft");
  for (const k of ["shift-l", "shift-right"]) assert.equal(a("board", k), "moveRight");
  assert.equal(a("board", "shift-left", { ...ALL_FACTS, canMove: false }), null);
  assert.equal(a("board", "o"), "browser");
  assert.equal(a("board", "y"), "copy");
  assert.equal(a("board", "o", { ...ALL_FACTS, url: false }), null);
  assert.equal(a("board", "s"), "launch");
  assert.equal(a("board", "s", { ...ALL_FACTS, canLaunch: false }), null);
  assert.equal(a("board", "b"), "viewBoard");
  assert.equal(a("board", "p"), "viewPrs");
  assert.equal(a("board", "c"), null); // the comment box is the detail panel's
  assert.equal(a("board", "j", NONE), null); // no cards
});

test("ticket: the Board's keys plus comment, edit and Move", () => {
  assert.equal(a("ticket", "h"), "colPrev");
  assert.equal(a("ticket", "s"), "launch");
  assert.equal(a("ticket", "c"), "comment");
  assert.equal(a("ticket", "e"), "edit");
  assert.equal(a("ticket", "m"), "move");
  assert.equal(a("ticket", "c", { ...ALL_FACTS, canComment: false }), null);
  assert.equal(a("ticket", "e", { ...ALL_FACTS, canUpdate: false }), null);
  assert.equal(a("ticket", "m", { ...ALL_FACTS, canMove: false }), null);
});

test("move: j/k move in the list, enter picks, q and esc close it", () => {
  assert.equal(a("move", "j"), "next");
  assert.equal(a("move", "up"), "prev");
  assert.equal(a("move", "enter"), "pick");
  assert.equal(a("move", "q"), "close");
  assert.equal(a("move", "escape"), "close");
  assert.equal(a("move", "s"), null);
});

test("launch: enter starts, q and esc close the card", () => {
  assert.equal(a("launch", "enter"), "start");
  assert.equal(a("launch", "q"), "close");
  assert.equal(a("launch", "escape"), "close");
  assert.equal(a("launch", "j"), null);
});

test("prs: browser, copy, review, views and a letter per row", () => {
  assert.equal(a("prs", "o"), "browser");
  assert.equal(a("prs", "y"), "copy");
  assert.equal(a("prs", "s"), "review");
  assert.equal(a("prs", "s", { ...ALL_FACTS, canReview: false }), null);
  assert.equal(a("prs", "b"), "viewBoard");
  assert.equal(a("prs", "p"), "viewPrs");
  assert.equal(a("prs", "a"), "letter");
  assert.equal(a("prs", "z"), "letter");
  assert.equal(a("prs", "a", { ...ALL_FACTS, hasRows: false }), null);
  for (const c of RESERVED) assert.notEqual(a("prs", c), "letter", c);
});

test("pr: files, viewed, checks, post, fullscreen, browser, copy, review, refetch, close", () => {
  assert.equal(a("pr", "j"), "next");
  assert.equal(a("pr", "k"), "prev");
  assert.equal(a("pr", "g"), "first");
  assert.equal(a("pr", "shift-g"), "last");
  assert.equal(a("pr", "v"), "viewed");
  assert.equal(a("pr", "v", { ...ALL_FACTS, hasFile: false }), null);
  assert.equal(a("pr", "c"), "checks");
  assert.equal(a("pr", "p"), "post");
  assert.equal(a("pr", "p", { ...ALL_FACTS, canPost: false }), null);
  assert.equal(a("pr", "f"), "full");
  assert.equal(a("pr", "o"), "browser");
  assert.equal(a("pr", "y"), "copy");
  assert.equal(a("pr", "s"), "review");
  assert.equal(a("pr", "r"), "refresh");
  assert.equal(a("pr", "q"), "close");
  assert.equal(a("pr", "enter"), null);
});

test("pr in the pane copy: no fullscreen, no Review, q does nothing", () => {
  const pane = { ...ALL_FACTS, pane: true };
  assert.equal(a("pr", "f", pane), null);
  assert.equal(a("pr", "s", pane), null);
  assert.equal(a("pr", "q", pane), null);
  assert.equal(a("pr", "j", pane), "next");
});

test("review: p and enter ask when ready, q and esc go back", () => {
  assert.equal(a("review", "p"), "ask");
  assert.equal(a("review", "enter"), "ask");
  assert.equal(a("review", "p", { ...ALL_FACTS, canPost: false }), null);
  assert.equal(a("review", "q"), "back");
  assert.equal(a("review", "escape"), "back");
  assert.equal(a("review", "down"), "next"); // arrows keep working
});

test("confirm: y yes, n q esc no", () => {
  assert.equal(a("confirm", "y"), "yes");
  for (const k of ["n", "q", "escape"]) assert.equal(a("confirm", k), "no");
  assert.equal(a("confirm", "j"), null);
  assert.equal(a("confirm", "enter"), null);
});

test("help: ?, q and esc hide it, nothing else", () => {
  for (const k of ["?", "shift-/", "q", "escape"]) assert.equal(a("help", k), "hide");
  assert.equal(a("help", "j"), null);
});

test("settings: q and esc go back, nothing else (its boxes take letters)", () => {
  assert.equal(a("settings", "q"), "back");
  assert.equal(a("settings", "escape"), "back");
  assert.equal(a("settings", "j"), null);
  assert.equal(a("settings", "?"), null);
});

test("unknown layers do nothing", () => {
  assert.equal(keyAction("nope", "j", ALL_FACTS), null);
});

// The Dockr invariant: the legend and the "?" list name only keys that do something now.
for (const layer of LAYERS) {
  test(`hints in ${layer} name only keys keyAction does something with`, () => {
    for (const facts of [ALL_FACTS, NONE, { ...ALL_FACTS, pane: true }, { hasRows: true }]) {
      const hints = keyHints(layer, facts), core = coreHints(layer, facts);
      for (const [label] of [...hints, ...core]) {
        assert.notEqual(keyAction(layer, HINT_KEYS[label] ?? label, facts), null, `${layer} ${label} ${JSON.stringify(facts)}`);
      }
      for (const h of core) assert.ok(hints.some((x) => x[0] === h[0]), `${layer} core ${h[0]} is in keyHints`);
    }
  });
}

test("coreHints: the few per layer, then ? when it works", () => {
  const labels = (layer, facts = ALL_FACTS) => coreHints(layer, facts).map(([k]) => k);
  assert.deepEqual(labels("board"), ["j/k", "h/l", "enter", "s", "q", "?"]);
  assert.deepEqual(labels("ticket"), ["j/k", "c", "m", "s", "q", "?"]);
  assert.deepEqual(labels("prs"), ["j/k", "a letter", "enter", "s", "q", "?"]);
  assert.deepEqual(labels("pr"), ["j/k", "v", "p", "s", "q", "?"]);
  assert.deepEqual(labels("review"), ["p", "q", "?"]);
  assert.deepEqual(labels("confirm"), ["y", "n", "?"]);
  assert.deepEqual(labels("settings"), ["q"]);
  assert.deepEqual(labels("pr", { ...ALL_FACTS, pane: true, hasFile: false }), ["j/k", "p", "?"]);
  assert.deepEqual(labels("board", NONE), ["q", "?"]);
});

test("keyHints lists every key that works, and drops the rest", () => {
  const labels = keyHints("pr", { ...ALL_FACTS, pane: true }).map(([k]) => k);
  assert.ok(!labels.includes("f") && !labels.includes("s") && !labels.includes("q"));
  assert.ok(labels.includes("v") && labels.includes("o") && labels.includes("?"));
  assert.deepEqual(keyHints("help", ALL_FACTS).map(([k]) => k), ["?", "q"]);
});
