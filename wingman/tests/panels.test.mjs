import assert from "node:assert/strict";
const P = await import("../mods/wingman/panels.js");

// A fake shared store; records which keys were written.
function store(panels, key) {
  const m = new Map();
  if (panels !== undefined) m.set(P.PANELS, panels);
  if (key !== undefined) m.set(P.PANELS_KEY, key);
  const writes = [];
  return { m, writes, get: (k) => m.get(k), set: (k, v) => { assert.notEqual(v, null, "never setShared(key, null)"); writes.push(k); m.set(k, v); } };
}
const run = (s, want) => P.sync(s.get, s.set, want);
const notHidden = (l) => l.filter((n) => !P.HIDDEN.includes(n));

// every prior list: off -> on -> off gives the list back, and each step is idempotent
const lists = [undefined, ["files", "changes"], ["changes", "files"], ["files"], ["changes"], [], ["x", "files", "y", "changes", "z"], ["a", "b"], ["changes", "x", "files"]];
for (const start of lists) {
  const s = store(start);
  const was = P.listOf(start);
  assert.equal(run(s, false), false, "off with nothing taken writes nothing");
  assert.equal(s.writes.length, 0);
  assert.equal(run(s, true), true);
  assert.deepEqual(P.listOf(s.get(P.PANELS)), notHidden(was));
  assert.equal(s.get(P.PANELS_KEY).on, true);
  const n = s.writes.length;
  assert.equal(run(s, true), false, "on twice: no writes");
  assert.equal(s.writes.length, n);
  assert.equal(run(s, false), true);
  assert.deepEqual(P.listOf(s.get(P.PANELS)), was, `restored from ${JSON.stringify(start)}`);
  assert.equal(s.get(P.PANELS_KEY).on, false);
  const m = s.writes.length;
  assert.equal(run(s, false), false);
  assert.equal(run(s, false), false);
  assert.equal(s.writes.length, m);
  assert.equal(run(s, true), true, "and on again");
  assert.deepEqual(P.listOf(s.get(P.PANELS)), notHidden(was));
}

// entries the person had already removed stay theirs
{
  const s = store(["changes"]);
  run(s, true);
  assert.deepEqual(s.get(P.PANELS_KEY).removed, ["changes"]);
  run(s, false);
  assert.deepEqual(s.get(P.PANELS), ["changes"]);
  const t = store([]);
  run(t, true); run(t, false);
  assert.deepEqual(t.get(P.PANELS), [], "nothing taken, nothing put back");
  assert.equal(t.writes.filter((k) => k === P.PANELS).length, 0, "the list isn't even written");
}

// unset key: the default list is assumed, an explicit list is written
{
  const s = store(undefined);
  run(s, true);
  assert.deepEqual(s.get(P.PANELS), []);
  assert.deepEqual(s.get(P.PANELS_KEY), { on: true, removed: ["files", "changes"], original: ["files", "changes"] });
  run(s, false);
  assert.deepEqual(s.get(P.PANELS), ["files", "changes"]);
}

// order: put back where they were, among what is still there
{
  const s = store(["a", "files", "b", "changes", "c"]);
  run(s, true);
  assert.deepEqual(s.get(P.PANELS), ["a", "b", "c"]);
  run(s, false);
  assert.deepEqual(s.get(P.PANELS), ["a", "files", "b", "changes", "c"]);
  // something else dropped "a" and added "d" meanwhile
  const t = store(["a", "files", "b", "changes", "c"]);
  run(t, true);
  t.m.set(P.PANELS, ["b", "c", "d"]);
  run(t, false);
  assert.deepEqual(t.get(P.PANELS), ["files", "b", "changes", "c", "d"]);
}

// another mod (herdr-nvim) removes or restores "files" in between
{
  // nvim already took "files": Wingman takes only "changes" and puts back only that
  const s = store(["changes"]);
  run(s, true);
  assert.deepEqual(s.get(P.PANELS_KEY).removed, ["changes"]);
  s.m.set(P.PANELS, ["files"]); // nvim puts back what it took
  assert.equal(run(s, true), false, "on again, list changed by another mod: not touched");
  assert.deepEqual(s.get(P.PANELS), ["files"]);
  run(s, false);
  assert.deepEqual(s.get(P.PANELS), ["changes", "files"], "changes goes where the list it came from had it");
  // Wingman took both, nvim then finds "files" gone and takes nothing; Wingman off puts back both
  const t = store(["files", "changes"]);
  run(t, true);
  assert.deepEqual(t.get(P.PANELS), []);
  run(t, false);
  assert.deepEqual(t.get(P.PANELS), ["files", "changes"]);
  // nvim took "files" before Wingman on and off: "files" stays out
  const u = store(["changes"]);
  run(u, true); run(u, false);
  assert.deepEqual(u.get(P.PANELS), ["changes"]);
  // an entry Wingman took was put back by someone else: no duplicate
  const v = store(["files", "changes"]);
  run(v, true);
  v.m.set(P.PANELS, ["files"]);
  run(v, false);
  assert.deepEqual(v.get(P.PANELS), ["files", "changes"]);
}

// three copies at once read the same state: the same writes, and a late copy does nothing
{
  const s = store(["files", "changes", "x"]);
  const reads = [0, 1, 2].map(() => P.plan(s.get(P.PANELS), s.get(P.PANELS_KEY), true));
  assert.deepEqual(reads[0], reads[1]);
  assert.deepEqual(reads[1], reads[2]);
  for (const r of reads) { s.set(P.PANELS_KEY, r.state); if (r.list) s.set(P.PANELS, r.list); }
  assert.deepEqual(s.get(P.PANELS), ["x"]);
  assert.deepEqual(s.get(P.PANELS_KEY).removed, ["files", "changes"]);
  assert.equal(P.plan(s.get(P.PANELS), s.get(P.PANELS_KEY), true), null);
}

// bad stored values are ignored, never thrown on
for (const bad of [null, 5, "x", {}, { on: true }, { on: true, removed: "files", original: [] }]) {
  const s = store(["files"], bad);
  assert.doesNotThrow(() => run(s, false));
  assert.deepEqual(s.get(P.PANELS), ["files"]);
}
{
  const s = store({ not: "a list" });
  run(s, true);
  assert.deepEqual(s.get(P.PANELS), []);
}
