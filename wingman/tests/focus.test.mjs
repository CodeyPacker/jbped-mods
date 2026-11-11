// keymap.allowedIn (P3): which actions run while what has the keyboard, for keys and Herdr commands alike.
import { ACTIONS, allowedIn } from "../mods/wingman/keymap.js";
import assert from "node:assert/strict";

const FOCUS = ["editor", "tree", "results", "find", "search", "quick", "treeName", "commit", "path"];
// Rows: action; columns in FOCUS order. 1 runs, 0 doesn't.
const TABLE = {
  //                  edit tree res find srch quik name cmt path
  renameItem:        [1, 1, 0, 0, 0, 0, 0, 0, 0],
  deleteItem:        [1, 1, 0, 0, 0, 0, 0, 0, 0],
  moveLineUp:        [1, 0, 0, 0, 0, 0, 0, 0, 0],
  moveLineDown:      [1, 0, 0, 0, 0, 0, 0, 0, 0],
  copyLineUp:        [1, 0, 0, 0, 0, 0, 0, 0, 0],
  deleteLine:        [1, 0, 0, 0, 0, 0, 0, 0, 0],
  joinLines:         [1, 0, 0, 0, 0, 0, 0, 0, 0],
  toggleComment:     [1, 0, 0, 0, 0, 0, 0, 0, 0],
  selectAll:         [1, 0, 0, 0, 0, 0, 0, 0, 0],
  copy:              [1, 0, 0, 0, 0, 0, 0, 0, 0],
  paste:             [1, 0, 0, 0, 0, 0, 0, 0, 0],
  undo:              [1, 0, 1, 0, 0, 0, 0, 0, 0],
  redo:              [1, 0, 1, 0, 0, 0, 0, 0, 0],
  accept:            [1, 0, 1, 0, 0, 0, 0, 0, 0],
  reject:            [1, 0, 1, 0, 0, 0, 0, 0, 0],
  acceptFile:        [1, 0, 1, 0, 0, 0, 0, 0, 0],
  rejectFile:        [1, 0, 1, 0, 0, 0, 0, 0, 0],
  save:              [1, 1, 1, 0, 0, 0, 0, 0, 0],
  quickOpen:         [1, 1, 1, 0, 0, 1, 0, 0, 0],
  toggleTree:        [1, 1, 1, 0, 0, 0, 0, 0, 0],
  toggleView:        [1, 1, 1, 0, 0, 0, 0, 0, 0],
  nextChange:        [1, 1, 1, 0, 0, 0, 0, 0, 0],
  nextFile:          [1, 1, 1, 0, 0, 0, 0, 0, 0],
  comment:           [1, 1, 1, 0, 0, 0, 0, 0, 0],
  openInVSCode:      [1, 1, 1, 0, 0, 0, 0, 0, 0],
  find:              [1, 1, 1, 1, 0, 0, 0, 0, 0],
  replace:           [1, 1, 1, 1, 0, 0, 0, 0, 0],
  goToLine:          [1, 1, 1, 1, 0, 0, 0, 0, 0],
  findNext:          [1, 1, 1, 1, 0, 0, 0, 0, 0],
  searchFiles:       [1, 1, 1, 0, 1, 0, 0, 0, 0],
  findCase:          [1, 0, 0, 1, 1, 0, 0, 0, 0],
  findRegex:         [1, 0, 0, 1, 1, 0, 0, 0, 0],
  replaceAll:        [1, 0, 0, 1, 1, 0, 0, 0, 0],
};
for (const [id, want] of Object.entries(TABLE))
  FOCUS.forEach((focus, i) => assert.equal(allowedIn(id, focus), !!want[i], `${id} while ${focus} has the keyboard`));

// Every action runs in the editor; none while the tree's name box, the commit box or the path box types.
for (const a of ACTIONS) {
  assert.equal(allowedIn(a.id, "editor"), true, a.id);
  for (const box of ["treeName", "commit", "path"]) assert.equal(allowedIn(a.id, box), false, `${a.id} in ${box}`);
  // Nothing that edits text reaches the file from the tree (P9).
  if (a.scope === "edit") assert.equal(allowedIn(a.id, "tree"), false, `${a.id} in tree`);
}
assert.equal(allowedIn("noSuchAction", "editor"), false);
assert.equal(allowedIn("save", "unknown focus"), false);
console.log("focus ok");
