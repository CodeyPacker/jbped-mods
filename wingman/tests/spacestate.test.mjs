// D1: an async result lands in the state of the space it was started for, never in the one shown
// when it ends. Drives spacestate.js the way main.js does: a copy shows one space on its own
// fields and keeps the others in `views` (snapshotView on a switch, restored on the way back).
import assert from "node:assert";
import { stateFor, failIn, loadFailed, loadOk } from "../mods/wingman/spacestate.js";

const copy = { spaceId: "C", error: null, loadError: null, views: new Map() };
const switchTo = (id) => {
  copy.views.set(copy.spaceId, { error: copy.error, loadError: copy.loadError });
  Object.assign(copy, copy.views.get(id) ?? { error: null, loadError: null }, { spaceId: id });
  copy.views.delete(id);
};

// A refresh starts in C (its repo's clean filter fails), and B is shown before git answers.
const started = copy.spaceId;
switchTo("B");
const msg = "git status in repoC: error: external filter 'bad' failed";
loadFailed(copy, started, msg);
assert.equal(copy.error, null, "B shows C's error");
assert.equal(copy.views.get("C").error, msg, "C's kept state holds its own error");

// B's own refreshes succeed: nothing to clear, and B stays clean.
assert.equal(loadOk(copy), false);
assert.equal(copy.error, null);

// Back in C the error shows; once C's status works again, the next good pass takes it away.
switchTo("C");
assert.equal(copy.error, msg);
assert.equal(loadOk(copy), true);
assert.equal(copy.error, null);

// A message of another kind (a user action's) isn't taken away by a good refresh.
loadFailed(copy, "C", msg);
copy.error = "Pick Keep mine or Take agent's first";
assert.equal(loadOk(copy), false);
assert.equal(copy.error, "Pick Keep mine or Take agent's first");
assert.equal(copy.loadError, null);

// An editor launch started in C that fails after the switch to B reports into C.
switchTo("B");
failIn(copy, "C", "code: not found");
assert.equal(copy.error, null);
assert.equal(copy.views.get("C").error, "code: not found");

// A space that's gone takes nothing, and nothing throws.
assert.equal(failIn(copy, "gone", "x"), null);
assert.equal(loadFailed(copy, "gone", "x"), null);
assert.equal(stateFor(copy, "B"), copy);
console.log("spacestate ok");
