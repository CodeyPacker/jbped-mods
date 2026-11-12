import { test } from "node:test";
import assert from "node:assert/strict";
import { newItems, toastsFor, oneLine } from "../mods/wayfindr/background.js";

const pr = (n, title = `PR ${n}`) => ({ key: `k${n}`, id: `r#${n}`, repo: "o/r", title });
const acct = (needsReview = [], mine = [], account = "a") => ({ account, me: "u", mine, needsReview, more: { mine: 0, needsReview: 0 } });
const t = (key, assignees = []) => ({ key, id: `#${key}`, title: `Ticket ${key}`, columnId: "c", assignees: assignees.map((id) => ({ id, name: id })) });
const board = (tickets, me = "u") => ({ title: "B", url: "", me, columns: [{ id: "c", name: "C" }], tickets });

test("no previous Pull Requests means no baseline and no reviews", () => {
  assert.deepEqual(newItems({ prevPrs: null, nextPrs: [acct([pr(1)])], prevBoards: {}, nextBoards: {} }).reviews, []);
});

test("a Pull Request newly in needsReview counts; one already there or moved from mine doesn't", () => {
  const prev = [acct([pr(1)], [pr(2)])];
  const next = [acct([pr(1), pr(2), pr(3)])];
  assert.deepEqual(newItems({ prevPrs: prev, nextPrs: next, prevBoards: {}, nextBoards: {} }).reviews, [{ account: "a", pr: pr(3) }]);
});

test("an Account with an error in either list contributes nothing", () => {
  const err = { account: "a", error: "boom" };
  const next = [acct([pr(1)]), acct([pr(2)], [], "b")];
  const prev = [err, acct([], [], "b")];
  assert.deepEqual(newItems({ prevPrs: prev, nextPrs: next, prevBoards: {}, nextBoards: {} }).reviews, [{ account: "b", pr: pr(2) }]);
  assert.deepEqual(newItems({ prevPrs: [acct()], nextPrs: [err], prevBoards: {}, nextBoards: {} }).reviews, []);
});

test("Tickets newly assigned count, including one reassigned away and back; a Board without previous data doesn't", () => {
  const prevBoards = { b1: board([t("1", ["u"]), t("2"), t("3", ["x"])]), b2: null };
  const mid = { b1: board([t("1", ["x"]), t("2"), t("3", ["x"])]) };
  const nextBoards = { b1: board([t("1", ["u"]), t("2", ["u"]), t("3", ["x"]), t("4", ["u", "x"])]), b2: board([t("9", ["u"])]), b3: board([t("8", ["u"])]) };
  assert.deepEqual(newItems({ prevPrs: null, nextPrs: [], prevBoards, nextBoards }).assigned.map((x) => [x.boardId, x.ticket.key]), [["b1", "2"], ["b1", "4"]]);
  // Assigned away, then back: counts again.
  assert.deepEqual(newItems({ prevPrs: null, nextPrs: [], prevBoards: mid, nextBoards: { b1: board([t("1", ["u"])]) } }).assigned.map((x) => x.ticket.key), ["1"]);
  // Unknown me: nothing is mine.
  assert.deepEqual(newItems({ prevPrs: null, nextPrs: [], prevBoards: { b1: board([]) }, nextBoards: { b1: board([t("1", ["u"])], null) } }).assigned, []);
});

test("toasts: one each up to the cap, then a count", () => {
  const reviews = Array.from({ length: 7 }, (_, i) => ({ account: "a", pr: pr(i + 1) }));
  const assigned = [...Array.from({ length: 6 }, (_, i) => ({ boardId: "b1", ticket: t(String(i + 1)) }))];
  const out = toastsFor({ reviews, assigned });
  assert.equal(out.length, 12);
  assert.deepEqual(out[0], { title: "Review requested", body: "o/r r#1: PR 1", view: "prs", boardId: null });
  assert.deepEqual(out[5], { title: "Review requested", body: "2 more Pull Requests ask for your review", view: "prs", boardId: null });
  assert.deepEqual(out[6], { title: "Assigned to you", body: "#1 Ticket 1", view: "board", boardId: "b1" });
  assert.deepEqual(out[11], { title: "Assigned to you", body: "1 more Tickets were assigned to you", view: "board", boardId: "b1" });
  assert.deepEqual(toastsFor({ reviews: reviews.slice(0, 2), assigned: [] }, { maxEach: 1 }).map((x) => x.body), ["o/r r#1: PR 1", "1 more Pull Requests ask for your review"]);
  assert.deepEqual(toastsFor({ reviews: [], assigned: [] }), []);
});

test("titles collapse to one line and cut at 80 characters with an ellipsis", () => {
  assert.equal(oneLine("a\n  b\tc "), "a b c");
  const long = "x".repeat(100);
  assert.equal(oneLine(long).length, 80);
  assert.ok(oneLine(long).endsWith("…"));
  assert.equal(oneLine("y".repeat(80)), "y".repeat(80));
  assert.equal(toastsFor({ reviews: [{ account: "a", pr: pr(1, `line one\nline two ${long}`) }], assigned: [] })[0].body, `o/r r#1: ${oneLine(`line one line two ${long}`)}`);
});
