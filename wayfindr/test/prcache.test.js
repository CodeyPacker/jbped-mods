import { test } from "node:test";
import assert from "node:assert/strict";
import { PR_CACHE_DIR, prCacheFile, parsePrCache, serializePrCache, detailStale, prunePrKeys } from "../mods/wayfindr/prcache.js";

const POLL = 30 * 60 * 1000;
const SHA1 = "a".repeat(40), SHA2 = "b".repeat(40);
const gh = { key: "PR_1", id: "web#12", repo: "o/web", head: SHA1, updatedAt: "2026-11-01T00:00:00Z" };
const az = { key: "r-web!7", id: "web!7", repo: "My Proj/web", head: SHA1, updatedAt: null };

test("one file per PR under data/wayfindr/prs, named like its viewed marks", () => {
  assert.equal(PR_CACHE_DIR, "data/wayfindr/prs");
  assert.equal(prCacheFile("/h", gh), "/h/data/wayfindr/prs/o_web-pr-12.json");
  assert.equal(prCacheFile("/h", az), "/h/data/wayfindr/prs/My_Proj_web-pr-7.json");
});

test("a detail round-trips with its time, source and gitError", () => {
  const data = { key: "PR_1", head: SHA1, files: [{ path: "a.js", patch: "@@ -1 +1 @@" }], source: { kind: "api" }, gitError: "no clone" };
  assert.deepEqual(parsePrCache(serializePrCache("PR_1", 100, data), "PR_1"), { at: 100, data });
});

test("a broken file, another version or another PR's key reads as no cached copy", () => {
  const text = serializePrCache("PR_1", 100, { head: SHA1 });
  assert.equal(parsePrCache(text, "PR_2"), null);
  for (const t of [null, "", "{", "[]", JSON.stringify({ version: 2, key: "PR_1", at: 1, data: {} }), JSON.stringify({ version: 1, key: "PR_1", at: "1", data: {} }), JSON.stringify({ version: 1, key: "PR_1", at: 1, data: null })]) {
    assert.equal(parsePrCache(t, "PR_1"), null);
  }
});

test("no cached copy is stale", () => {
  assert.equal(detailStale(null, gh, 1000, POLL), true);
  assert.equal(detailStale({ at: 1000, data: null }, gh, 1000, POLL), true);
});

test("a copy older than the poll interval is stale, one at it is not", () => {
  const cached = { at: 0, data: { head: SHA1, updatedAt: gh.updatedAt } };
  assert.equal(detailStale(cached, gh, POLL, POLL), false);
  assert.equal(detailStale(cached, gh, POLL + 1, POLL), true);
});

test("a new head in the list is stale", () => {
  const cached = { at: 0, data: { head: SHA1, updatedAt: gh.updatedAt } };
  assert.equal(detailStale(cached, { ...gh, head: SHA2 }, 10, POLL), true);
  assert.equal(detailStale(cached, gh, 10, POLL), false);
});

test("a new updated time in the list is stale", () => {
  const cached = { at: 0, data: { head: SHA1, updatedAt: gh.updatedAt } };
  assert.equal(detailStale(cached, { ...gh, updatedAt: "2026-11-02T00:00:00Z" }, 10, POLL), true);
});

test("a null head or updated time in the list says nothing (Azure has no updated time)", () => {
  const cached = { at: 0, data: { head: SHA1, updatedAt: null } };
  assert.equal(detailStale(cached, az, 10, POLL), false);
  assert.equal(detailStale(cached, { ...az, head: null }, 10, POLL), false);
  assert.equal(detailStale({ at: 0, data: { head: SHA2, updatedAt: null } }, { ...az, head: null }, 10, POLL), false);
});

test("prune names the files of PRs no longer listed, and leaves stray names alone", () => {
  const files = ["o_web-pr-12.json", "My_Proj_web-pr-7.json", "o_web-pr-9.json", "notes.txt", ".tmp"];
  assert.deepEqual(prunePrKeys(files, [gh, az]), ["o_web-pr-9.json"]);
  assert.deepEqual(prunePrKeys(files, []), ["o_web-pr-12.json", "My_Proj_web-pr-7.json", "o_web-pr-9.json"]);
  assert.deepEqual(prunePrKeys([], [gh]), []);
});
