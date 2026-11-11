import assert from "node:assert/strict";
const Q = await import("../mods/wingman/quickopen.js");
const files = ["src/main.js", "src/model.js", "README.md", "src/components/MainView.vue", "docs/maintenance.md", "wingman/mods/wingman/main.js", "test/main.test.js"].map((rel) => ({ rel }));
const top = (q) => Q.rank(files, q).map((r) => r.rel);
assert.equal(top("main")[0], "src/main.js");
assert.equal(top("mv")[0], "src/components/MainView.vue");
assert.equal(top("wmm")[0], "wingman/mods/wingman/main.js");
assert.deepEqual(top("zzz"), []);
assert.equal(Q.fuzzy("abc", "xaxbxc").pos.join(), "1,3,5");
assert.equal(Q.fuzzy("", "x").score, 0);
assert.deepEqual(Q.parseQuery("main.js:12"), { name: "main.js", at: { line: 11, col: 0 } });
assert.deepEqual(Q.parseQuery("main:12:4"), { name: "main", at: { line: 11, col: 3 } });
assert.deepEqual(Q.parseQuery(":7"), { name: "", at: { line: 6, col: 0 } });
assert.deepEqual(Q.parseQuery("readme"), { name: "readme", at: null });
// speed: 20k paths
const big = Array.from({ length: 20000 }, (_, i) => ({ rel: `packages/pkg${i % 200}/src/components/Widget${i}.tsx` }));
const t0 = performance.now(); Q.rank(big, "pkg12wid"); const ms = performance.now() - t0;
console.log("quickopen tests pass;", Math.round(ms), "ms for 20k paths");
