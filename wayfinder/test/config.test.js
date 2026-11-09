import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, defaultRunner } from "../mods/wayfinder/config.js";

const good = {
  activeProfile: "work",
  profiles: {
    work: {
      runner: "wsl:Ubuntu",
      accounts: [
        { id: "gh", provider: "github", login: "me" },
        { id: "ado", provider: "azure", org: "https://dev.azure.com/x", projects: ["P"] },
      ],
      repos: [{ id: "fe", path: "/src/fe" }],
      boards: [{ id: "b", account: "ado", ref: { team: "T" }, repos: ["fe"], trackedStatuses: ["New", "Active"] }],
    },
    personal: { accounts: [] },
  },
};
const parse = (o, platform = "linux") => parseConfig(JSON.stringify(o), platform);

test("a valid config gives the active profile", () => {
  const r = parse(good);
  assert.deepEqual(r.errors, []);
  assert.equal(r.profile.name, "work");
  assert.equal(r.profile.runner, "wsl:Ubuntu");
  assert.deepEqual(r.profileNames, ["work", "personal"]);
});

test("invalid JSON is reported, not thrown", () => {
  const r = parseConfig("{ nope", "linux");
  assert.equal(r.profile, null);
  assert.match(r.errors[0], /Not valid JSON/);
});

test("runner defaults by platform", () => {
  assert.equal(defaultRunner("windows"), "wsl:Ubuntu");
  assert.equal(parse({ profiles: { p: {} } }, "macos").profile.runner, "native");
});

test("activeProfile falls back to the first profile", () => {
  assert.equal(parse({ profiles: { a: {}, b: {} } }).profile.name, "a");
});

test("missing activeProfile target is an error", () => {
  const r = parse({ ...good, activeProfile: "nope" });
  assert.equal(r.profile, null);
  assert.ok(r.errors.some((e) => e.startsWith("activeProfile")));
});

test("secret fields are rejected anywhere", () => {
  const o = structuredClone(good);
  o.profiles.work.accounts[0].token = "x";
  const r = parse(o);
  assert.ok(r.errors.some((e) => /accounts\[0\]\.token/.test(e)));
  // "path" must not be mistaken for "pat"
  assert.ok(!r.errors.some((e) => /\.path/.test(e)));
});

test("boards must reference known accounts and repos", () => {
  const o = structuredClone(good);
  o.profiles.work.boards[0].account = "zzz";
  o.profiles.work.boards[0].repos = ["nope"];
  const r = parse(o);
  assert.ok(r.errors.some((e) => /no account "zzz"/.test(e)));
  assert.ok(r.errors.some((e) => /no repo "nope"/.test(e)));
});

test("provider-specific account fields are required", () => {
  const r = parse({ profiles: { p: { accounts: [{ id: "a", provider: "github" }, { id: "b", provider: "azure" }, { id: "c", provider: "jira" }] } } });
  assert.ok(r.errors.some((e) => /\.login/.test(e)));
  assert.ok(r.errors.some((e) => /\.org/.test(e)));
  assert.ok(r.errors.some((e) => /\.projects/.test(e)));
  assert.ok(r.errors.some((e) => /\.provider/.test(e)));
});

test("duplicate ids and bad runners are errors", () => {
  const r = parse({ profiles: { p: { runner: "docker", accounts: [{ id: "a", provider: "github", login: "x" }, { id: "a", provider: "github", login: "y" }] } } });
  assert.ok(r.errors.some((e) => /runner/.test(e)));
  assert.ok(r.errors.some((e) => /used twice/.test(e)));
});
