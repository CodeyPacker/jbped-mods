// store: settings defaults and errors, state round trip, the 20 Repo limit, one writer.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { writes, writeCalls, reset } from "herdr";
import { loadSettings, loadState, makeSaver, emptyState, trimLast, settingsPath, statePath, stateDir } from "../mods/gitr/store.js";

beforeEach(() => { reset(); rmSync(stateDir(), { recursive: true, force: true }); rmSync(settingsPath(), { force: true }); });

const D = { enter: "worktree", run: null };
const putSettings = (v) => writeFileSync(settingsPath(), typeof v === "string" ? v : JSON.stringify(v));
const putState = (v) => { mkdirSync(stateDir(), { recursive: true }); writeFileSync(statePath(), typeof v === "string" ? v : JSON.stringify(v)); };

test("a missing settings file gives the defaults and no errors", async () => {
  assert.deepEqual(await loadSettings(), { settings: D, errors: [] });
});

test("valid settings are read", async () => {
  putSettings({ enter: "checkout", run: ["pwsh", "-NoLogo"] });
  assert.deepEqual(await loadSettings(), { settings: { enter: "checkout", run: ["pwsh", "-NoLogo"] }, errors: [] });
});

test("an invalid JSON file gives the defaults and one error", async () => {
  putSettings("{ nope");
  const r = await loadSettings();
  assert.deepEqual(r.settings, D);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /not valid JSON/);
});

test("a file that is not an object gives the defaults and an error", async () => {
  putSettings("[1]");
  const r = await loadSettings();
  assert.deepEqual(r.settings, D);
  assert.equal(r.errors.length, 1);
});

test("a bad value falls back to its default, a good one beside it is kept, each bad one is listed", async () => {
  putSettings({ enter: "sideways", run: ["ok", 3] });
  let r = await loadSettings();
  assert.deepEqual(r.settings, D);
  assert.equal(r.errors.length, 2);
  putSettings({ enter: "checkout", run: "pwsh" });
  r = await loadSettings();
  assert.deepEqual(r.settings, { enter: "checkout", run: null });
  assert.equal(r.errors.length, 1);
  putSettings({ run: [] });
  assert.equal((await loadSettings()).errors.length, 1);
});

test("run: null is valid and unknown keys are ignored", async () => {
  putSettings({ run: null, future: 1 });
  assert.deepEqual(await loadSettings(), { settings: D, errors: [] });
});

test("an absent state file gives the empty state", async () => {
  assert.deepEqual(await loadState(), { sort: "recent", remotesOpen: false, last: {} });
});

test("an unreadable state file gives the empty state", async () => {
  putState("{ not json");
  assert.deepEqual(await loadState(), emptyState());
});

test("missing and mistyped state fields are filled from the defaults", async () => {
  putState({ sort: "sideways", remotesOpen: "yes", last: { "\0r": { at: 5, main: "/m" }, bad: 7 } });
  assert.deepEqual(await loadState(), { sort: "recent", remotesOpen: false, last: { "\0r": { at: 5, main: "/m" } } });
});

test("a state round trips through save and load", async () => {
  await loadState();
  const saver = makeSaver();
  const state = { sort: "az", remotesOpen: true, last: { "\0github.com/o/r": { main: "/dev/r", at: 100, branches: [{ name: "a" }] }, "box\0github.com/o/r": { main: "/home/r", at: 200 } } };
  saver.save(state);
  await saver.flush();
  assert.equal(writeCalls[0].expected, null);
  assert.deepEqual(await loadState(), state);
});

test("last keeps at most 20 Repos and drops the oldest by at", async () => {
  await loadState();
  const last = {};
  for (let i = 1; i <= 25; i++) last[`\0r${i}`] = { at: i * 10 };
  const saver = makeSaver();
  saver.save({ ...emptyState(), last });
  await saver.flush();
  const onDisk = JSON.parse(readFileSync(statePath(), "utf8")).last;
  const keys = Object.keys(onDisk);
  assert.equal(keys.length, 20);
  for (let i = 1; i <= 5; i++) assert.equal(`\0r${i}` in onDisk, false);
  assert.equal("\0r6" in onDisk, true);
  assert.equal("\0r25" in onDisk, true);
});

test("trimLast keeps everything at or under the limit and the newest above it", () => {
  assert.deepEqual(trimLast({ a: { at: 1 }, b: { at: 2 } }), { a: { at: 1 }, b: { at: 2 } });
  assert.deepEqual(Object.keys(trimLast({ a: { at: 1 }, b: { at: 3 }, c: { at: 2 } }, 2)).sort(), ["b", "c"]);
});

test("20 rapid saves end with the last state on disk and writes never overlap", async () => {
  await loadState();
  const saver = makeSaver();
  for (let i = 1; i <= 20; i++) saver.save({ ...emptyState(), sort: i % 2 ? "az" : "recent", remotesOpen: i === 20 });
  await saver.flush();
  assert.deepEqual(JSON.parse(readFileSync(statePath(), "utf8")).remotesOpen, true);
  assert.equal(writes.max, 1);
  assert.ok(writeCalls.length < 20);
  for (let i = 1; i < writeCalls.length; i++) assert.equal(writeCalls[i].expected, writeCalls[i - 1].text);
});

test("an outside change to the file is overwritten after the stale retry", async () => {
  await loadState();
  const saver = makeSaver();
  saver.save({ ...emptyState(), sort: "az" });
  await saver.flush();
  writeFileSync(statePath(), JSON.stringify({ outside: true }));
  saver.save({ ...emptyState(), remotesOpen: true });
  await saver.flush();
  assert.deepEqual(JSON.parse(readFileSync(statePath(), "utf8")), { ...emptyState(), remotesOpen: true });
  assert.equal(writeCalls.length, 3);
});

test("saving an unchanged state does not write", async () => {
  await loadState();
  const saver = makeSaver();
  saver.save(emptyState());
  await saver.flush();
  saver.save(emptyState());
  await saver.flush();
  assert.equal(writeCalls.length, 1);
});
