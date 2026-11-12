import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fake, reset } from "herdr";
import { parseConfig, loadConfig, saveSetting, configPath, DEFAULT_SETTINGS } from "../mods/wranglr/config.js";

beforeEach(() => { reset(); rmSync(configPath(), { force: true }); });

test("a missing file is the defaults with no Workspaces", async () => {
  const { config, errors, text } = await loadConfig();
  assert.equal(text, null);
  assert.deepEqual(errors, []);
  assert.deepEqual(config, { settings: DEFAULT_SETTINGS, workspaces: [], repos: {} });
  assert.deepEqual(parseConfig("").config, config);
  assert.deepEqual(parseConfig(null).config, config);
});

test("invalid JSON gives the defaults and one error", () => {
  const { config, errors } = parseConfig("{ nope");
  assert.equal(errors.length, 1);
  assert.deepEqual(config.settings, DEFAULT_SETTINGS);
  assert.deepEqual(config.workspaces, []);
});

test("an invalid sort, plus or ticket falls back and is named", () => {
  const { config, errors } = parseConfig(JSON.stringify({ settings: { sort: "size", plus: "clone", ticket: "(unclosed", autoname: false } }));
  assert.equal(config.settings.sort, "kind");
  assert.equal(config.settings.plus, "open");
  assert.equal(config.settings.ticket, DEFAULT_SETTINGS.ticket);
  assert.equal(config.settings.autoname, false);
  assert.equal(errors.length, 3);
  assert.ok(errors.some((e) => e.includes("sort")) && errors.some((e) => e.includes("plus")) && errors.some((e) => e.includes("ticket")));
});

test("a Workspace with no name or a duplicate name is dropped and named", () => {
  const { config, errors } = parseConfig(JSON.stringify({ workspaces: [
    { name: "Arden", repos: ["a", 3, "b"], machines: ["wsl", ""], on: { wsl: { home: "/w" } } },
    { repos: ["c"] },
    { name: "Arden", repos: ["d"] },
  ] }));
  assert.deepEqual(config.workspaces, [{ name: "Arden", repos: ["a", "b"], machines: ["wsl", ""], on: { wsl: { home: "/w" } } }]);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes("no name")) && errors.some((e) => e.includes("duplicate")));
});

test("unknown keys are kept by parseConfig", () => {
  const { config } = parseConfig(JSON.stringify({ extra: 1, settings: { mine: true } }));
  assert.equal(config.extra, 1);
  assert.equal(config.settings.mine, true);
});

test("saveSetting writes the setting and keeps every other key", async () => {
  const before = { "//": "mine", settings: { sort: "az", other: [1] }, workspaces: [{ name: "W", repos: [], future: "x" }], top: { a: 1 } };
  writeFileSync(configPath(), JSON.stringify(before));
  await saveSetting("sort", "recent");
  const text = readFileSync(configPath(), "utf8");
  assert.ok(text.endsWith("}\n"));
  assert.equal(text, JSON.stringify({ ...before, settings: { sort: "recent", other: [1] } }, null, 2) + "\n");
});

test("saveSetting creates the file when it is absent", async () => {
  await saveSetting("autoname", false);
  assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")), { settings: { autoname: false } });
});

test("a hand edit made between read and write is not lost", async () => {
  writeFileSync(configPath(), JSON.stringify({ settings: { sort: "az" } }));
  let edited = false;
  fake.read = (p) => {
    if (edited || p !== configPath()) return undefined;
    edited = true;
    const old = readFileSync(p, "utf8");
    writeFileSync(p, JSON.stringify({ settings: { sort: "az" }, workspaces: [{ name: "Hand" }] }));
    return Promise.resolve(old);
  };
  await saveSetting("plus", "worktree");
  assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")), { settings: { sort: "az", plus: "worktree" }, workspaces: [{ name: "Hand" }] });
});

test("saveSetting leaves a file that is not JSON alone", async () => {
  writeFileSync(configPath(), "{ broken");
  await assert.rejects(saveSetting("sort", "az"));
  assert.equal(readFileSync(configPath(), "utf8"), "{ broken");
});

test("a worktrees pattern on a Workspace or a Repo is kept, and dropped with an error when it is not a string", () => {
  const good = parseConfig(JSON.stringify({ workspaces: [{ name: "A", worktrees: ".wt/{branch}/{repo}" }], repos: { "h/r": { worktrees: "/x/{branch}" } } }));
  assert.deepEqual(good.errors, []);
  assert.equal(good.config.workspaces[0].worktrees, ".wt/{branch}/{repo}");
  assert.equal(good.config.repos["h/r"].worktrees, "/x/{branch}");
  const bad = parseConfig(JSON.stringify({ workspaces: [{ name: "A", worktrees: 3 }], repos: { "h/r": { worktrees: "" } } }));
  assert.equal(bad.errors.length, 2);
  assert.equal("worktrees" in bad.config.workspaces[0], false);
  assert.equal("worktrees" in bad.config.repos["h/r"], false);
});
