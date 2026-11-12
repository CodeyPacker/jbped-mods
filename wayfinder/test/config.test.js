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
      boards: [{ id: "b", account: "ado", ref: { project: "P", team: "T" }, repos: ["fe"], trackedStatuses: ["New", "Active"] }],
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

test("a secret under a near-miss key is rejected, the variable-name keys are not (security F8)", () => {
  const o = structuredClone(good);
  Object.assign(o.profiles.work.accounts[0], { clickupToken: "pk_1_X", azurePat: "x", api_key: "x", "my-secret": "x" });
  const e = parse(o).errors.join("\n");
  for (const k of ["clickupToken", "azurePat", "api_key", "my-secret"]) assert.match(e, new RegExp(`\\.${k}: Wayfinder doesn't store secrets.*patEnv.*tokenEnv`));
  const ok = parse({ profiles: { p: { accounts: [{ id: "a", provider: "azure", org: "https://dev.azure.com/o", patEnv: "ADO_PAT" }, { id: "c", provider: "clickup", tokenEnv: "CU_TOKEN" }] } } });
  assert.deepEqual(ok.errors, []);
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
  const r = parse({ profiles: { p: { accounts: [{ id: "a", provider: "github" }, { id: "b", provider: "azure", projects: "P" }, { id: "c", provider: "jira" }] } } });
  assert.ok(r.errors.some((e) => /\.login/.test(e)));
  assert.ok(r.errors.some((e) => /\.org/.test(e)));
  assert.ok(r.errors.some((e) => /\.projects/.test(e)));
  assert.ok(r.errors.some((e) => /\.provider/.test(e)));
  // projects is optional (Settings finds Boards across the organization); prRepos names must be "a/b"
  assert.deepEqual(parse({ profiles: { p: { accounts: [{ id: "b", provider: "azure", org: "https://dev.azure.com/x" }] } } }).errors, []);
  assert.ok(parse({ profiles: { p: { accounts: [{ id: "a", provider: "github", login: "x", prRepos: { mode: "ignored", ignored: ["nope"] } }] } } }).errors.some((e) => /prRepos/.test(e)));
});

test("duplicate ids and bad runners are errors", () => {
  const r = parse({ profiles: { p: { runner: "docker", accounts: [{ id: "a", provider: "github", login: "x" }, { id: "a", provider: "github", login: "y" }] } } });
  assert.ok(r.errors.some((e) => /runner/.test(e)));
  assert.ok(r.errors.some((e) => /used twice/.test(e)));
});

test("notifications default to on every 5 minutes, and bad values are reported", () => {
  assert.deepEqual(parse(good).profile.notifications, { enabled: true, minutes: 5 });
  const p = (n) => parse({ profiles: { p: { notifications: n } } });
  assert.deepEqual(p({ enabled: false, minutes: 15 }).profile.notifications, { enabled: false, minutes: 15 });
  assert.deepEqual(p({ minutes: 60 }).profile.notifications, { enabled: true, minutes: 60 });
  for (const bad of [{ minutes: 0 }, { minutes: 61 }, { minutes: 2.5 }, { minutes: "5" }, { enabled: "yes" }, []]) {
    assert.deepEqual(p(bad).errors, ['profiles.p.notifications: { "enabled": true | false, "minutes": 1..60 }'], JSON.stringify(bad));
  }
});

test("a Repo's checkout is worktree by default, branch when set, and anything else is an error", () => {
  const p = (c) => parse({ profiles: { p: { repos: [{ id: "r", path: "/x", ...c }] } } });
  assert.equal(p({}).profile.repos[0].checkout, "worktree");
  assert.equal(p({ checkout: "branch" }).profile.repos[0].checkout, "branch");
  assert.deepEqual(p({ checkout: "x" }).errors, ['profiles.p.repos[0].checkout: "worktree" (a detached worktree, the default) or "branch" (the branch in the clone itself)']);
  assert.equal(p({ checkout: "branch" }).config.profiles.p.repos[0].checkout, "branch");
  assert.equal(p({}).config.profiles.p.repos[0].checkout, undefined); // the raw config is left as read
});

test("a Repo's worktrees is herdr by default, beside or a folder when set, and empty or not text is an error", () => {
  const p = (c) => parse({ profiles: { p: { repos: [{ id: "r", path: "/x", ...c }] } } });
  assert.equal(p({}).profile.repos[0].worktrees, "herdr");
  assert.equal(p({ worktrees: "beside" }).profile.repos[0].worktrees, "beside");
  assert.equal(p({ worktrees: "D:\\wt" }).profile.repos[0].worktrees, "D:\\wt");
  for (const bad of ["", 3, ["/x"]]) assert.deepEqual(p({ worktrees: bad }).errors, ['profiles.p.repos[0].worktrees: "herdr" (Herdr\'s worktrees folder, the default), "beside" (next to the clone) or a folder'], JSON.stringify(bad));
  assert.equal(p({}).config.profiles.p.repos[0].worktrees, undefined); // the raw config is left as read
});
