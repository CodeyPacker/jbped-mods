import { test } from "node:test";
import assert from "node:assert/strict";
import { panesFile, parsePanes, serializePanes, addPane, prunePanes, lookupPane, tabIdsOf, recordedPanes, remakePlan } from "../mods/wayfindr/panes.js";

const pr = { key: "k1", id: "#1", title: "A test PR", url: "https://example.com/pr/1", repo: "o/r" };
const spaces = [
  { name: "Review PR #1", tabs: [{ id: "tA" }] },
  { name: "Other", tabs: [{ id: "tB" }, { id: "tC" }] },
];

test("panes.json lives in Wayfindr's data folder", () => {
  assert.equal(panesFile("/h"), "/h/data/wayfindr/panes.json");
});

test("parsePanes starts empty on a missing, broken or foreign file and drops bad entries", () => {
  const empty = { version: 1, panes: {} };
  assert.deepEqual(parsePanes(null), empty);
  assert.deepEqual(parsePanes("{not json"), empty);
  assert.deepEqual(parsePanes(JSON.stringify({ version: 2, panes: {} })), empty);
  assert.deepEqual(parsePanes(JSON.stringify([])), empty);
  const text = JSON.stringify({ version: 1, panes: { tA: { space: "s", account: "gh", pr, at: 1 }, tX: { account: 5, pr }, tY: { account: "gh", pr: { id: "#2" } } } });
  assert.deepEqual(Object.keys(parsePanes(text).panes), ["tA"]);
});

test("addPane records a tab, replacing that tab's earlier record, and round-trips", () => {
  let rec = addPane(parsePanes(null), "tA", { space: "Review PR #1", account: "gh", pr, at: 1 });
  rec = addPane(rec, "tA", { space: "Review PR #1", account: "gh", pr: { ...pr, title: "New" }, at: 2 });
  rec = addPane(rec, "tB", { space: "Other", account: "ado", pr: { key: "k2" }, at: 3 });
  assert.equal(Object.keys(rec.panes).length, 2);
  assert.equal(lookupPane(rec, "tA").pr.title, "New");
  assert.equal(lookupPane(rec, "tZ"), null);
  assert.deepEqual(parsePanes(serializePanes(rec)), rec);
});

test("prunePanes keeps only records whose tab still exists", () => {
  let rec = addPane(parsePanes(null), "tA", { space: "s", account: "gh", pr, at: 1 });
  rec = addPane(rec, "gone", { space: "s", account: "gh", pr, at: 1 });
  assert.deepEqual(tabIdsOf(spaces), ["tA", "tB", "tC"]);
  assert.deepEqual(Object.keys(prunePanes(rec, tabIdsOf(spaces)).panes), ["tA"]);
  assert.deepEqual(tabIdsOf(null), []);
});

test("recordedPanes lists Wayfindr panes in recorded tabs only", () => {
  const rec = addPane(parsePanes(null), "tA", { space: "Review PR #1", account: "gh", pr, at: 1 });
  const panes = [
    { pane: "p1", terminal: "t1", tab: "tA" },
    { pane: "p2", terminal: null, mod: "wayfindr", tab: "tA" },
    { pane: "p3", terminal: null, mod: "wayfindr", tab: "tB" },
    { pane: "p4", terminal: null, mod: "files", tab: "tA" },
  ];
  assert.deepEqual(recordedPanes(rec, panes).map((p) => p.pane), ["p2"]);
  assert.deepEqual(recordedPanes(rec, null), []);
});

test("remakePlan closes the tab's Wayfindr panes and splits one again with the recorded props", () => {
  const rec = addPane(addPane(parsePanes(null), "tA", { space: "Review PR #1", account: "gh", pr, at: 1 }), "tC", { space: "Other", account: "gh", pr: { key: "k3" }, at: 1 });
  const panes = [
    { pane: "p1", terminal: "t1", tab: "tA" },
    { pane: "p2", terminal: null, mod: "wayfindr", tab: "tA" },
    { pane: "p2b", terminal: null, mod: "wayfindr", tab: "tA" },
    { pane: "p5", terminal: "t5", tab: "tB" },
    { pane: "p6", terminal: null, mod: "wayfindr", tab: "tC" },
  ];
  assert.deepEqual(remakePlan(rec, spaces, panes), [
    { tab: "tA", close: ["p2", "p2b"], split: { pane: "p1", direction: "right", mod: "wayfindr", props: { pr: { account: "gh", pr } } } },
    // tC has no terminal of its own: the space's first terminal pane (reviewPaneSpot).
    { tab: "tC", close: ["p6"], split: { pane: "p5", direction: "right", mod: "wayfindr", props: { pr: { account: "gh", pr: { key: "k3" } } } } },
  ]);
});

test("remakePlan leaves a tab alone when it has no Wayfindr pane or no terminal to split from", () => {
  const rec = addPane(parsePanes(null), "tA", { space: "Gone space", account: "gh", pr, at: 1 });
  assert.deepEqual(remakePlan(rec, spaces, [{ pane: "p1", terminal: "t1", tab: "tA" }]), []);
  assert.deepEqual(remakePlan(rec, spaces, [{ pane: "p2", terminal: null, mod: "wayfindr", tab: "tA" }]), []);
});
