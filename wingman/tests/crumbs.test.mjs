// crumbs: window gating, file naming and cap of the crash breadcrumbs (crumbs.js).
import { world } from "./herdr-shim.mjs";
import { crumb, openCrumbs, resetCrumbs, slotName, inWindow, crumbLine, KEY, CAP, WINDOW_MS, ALIVE_MS } from "../mods/wingman/crumbs.js";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const home = process.env.WINGMAN_TEST_HOME, root = join(home, "data", "wingman-crumbs");
const settle = () => new Promise((r) => setTimeout(r, 150));
const runs = () => (existsSync(root) ? readdirSync(root) : []);

assert.equal(slotName(7), "007.txt");
assert.equal(slotName(399), "399.txt");
assert.ok(inWindow(1000, 1000) && inWindow(1000, 1000 + WINDOW_MS - 1));
assert.ok(!inWindow(1000, 1000 + WINDOW_MS) && !inWindow(1000, 999) && !inWindow(undefined, 5));
assert.match(crumbLine(0, "changes", 3, "x y"), /^1970-01-01T00:00:00\.000Z changes #3 x y\n$/);

// Closed window: nothing written, not even the folder.
world.props = { view: "changes" };
crumb("closed");
await settle();
assert.equal(runs().length, 0);

// Open: crumbs land as numbered files in one folder, in order.
openCrumbs();
crumb("a"); crumb("b", "changes"); crumb("other view", "review"); crumb("c", null, ALIVE_MS);
await settle();
assert.equal(runs().length, 1);
const dir = join(root, runs()[0]);
assert.deepEqual(readdirSync(dir).sort(), ["000.txt", "001.txt", "002.txt"]);
assert.match(readFileSync(join(dir, "001.txt"), "utf8"), / changes #1 b\n$/);

// Another copy of another view sees the shared window and writes its own folder.
resetCrumbs();
world.props = { view: "review" };
crumb("alive review");
await settle();
assert.equal(runs().length, 2);

// An old window writes nothing; the cap stops a run at CAP files.
world.shared.set(KEY, Date.now() - WINDOW_MS - 1000);
const before = runs().length;
crumb("late"); await settle();
assert.equal(runs().length, before);
resetCrumbs(); world.props = { view: "changes" }; openCrumbs();
for (let i = 0; i < CAP + 20; i++) crumb(`n${i}`);
await new Promise((r) => setTimeout(r, 1500));
const big = runs().map((d) => readdirSync(join(root, d)).length).sort((a, b) => b - a)[0];
assert.equal(big, CAP);
console.log("crumbs ok");
