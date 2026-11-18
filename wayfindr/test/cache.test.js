import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheFile, parseCache, serializeCache, cachedBoard, withBoard, formatAge, isShown, due, POLL_MS, SHOW_GAP_MS } from "../mods/wayfindr/cache.js";

const team = { id: "team", account: "gh", ref: { owner: "o", number: 1 } };
const ops = { id: "ops", account: "gh", ref: { owner: "o", number: 2 } };

test("one file per Profile, with a safe name", () => {
  assert.equal(cacheFile("/h", "work"), "/h/data/wayfindr-cache-work.json");
  assert.equal(cacheFile("/h", "../x y"), "/h/data/wayfindr-cache-.._x_y.json");
});

test("a broken or foreign file reads as empty", () => {
  for (const text of [null, "", "{", "[]", '{"version":2,"boards":{}}', '{"version":1,"boards":[]}']) {
    assert.deepEqual(parseCache(text), { version: 1, boards: {} });
  }
});

test("a Board round-trips, and only for the same Account and ref", () => {
  const c = parseCache(serializeCache(withBoard(parseCache(null), [team], team, { title: "T" }, 100)));
  assert.deepEqual(cachedBoard(c, team), { at: 100, data: { title: "T" } });
  assert.equal(cachedBoard(c, { ...team, ref: { owner: "o", number: 9 } }), null);
  assert.equal(cachedBoard(c, { ...team, account: "other" }), null);
  assert.equal(cachedBoard(c, ops), null);
});

test("newer data wins, and removed Boards drop out", () => {
  let c = withBoard(parseCache(null), [team, ops], team, "new", 200);
  c = withBoard(c, [team, ops], ops, "o", 50);
  assert.equal(withBoard(c, [team, ops], team, "old", 100).boards.team.data, "new");
  assert.deepEqual(Object.keys(withBoard(c, [ops], ops, "o2", 60).boards), ["ops"]);
});

test("ages", () => {
  assert.equal(formatAge(30_000), "just now");
  assert.equal(formatAge(12 * 60_000), "12m ago");
  assert.equal(formatAge(3 * 3600_000 + 5), "3h ago");
  assert.equal(formatAge(50 * 3600_000), "2d ago");
  assert.equal(formatAge(-5), "just now");
});

test("isShown follows hidden nodes and stack children", () => {
  const tree = (hidden, active) => ({ id: "root", type: "row", children: [
    { id: "main", type: "block" },
    { id: "panel", type: "column", hidden, children: [
      { id: "panel-body", type: "stack", active, children: [{ id: "files", type: "block" }, { id: "wayfindr", type: "block", content: { mod: "wayfindr" } }] }] }] });
  const wf = (n) => n.content?.mod === "wayfindr";
  assert.equal(isShown(tree(false, "wayfindr"), wf), true);
  assert.equal(isShown(tree(true, "wayfindr"), wf), false);
  assert.equal(isShown(tree(false, "files"), wf), false);
  assert.equal(isShown(tree(false, undefined), wf), false); // a stack shows its first child by default
  assert.equal(isShown({ id: "root", children: [] }, wf), true); // not in the layout: a pane or window
});

test("refreshes are due every 30 minutes, or after a minute on show", () => {
  assert.equal(due(null, 0), true);
  assert.equal(due(0, POLL_MS - 1), false);
  assert.equal(due(0, POLL_MS), true);
  assert.equal(due(0, SHOW_GAP_MS, { showing: true }), true);
  assert.equal(due(0, SHOW_GAP_MS - 1, { showing: true }), false);
});
