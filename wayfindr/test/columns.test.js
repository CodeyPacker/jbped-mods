import { test } from "node:test";
import assert from "node:assert/strict";
import { byColumn, trackColumns } from "../mods/wayfindr/providers/contract.js";

const t = (key, columnId, status) => ({ key, columnId, status, assignees: [] });
// Web board: "Active" and "Resolved" share the "Doing" column.
const board = {
  me: null,
  columns: [{ id: "New", name: "New" }, { id: "Doing", name: "Doing" }, { id: "Done", name: "Done" }],
  tickets: [t("1", "New", "New"), t("2", "Doing", "Active"), t("3", "Doing", "Resolved"), t("4", "Done", "Closed"), t("5", "New", null)],
};

test("two states sharing a web-board column become two Columns", () => {
  const groups = byColumn(trackColumns(board, ["Active", "Resolved"]));
  assert.deepEqual(groups.map((g) => [g.column.name, g.tickets.map((x) => x.key)]), [["Active", ["2"]], ["Resolved", ["3"]]]);
});

test("Columns follow the config order, match without case, and hide other states", () => {
  const groups = byColumn(trackColumns(board, ["closed", "New", "Active", "NEW"]));
  assert.deepEqual(groups.map((g) => [g.column.name, g.tickets.map((x) => x.key)]), [["closed", ["4"]], ["New", ["1"]], ["Active", ["2"]]]);
});

test("the cached Board isn't changed", () => {
  trackColumns(board, ["Active"]);
  assert.equal(board.columns.length, 3);
  assert.equal(board.tickets[1].columnId, "Doing");
});
