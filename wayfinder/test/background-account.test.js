import { test } from "node:test";
import assert from "node:assert/strict";
import { newItems } from "../mods/wayfinder/background.js";

test("an Account new to the list has no baseline, so none of its PRs count as new", () => {
  const pr = { key: "k", id: "r#1", repo: "o/r", title: "T" };
  const prev = [{ account: "a", me: "u", mine: [], needsReview: [] }];
  const next = [...prev, { account: "b", me: "u", mine: [], needsReview: [pr] }];
  assert.deepEqual(newItems({ prevPrs: prev, nextPrs: next, prevBoards: {}, nextBoards: {} }).reviews, []);
  const later = [prev[0], { account: "b", me: "u", mine: [], needsReview: [pr, { ...pr, key: "k2" }] }];
  assert.deepEqual(newItems({ prevPrs: next, nextPrs: later, prevBoards: {}, nextBoards: {} }).reviews.map((r) => r.pr.key), ["k2"]);
});
