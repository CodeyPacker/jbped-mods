// Runs wingman/install.sh against a throw-away Herdr home (HERDR_APP_HOME), never the real one:
// installs, installs again, uninstalls, and compares the layout with layoutdiff.mjs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { diffLayouts, formatDiff, sameLayout } from "./layoutdiff.mjs";

if (spawnSync("python3", ["--version"]).status !== 0) { console.log("python3 missing: installer test skipped"); process.exit(0); }
const here = dirname(fileURLToPath(import.meta.url));
const installer = join(here, "..", "install.sh");

// Herdr's `main` layout, as the app writes it (pretty JSON, 2 spaces).
const mainLayout = () => ({
  id: "root", type: "row", titlebar: "none", background: "canvas", divider: { width: 1, color: "border" },
  children: [
    { id: "sidebar", type: "column", size: { px: 268 }, min: 44, max: 480, children: [
      { id: "spaces", type: "block", content: { mod: "spaces" }, size: { weight: 1 } },
    ] },
    { id: "work", type: "column", children: [
      { id: "tabs", type: "block", content: { mod: "tabs" }, size: { px: 42 }, window_drag: true },
      { id: "work-body", type: "row", padding: 8, gap: 8, children: [
        { id: "main", type: "block" },
        { id: "panel", type: "column", hidden: true, size: { px: 368 }, min: 280, max: 900, children: [
          { id: "panel-body", type: "stack", active: "files", children: [
            { id: "files", type: "block", content: { mod: "files" } },
            { id: "changes", type: "block", content: { mod: "changes" } },
          ] },
        ] },
      ] },
      { id: "status", type: "block", content: { mod: "workspace-status" }, size: { px: 28 } },
    ] },
  ],
});
const pretty = (o, nl = "\n") => (JSON.stringify(o, null, 2) + "\n").replace(/\n/g, nl);
const read = (p) => readFileSync(p, "utf8");
const json = (p) => JSON.parse(read(p));

function makeHome(tag) {
  const root = mkdtempSync(join(tmpdir(), `wingman-inst-${tag}-`));
  const home = join(root, "home");
  for (const d of ["mods", "layouts", "data/wingman"]) mkdirSync(join(home, d), { recursive: true });
  const log = join(root, "app-calls.txt");
  const bin = join(root, "fake-herdr-app");
  writeFileSync(bin, `#!/bin/sh\necho "$HERDR_APP_HOME $*" >> '${log}'\n`);
  chmodSync(bin, 0o755);
  return { root, home, log, bin };
}
function run(h, action, ...args) {
  return execFileSync("sh", [installer, action, "--no-hook", ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: h.root, HERDR_APP_HOME: h.home, CLAUDE_CONFIG_DIR: join(h.root, "claude"), HERDR_APP_BIN: h.bin },
  });
}
const expectDiff = (before, after, want, what) => {
  const d = diffLayouts(before, after);
  assert.deepEqual(d, want, `${what}:\n${formatDiff(d)}`);
};

// What install does to a layout: three blocks added, the tabs block switched, the panel's max raised.
const FOOTPRINT = {
  changed: [
    { id: "panel", fields: ["max"] },
    { id: "tabs", fields: ["content.mod", "content.props"] },
  ],
  added: ["wingman-changes", "wingman-edit", "wingman-review"],
  removed: [],
};
const KEYS = { global: { "alt-up": "agent.prev" }, "mod:wingman": { "alt-up": "wingman.moveLineUp", "ctrl-q": "other.thing" }, terminal: { "ctrl-1": "terminal" } };
const KEYS_AFTER = { global: { "alt-up": "agent.prev" }, "mod:wingman": { "ctrl-q": "other.thing" }, terminal: { "ctrl-1": "terminal" } };

// 1. The person's own layout, canonical bytes (CRLF like Herdr's files on Windows): byte-for-byte back.
for (const nl of ["\n", "\r\n"]) {
  const h = makeHome("own");
  try {
    const file = join(h.home, "layouts", "mine.json"), original = pretty(mainLayout(), nl);
    writeFileSync(file, original);
    writeFileSync(join(h.home, "shared.json"), JSON.stringify({ layout: "mine", "workspace.panels": ["changes"], "wingman.panelsHidden": { on: true, removed: ["files"], original: ["files", "changes"] } }));
    writeFileSync(join(h.home, "data/wingman/settings.json"), JSON.stringify({ autosave: true, hideHerdrPanels: true }, null, 2) + "\n");
    writeFileSync(join(h.home, "keys.json"), pretty(KEYS));
    const keysBefore = read(join(h.home, "keys.json"));

    run(h, "install");
    const installed = read(file);
    expectDiff(JSON.parse(original), JSON.parse(installed), FOOTPRINT, "install footprint");
    const lay = json(file);
    const body = lay.children[1].children[1].children[1].children[0];
    assert.deepEqual(body.children.slice(2).map((c) => c.content.props), [
      { view: "review", added: true, max_was: 900 }, { view: "edit", added: true }, { view: "changes", added: true },
    ]);
    assert.deepEqual(lay.children[1].children[0].content, { mod: "tabs-plus", props: { replaces: "tabs" } });
    assert.equal(read(join(h.home, "keys.json")), keysBefore, "install leaves keys.json alone");
    assert.ok(existsSync(join(h.home, "mods/wingman")) && existsSync(join(h.home, "mods/tabs-plus")));
    assert.equal(readdirSync(join(h.home, "layouts")).filter((f) => f.endsWith(".json")).join(), "mine.json");

    const out = run(h, "install");
    assert.equal(read(file), installed, "second install changes nothing");
    assert.match(out, /already patched/);
    assert.equal(readdirSync(join(h.home, "layouts")).filter((f) => f.includes(".bak")).length, 1, "no backup for a run that changed nothing");

    run(h, "uninstall");
    assert.equal(read(file), original, `uninstall restores the layout byte for byte (${JSON.stringify(nl)})`);
    assert.ok(sameLayout(diffLayouts(JSON.parse(original), json(file))));
    assert.ok(!existsSync(join(h.home, "mods/wingman")) && !existsSync(join(h.home, "mods/tabs-plus")));
    assert.deepEqual(json(join(h.home, "keys.json")), KEYS_AFTER, "only Wingman's bindings are gone");
    assert.ok(!/"wingman\./.test(read(join(h.home, "keys.json"))), "no Wingman binding left");
    const shared = json(join(h.home, "shared.json"));
    assert.deepEqual(shared["workspace.panels"], ["files", "changes"], "Files is back, in its old place");
    assert.equal(shared["wingman.panelsHidden"].on, false);
    assert.equal(json(join(h.home, "data/wingman/settings.json")).hideHerdrPanels, false);
    assert.equal(json(join(h.home, "data/wingman/settings.json")).autosave, true);
    const again = run(h, "uninstall");
    assert.equal(read(file), original);
    assert.match(again, /no layout had Wingman's blocks/);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
}

// 2. A layout formatted another way: the nodes come back exactly (the bytes too, as the file's style is kept).
{
  const h = makeHome("odd");
  try {
    const file = join(h.home, "layouts", "odd.json");
    const original = JSON.stringify(mainLayout(), null, "\t") + "\n";
    writeFileSync(file, original);
    writeFileSync(join(h.home, "shared.json"), JSON.stringify({ layout: "odd" }));
    run(h, "install");
    assert.ok(!sameLayout(diffLayouts(JSON.parse(original), json(file))));
    run(h, "uninstall");
    assert.ok(sameLayout(diffLayouts(JSON.parse(original), json(file))), "node for node");
    assert.deepEqual(json(file), JSON.parse(original));
    assert.equal(read(file), original);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
}

// 3. One of Herdr's own layouts (installed.json lists layout:main): it is never edited. The install
//    copies it once to main-copy, edits the copy and switches to it. Uninstall edits only the copy.
{
  const h = makeHome("shipped");
  try {
    const mainFile = join(h.home, "layouts", "main.json"), original = pretty(mainLayout());
    writeFileSync(mainFile, original);
    writeFileSync(join(h.home, "installed.json"), JSON.stringify({ "layout:main": { json: "d25b961ea961fba1" } }));
    writeFileSync(join(h.home, "shared.json"), JSON.stringify({ layout: "main" }));
    writeFileSync(join(h.home, "keys.json"), pretty({ global: { "alt-up": "agent.prev" }, "mod:wingman": { "alt-up": "wingman.moveLineUp" } }));
    run(h, "install");
    assert.equal(read(mainFile), original, "Herdr's layout is untouched");
    const copy = join(h.home, "layouts", "main-copy.json");
    assert.ok(existsSync(copy));
    const d = diffLayouts(JSON.parse(original), json(copy));
    assert.deepEqual(d.added, FOOTPRINT.added);
    assert.deepEqual(d.changed, [{ id: "panel", fields: ["max"] }, { id: "root", fields: ["cloned_from"] }, { id: "tabs", fields: FOOTPRINT.changed[1].fields }]);
    assert.equal(json(copy).cloned_from.name, "main");
    assert.match(read(h.log), /layout\.switch \{"name":"main-copy"\}/, "switched to the copy");
    const first = read(copy);
    run(h, "install");
    assert.equal(read(copy), first, "second install: no further change");
    assert.deepEqual(readdirSync(join(h.home, "layouts")).sort(), ["main-copy.json", "main.json"]);
    // The person switches to the copy; uninstall takes Wingman out of it and leaves the copy theirs.
    writeFileSync(join(h.home, "shared.json"), JSON.stringify({ layout: "main-copy" }));
    run(h, "uninstall");
    assert.equal(read(mainFile), original);
    const d2 = diffLayouts(JSON.parse(original), json(copy));
    assert.deepEqual(d2, { changed: [{ id: "root", fields: ["cloned_from"] }], added: [], removed: [] }, "only the clone's own cloned_from is left");
    assert.ok(!/"wingman\./.test(read(join(h.home, "keys.json"))));
    assert.deepEqual(json(join(h.home, "keys.json")), { global: { "alt-up": "agent.prev" } });
  } finally { rmSync(h.root, { recursive: true, force: true }); }
}

// 4. A key someone else holds in the mod:wingman section is never overwritten or removed.
{
  const h = makeHome("keys");
  try {
    writeFileSync(join(h.home, "keys.json"), pretty({ "mod:wingman": { "alt-up": { command: "layout.resize", args: { id: "panel", px: 300 } }, "ctrl-j": "wingman.joinLines" } }));
    writeFileSync(join(h.home, "shared.json"), JSON.stringify({}));
    run(h, "uninstall");
    assert.deepEqual(json(join(h.home, "keys.json")), { "mod:wingman": { "alt-up": { command: "layout.resize", args: { id: "panel", px: 300 } } } });
  } finally { rmSync(h.root, { recursive: true, force: true }); }
}

// 5. The diff tool itself.
{
  const a = mainLayout(), b = mainLayout();
  b.children[0].size.px = 300;
  b.children[1].children.push({ id: "extra", type: "block" });
  b.children[1].children.splice(2, 1);
  const d = diffLayouts(a, b);
  assert.deepEqual(d, { changed: [{ id: "sidebar", fields: ["size.px"] }], added: ["extra"], removed: ["status"] });
  b.floating = [{ id: "fl", content: { mod: "x" } }];
  assert.deepEqual(diffLayouts(a, b).added, ["extra", "fl"]);
  assert.ok(sameLayout(diffLayouts(a, mainLayout())));
}
