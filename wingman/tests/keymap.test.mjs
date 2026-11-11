import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const K = await import("../mods/wingman/keymap.js");
// defaults: no key used twice within a scope
for (const sc of ["edit", "pane", "find"]) {
  const seen = new Map();
  for (const a of K.ACTIONS.filter((a) => a.scope === sc)) for (const k of a.keys) { assert.ok(!seen.has(k), `${k} twice in ${sc}`); seen.set(k, a.id); }
}
const km = K.resolve({});
assert.equal(K.index(km, "edit").get("ctrl-j"), "joinLines");
let o = K.bind({}, km, "joinLines", "ctrl-l");
assert.deepEqual(o, { joinLines: ["ctrl-j", "ctrl-l"] });
// moving a key from another action
o = K.bind({}, km, "joinLines", "ctrl-y");
assert.deepEqual(o, { accept: [], joinLines: ["ctrl-j", "ctrl-y"] });
assert.deepEqual(K.unbind({}, km, "joinLines", "ctrl-j"), { joinLines: [] });
assert.deepEqual(K.reset(o, "accept"), { joinLines: ["ctrl-j", "ctrl-y"] });
// rebinding back to default cleans up
assert.deepEqual(K.bind({ joinLines: [] }, K.resolve({ joinLines: [] }), "joinLines", "ctrl-j"), {});
assert.equal(K.refused("a"), "types text");
assert.equal(K.refused("shift-a"), "types text");
assert.equal(K.refused("ctrl-left"), "used for moving and editing text");
assert.equal(K.refused("ctrl-shift-l"), null);
assert.equal(K.refused("f5"), null);
assert.equal(K.keyLabel("ctrl-shift-enter"), "ctrl-shift-⏎");
assert.equal(K.keyLabel("ctrl--"), "ctrl--");
// keys.json section editing
const base = '{\n  "global": {\n    "alt-up": "agent.prev",\n    "ctrl-shift-k": "mod.open:picker"\n  },\n  "terminal": { "ctrl-1": "terminal" }\n}\n';
const a1 = K.withModSection(base, { "alt-up": "wingman.moveLineUp" });
assert.deepEqual(JSON.parse(a1)["mod:wingman"], { "alt-up": "wingman.moveLineUp" });
assert.ok(a1.startsWith(base.slice(0, 60)));
assert.equal(K.withModSection(a1, { "alt-up": "wingman.moveLineUp" }), null);
const a2 = K.withModSection(a1, { "ctrl-shift-k": "wingman.deleteLine" });
assert.deepEqual(JSON.parse(a2)["mod:wingman"], { "ctrl-shift-k": "wingman.deleteLine" });
const a3 = K.withModSection(a2, {});
assert.equal(JSON.parse(a3)["mod:wingman"], undefined);
assert.deepEqual(JSON.parse(a3).global, JSON.parse(base).global);
// user entries in the section are kept
const u = '{ "global": {}, "mod:wingman": { "ctrl-q": "app.help" } }';
assert.deepEqual(JSON.parse(K.withModSection(u, { "alt-up": "wingman.moveLineUp" }))["mod:wingman"], { "ctrl-q": "app.help", "alt-up": "wingman.moveLineUp" });
// the real file: what the defaults would claim
const real = JSON.stringify({ global: { "ctrl-q": "app.quit", "alt-up": { command: "x" } } }), g = K.herdrGlobal(real);
const claims = {};
for (const a of K.ACTIONS) for (const k of km.get(a.id)) if (g[k]) claims[k] = `${a.id} (hides ${g[k]})`;
console.log("keymap tests pass; default keys Herdr binds globally:", claims);
