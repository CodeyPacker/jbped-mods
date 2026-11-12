import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { writes, writeCalls, reset } from "herdr";
import { loadState, makeSaver, statePath, stateDir } from "../mods/wranglr/store.js";

// Plain data standing in for the model's emptyState().
const empty = () => ({ v: 1, place: {}, started: {}, custom: [], order: { groups: [], spaces: {} }, dismissed: [] });

beforeEach(() => { reset(); rmSync(stateDir(), { recursive: true, force: true }); });

test("an absent file gives the empty state", async () => {
  assert.deepEqual(await loadState(empty()), empty());
});

test("an unreadable file gives the empty state", async () => {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(), "{ not json");
  assert.deepEqual(await loadState(empty()), empty());
});

test("missing and mistyped fields are filled from the empty state", async () => {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify({ v: 1, place: { s1: { group: "", sub: null } }, custom: "oops", order: { groups: ["ws:A"] } }));
  assert.deepEqual(await loadState(empty()), {
    v: 1, place: { s1: { group: "", sub: null } }, started: {}, custom: [], order: { groups: ["ws:A"], spaces: {} }, dismissed: [],
  });
});

test("the first save creates the folder and the file", async () => {
  await loadState(empty());
  const saver = makeSaver();
  saver.save({ ...empty(), dismissed: ["x"] });
  await saver.flush();
  assert.deepEqual(JSON.parse(readFileSync(statePath(), "utf8")).dismissed, ["x"]);
  assert.equal(writeCalls[0].expected, null);
});

test("20 rapid saves end with the last state on disk and writes never overlap", async () => {
  await loadState(empty());
  const saver = makeSaver();
  for (let i = 1; i <= 20; i++) saver.save({ ...empty(), v: i });
  await saver.flush();
  assert.equal(JSON.parse(readFileSync(statePath(), "utf8")).v, 20);
  assert.equal(writes.max, 1);
  assert.ok(writeCalls.length < 20);
  // Each write expects the text the one before it wrote.
  for (let i = 1; i < writeCalls.length; i++) assert.equal(writeCalls[i].expected, writeCalls[i - 1].text);
});

test("an outside change to the file is overwritten after the stale retry", async () => {
  await loadState(empty());
  const saver = makeSaver();
  saver.save({ ...empty(), v: 1 });
  await saver.flush();
  writeFileSync(statePath(), JSON.stringify({ v: 99, outside: true }));
  saver.save({ ...empty(), v: 2 });
  await saver.flush();
  assert.deepEqual(JSON.parse(readFileSync(statePath(), "utf8")), { ...empty(), v: 2 });
  assert.equal(writeCalls.length, 3); // first save, the stale write, the retry
});

test("saving an unchanged state does not write", async () => {
  await loadState(empty());
  const saver = makeSaver();
  saver.save(empty());
  await saver.flush();
  saver.save(empty());
  await saver.flush();
  assert.equal(writeCalls.length, 1);
});
