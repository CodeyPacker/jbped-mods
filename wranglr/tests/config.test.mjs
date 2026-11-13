import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fake, reset } from "herdr";
import { parseConfig, loadConfig, saveSetting, saveSettings, saveGroup, groupError, settingError, configPath, DEFAULT_SETTINGS } from "../mods/wranglr/config.js";

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

test("a Repo's worktrees pattern and from ref are kept, and dropped with an error when not a string", () => {
  const good = parseConfig(JSON.stringify({ repos: { "h/r": { worktrees: "/x/{branch}", from: "origin/staging" } } }));
  assert.deepEqual(good.errors, []);
  assert.equal(good.config.repos["h/r"].worktrees, "/x/{branch}");
  assert.equal(good.config.repos["h/r"].from, "origin/staging");
  const bad = parseConfig(JSON.stringify({ repos: { "h/r": { worktrees: ".worktrees/{branch}", from: 3 } } }));
  assert.equal(bad.errors.length, 2);
  assert.equal("worktrees" in bad.config.repos["h/r"], false);
  assert.equal("from" in bad.config.repos["h/r"], false);
});

test("a worktrees pattern must start with {clone} or be absolute", () => {
  for (const ok of ["{clone}/.worktrees/{branch}", "{clone}/../wt/{branch}/{repo}", "/srv/wt/{branch}", "C:/wt/{branch}", "C:\\wt\\{branch}"])
    assert.deepEqual(parseConfig(JSON.stringify({ settings: { worktrees: ok } })).errors, [], ok);
  for (const no of [".worktrees/{branch}", "../wt/{branch}", "wt", "", 3]) {
    const r = parseConfig(JSON.stringify({ settings: { worktrees: no } }));
    assert.equal(r.errors.length, 1, String(no));
    assert.match(r.errors[0], /must start with \{clone\} or be an absolute path/);
    assert.equal(r.config.settings.worktrees, DEFAULT_SETTINGS.worktrees);
  }
  assert.equal(DEFAULT_SETTINGS.worktrees, "{clone}/.worktrees/{branch}");
});

test("settingError names what is wrong with one setting, or gives null", () => {
  assert.equal(settingError("sort", "az"), null);
  assert.equal(settingError("agent", null), null);
  assert.equal(settingError("agent", ["claude", "--model", "opus"]), null);
  assert.equal(settingError("worktrees", "{clone}/../wt/{branch}"), null);
  assert.equal(settingError("worktrees", ".worktrees/{branch}"), "must start with {clone} or be an absolute path");
  assert.equal(settingError("ticket", "(unclosed"), "is not a valid regular expression");
  assert.equal(settingError("plus", "clone"), "must be one of open, worktree");
});

const put = (o) => writeFileSync(configPath(), typeof o === "string" ? o : JSON.stringify(o));
const file = () => JSON.parse(readFileSync(configPath(), "utf8"));
const R = "github.com/org/repo";

test("the default Machine is null, a name or \"\", and anything else falls back", () => {
  assert.equal(parseConfig(null).config.settings.machine, null);
  assert.equal(parseConfig(JSON.stringify({ settings: { machine: "wsl" } })).config.settings.machine, "wsl");
  assert.equal(parseConfig(JSON.stringify({ settings: { machine: "" } })).config.settings.machine, "");
  const { config, errors } = parseConfig(JSON.stringify({ settings: { machine: 3 } }));
  assert.equal(config.settings.machine, null);
  assert.equal(errors.length, 1);
  assert.equal(settingError("machine", "wsl"), null);
  assert.equal(settingError("machine", null), null);
  assert.ok(settingError("machine", ["wsl"]));
});

test("a from that is an option or has a space is dropped", () => {
  const { config, errors } = parseConfig(JSON.stringify({ repos: { a: { from: "--upload-pack=x" }, b: { from: "origin/dev x" }, c: { from: "origin/dev" } } }));
  assert.equal(config.repos.a.from, undefined);
  assert.equal(config.repos.b.from, undefined);
  assert.equal(config.repos.c.from, "origin/dev");
  assert.equal(errors.length, 2);
});

test("saveSettings writes several settings in one write and keeps the rest", async () => {
  put({ settings: { sort: "az", other: 1 }, workspaces: [{ name: "W" }] });
  await saveSettings({ plus: "worktree", machine: "wsl", agent: ["claude"] });
  assert.deepEqual(file(), { settings: { sort: "az", other: 1, plus: "worktree", machine: "wsl", agent: ["claude"] }, workspaces: [{ name: "W" }] });
});

test("saveSettings writes nothing when one value is not valid or not a setting", async () => {
  put({ settings: { sort: "az" } });
  const before = readFileSync(configPath(), "utf8");
  await assert.rejects(saveSettings({ plus: "worktree", worktrees: "relative/{branch}" }), /worktrees/);
  await assert.rejects(saveSettings({ plus: "worktree", nope: 1 }), /nope/);
  await assert.rejects(saveSettings(null));
  await assert.rejects(saveSettings(["sort"]));
  assert.equal(readFileSync(configPath(), "utf8"), before);
});

test("groupError names each field that is wrong", () => {
  assert.deepEqual(groupError("repo", { machines: ["wsl", ""], worktrees: "{clone}/../wt/{branch}", from: "origin/dev" }), {});
  assert.deepEqual(groupError("repo", { worktrees: "", from: "" }), {});
  assert.deepEqual(groupError("workspace", { machines: [], homes: { wsl: "/srv/w", "": "C:\\w", old: "" } }), {});
  assert.deepEqual(groupError("custom", { machines: ["wsl"] }), {});
  assert.deepEqual(Object.keys(groupError("repo", { machines: "wsl", worktrees: "wt/{branch}", from: "-x", homes: {} })).sort(), ["from", "homes", "machines", "worktrees"]);
  assert.deepEqual(groupError("repo", { machines: ["wsl", "wsl"] }), { machines: "names a Machine twice" });
  assert.deepEqual(groupError("repo", { machines: ["__proto__"] }), { machines: "must be a list of Machine names" });
  assert.deepEqual(groupError("repo", { from: "origin/dev two" }), { from: "must be a git ref, such as origin/staging" });
  assert.deepEqual(groupError("workspace", { homes: { wsl: "relative", "": "/ok" } }), { "home:wsl": "must be an absolute path" });
  assert.deepEqual(groupError("workspace", { worktrees: "{clone}/x" }), { worktrees: "is not a setting of this Group" });
  assert.ok(groupError("nope", {}).settings);
  assert.ok(groupError("repo", null).settings);
});

test("saveGroup sets a Repo's fields, makes its entry, and keeps every other key", async () => {
  put({ "//": "mine", settings: { sort: "az" }, repos: { other: { machines: ["x"], future: 1 } } });
  await saveGroup("repo", R, { machines: ["wsl", ""], worktrees: "{clone}/../wt/{branch}", from: "origin/staging" });
  assert.deepEqual(file(), { "//": "mine", settings: { sort: "az" }, repos: { other: { machines: ["x"], future: 1 }, [R]: { machines: ["wsl", ""], worktrees: "{clone}/../wt/{branch}", from: "origin/staging" } } });
  assert.deepEqual(parseConfig(readFileSync(configPath(), "utf8")).errors, []);
});

test("saveGroup removes a Repo's cleared fields, and an entry or a repos block left empty", async () => {
  put({ repos: { [R]: { worktrees: "{clone}/wt/{branch}", from: "origin/dev", on: { wsl: { path: "/r" } } } } });
  await saveGroup("repo", R, { worktrees: "", from: "" });
  assert.deepEqual(file(), { repos: { [R]: { on: { wsl: { path: "/r" } } } } });
  put({ repos: { [R]: { from: "origin/dev" } } });
  await saveGroup("repo", R, { from: "" });
  assert.deepEqual(file(), {});
  await saveGroup("repo", R, { machines: [] });
  assert.deepEqual(file(), {}, "an empty list makes no entry");
  put({ repos: { [R]: { machines: ["wsl"] } } });
  await saveGroup("repo", R, { machines: [] });
  assert.deepEqual(file(), { repos: { [R]: { machines: [] } } });
});

test("saveGroup makes the file for a Repo when it is absent", async () => {
  await saveGroup("repo", R, { from: "main" });
  assert.deepEqual(file(), { repos: { [R]: { from: "main" } } });
});

test("saveGroup sets a Workspace's Machines and homes, keeping its Repos and paths", async () => {
  const ws = { name: "Arden", repos: ["a", "b"], machines: ["wsl"], on: { wsl: { home: "/old", paths: { a: "/old/a" } }, "": { home: "C:/w" } }, future: true };
  put({ workspaces: [{ name: "Other", repos: [] }, ws] });
  await saveGroup("workspace", "Arden", { machines: ["", "wsl"], homes: { wsl: "/new", "": "", box: "/srv/w" } });
  assert.deepEqual(file(), { workspaces: [{ name: "Other", repos: [] }, { ...ws, machines: ["", "wsl"], on: { wsl: { home: "/new", paths: { a: "/old/a" } }, box: { home: "/srv/w" } } }] });
});

test("saveGroup refuses a Workspace that is not in the file, and bad kinds and keys", async () => {
  put({ workspaces: [{ name: "Arden", repos: [] }] });
  const before = readFileSync(configPath(), "utf8");
  await assert.rejects(saveGroup("workspace", "Nope", { machines: ["wsl"] }), /not in wranglr.json/);
  await assert.rejects(saveGroup("custom", "box", { machines: ["wsl"] }));
  await assert.rejects(saveGroup("repo", "__proto__", { from: "main" }));
  await assert.rejects(saveGroup("repo", "", { from: "main" }));
  await assert.rejects(saveGroup("repo", R, { from: "--oops" }), /from/);
  await assert.rejects(saveGroup("repo", R, { worktrees: "wt/{branch}" }), /worktrees/);
  await assert.rejects(saveGroup("workspace", "Arden", { homes: { wsl: "rel" } }), /home:wsl/);
  assert.equal(readFileSync(configPath(), "utf8"), before);
});

test("saveGroup leaves a file alone that is not JSON, or whose repos or workspaces are the wrong shape", async () => {
  for (const text of ["{ broken", "[1]", JSON.stringify({ repos: ["x"] }), JSON.stringify({ repos: { [R]: "x" } })]) {
    put(text);
    await assert.rejects(saveGroup("repo", R, { from: "main" }), undefined, text);
    assert.equal(readFileSync(configPath(), "utf8"), text);
  }
  put(JSON.stringify({ workspaces: { name: "Arden" } }));
  await assert.rejects(saveGroup("workspace", "Arden", { machines: ["wsl"] }));
});

test("saveGroup does not lose a hand edit made between its read and its write", async () => {
  put({ repos: { [R]: { from: "origin/dev" } } });
  let edited = false;
  fake.read = (p) => {
    if (edited || p !== configPath()) return undefined;
    edited = true;
    const old = readFileSync(p, "utf8");
    put({ repos: { [R]: { from: "origin/dev" } }, workspaces: [{ name: "Hand", repos: [] }] });
    return Promise.resolve(old);
  };
  await saveGroup("repo", R, { machines: ["wsl"] });
  assert.deepEqual(file(), { repos: { [R]: { from: "origin/dev", machines: ["wsl"] } }, workspaces: [{ name: "Hand", repos: [] }] });
});
