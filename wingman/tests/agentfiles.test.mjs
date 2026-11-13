// The Agent files list and Review's backfill note (agentfiles.js), with synthetic results.
import assert from "node:assert/strict";
import { mergeResults, markOf, relTime, listRows, unrecorded, backfillText, headLine, wants } from "../mods/wingman/agentfiles.js";

// Two agents' files as one list, newest first.
const merged = mergeResults([
  { files: [{ path: "C:/r/a.ts", read: true, edited: false, created: false, lastAt: 10 }, { path: "C:/r/b.ts", read: false, edited: true, created: true, lastAt: 5 }] },
  { files: [{ path: "C:/r/a.ts", read: false, edited: true, created: false, lastAt: 20 }] },
  null,
]);
assert.deepEqual(merged, [
  { path: "C:/r/a.ts", read: true, edited: true, created: false, lastAt: 20 },
  { path: "C:/r/b.ts", read: false, edited: true, created: true, lastAt: 5 },
]);
assert.equal(markOf(merged[0]), "edited");
assert.equal(markOf(merged[1]), "new");
assert.equal(markOf({ read: true }), "read");

assert.equal(relTime(null), "");
assert.equal(relTime(1000, 2000), "now");
assert.equal(relTime(0, 42000), "42s");
assert.equal(relTime(0, 5 * 60000), "5m");
assert.equal(relTime(0, 3 * 3600000), "3h");
assert.equal(relTime(0, 2 * 86400000), "2d");

// Rows: relative to the deepest root (Windows drive paths without case), outside files kept but not openable.
const repo = { root: "C:/r", on: null }, inner = { root: "C:/r/sub", on: null }, plain = { root: "C:/notes", on: null, plain: true };
const rows = listRows([
  { path: "c:/R/sub/x.ts", edited: true, lastAt: 3 }, { path: "C:/r/a.ts", read: true, lastAt: 2 }, { path: "C:/notes/n.md", edited: true, lastAt: 1 }, { path: "D:/else/z.ts", read: true, lastAt: 0 },
], [repo, inner, plain]);
assert.deepEqual(rows.map((r) => [r.key, r.rel, r.mark]), [
  ["C:/r/sub|x.ts", "x.ts", "edited"], ["C:/r|a.ts", "a.ts", "read"], ["C:/notes|n.md", "n.md", "edited"], ["x|D:/else/z.ts", "D:/else/z.ts", "read"],
]);
assert.equal(rows[3].store, null);
assert.equal(listRows(Array.from({ length: 10 }, (_, i) => ({ path: `C:/r/${i}` })), [repo], null, undefined, 3).length, 3);
// Another machine's roots only match that machine's paths.
assert.equal(listRows([{ path: "/srv/a" }], [{ root: "/srv", on: "box" }], null)[0].store, null);
assert.equal(listRows([{ path: "/srv/a" }], [{ root: "/srv", on: "box" }], "box")[0].rel, "a");

// Backfill: edited, in a repo, not in Review, still changed in git.
const dirty = new Map([[repo, new Set(["a.ts", "c.ts"])], [inner, new Set()]]);
const back = listRows([
  { path: "C:/r/a.ts", edited: true }, { path: "C:/r/b.ts", edited: true }, { path: "C:/r/c.ts", edited: true }, { path: "C:/r/d.ts", read: true },
  { path: "C:/r/sub/x.ts", edited: true }, { path: "C:/notes/n.md", edited: true },
], [repo, inner, plain]);
assert.deepEqual(unrecorded(back, new Set(["C:/r|c.ts"]), (st) => dirty.get(st)).map((r) => r.rel), ["a.ts"]);
assert.equal(backfillText(0), null);
assert.equal(backfillText(1), "1 file was edited by the agent without the hook; they appear under Changes");
assert.equal(backfillText(3), "3 files were edited by the agent without the hook; they appear under Changes");

assert.equal(headLine({ enabled: false }), "The session log source is off (⚙ Settings)");
assert.equal(headLine({ agents: 0 }), "No Claude agent in this space");
assert.equal(headLine({ agents: 1, results: [{ log: null }] }), "no session log found yet");
assert.equal(headLine({ agents: 2, results: [{ log: "/l", ambiguous: true, partial: true }] }), "several Claudes share this folder: showing the newest log · long log: its last part only");
assert.equal(headLine({ agents: 1, results: [{ log: "/l" }] }), "");

// When a copy reads: the setting on, a space, on screen, and the list or Review shown.
const base = { enabled: true, space: "s1", mode: "edit", left: "agent", column: true, visible: true };
assert.equal(wants(base), "edit");
assert.equal(wants({ ...base, left: "explorer" }), null);
assert.equal(wants({ ...base, column: false }), null);
assert.equal(wants({ ...base, mode: "review" }), "review");
assert.equal(wants({ ...base, mode: "changes" }), null);
assert.equal(wants({ ...base, visible: false }), null);
assert.equal(wants({ ...base, enabled: false }), null);
assert.equal(wants({ ...base, space: null }), null);
console.log("agentfiles ok");
