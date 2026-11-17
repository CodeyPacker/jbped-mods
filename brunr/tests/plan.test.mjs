import { test } from "node:test";
import assert from "node:assert/strict";
import { planRun, SINGLE_TIMEOUT, MULTI_TIMEOUT } from "../mods/brunr/plan.js";
import { parseCollection } from "../mods/brunr/parser.js";
import { readTree, deepFreeze } from "./helpers.mjs";

const collection = deepFreeze(parseCollection({ root: "C:/Users/dev/My Shop", files: readTree("yaml") }));
const REPORT = "C:/Users/dev/AppData/Local/Temp/brunr-1.json";
const plan = (over) => planRun(deepFreeze({ collection, environment: null, globalEnvironment: null, workspacePath: null, reportPath: REPORT, ...over }));

test("timeouts are one minute for a Request and ten minutes for more", () => {
  assert.equal(SINGLE_TIMEOUT, 60000);
  assert.equal(MULTI_TIMEOUT, 600000);
});

test("a single Request runs its path with no confirmation", () => {
  assert.deepEqual(plan({ target: { kind: "request", path: "Get Health.yml" }, environment: "local" }), {
    cmd: "bru",
    args: ["run", "Get Health.yml", "--env", "local", "--reporter-json", REPORT],
    cwd: "C:/Users/dev/My Shop",
    timeout: SINGLE_TIMEOUT,
    count: 1,
    confirm: null,
  });
});

test("a path with spaces is one argument and never quoted", () => {
  const r = plan({ target: { kind: "request", path: "products/top sellers/Best Sellers.yml" } });
  assert.deepEqual(r.args, ["run", "products/top sellers/Best Sellers.yml", "--reporter-json", REPORT]);
});

test("a backslash path becomes a forward-slash path", () => {
  const r = plan({ target: { kind: "request", path: "products\\List Products.yml" } });
  assert.equal(r.args[1], "products/List Products.yml");
});

test("a folder adds -r, counts its Requests and asks for confirmation", () => {
  const r = plan({ target: { kind: "folder", path: "products" }, environment: "staging" });
  assert.deepEqual(r.args, ["run", "products", "-r", "--env", "staging", "--reporter-json", REPORT]);
  assert.equal(r.timeout, MULTI_TIMEOUT);
  assert.equal(r.count, 4);
  assert.deepEqual(r.confirm, { count: 4, environment: "staging" });
});

test("a nested folder with spaces counts only its own Requests", () => {
  const r = plan({ target: { kind: "folder", path: "products/top sellers/" } });
  assert.deepEqual(r.args, ["run", "products/top sellers", "-r", "--reporter-json", REPORT]);
  assert.deepEqual(r.confirm, { count: 1, environment: null });
});

test("a Collection passes no path, counts every Request and asks for confirmation", () => {
  const r = plan({ target: { kind: "collection" }, environment: "local" });
  assert.deepEqual(r.args, ["run", "--env", "local", "--reporter-json", REPORT]);
  assert.equal(r.cwd, "C:/Users/dev/My Shop");
  assert.equal(r.timeout, MULTI_TIMEOUT);
  assert.equal(r.count, 8);
  assert.deepEqual(r.confirm, { count: 8, environment: "local" });
});

test("no Environment means no --env and a null Environment in the confirmation", () => {
  const r = plan({ target: { kind: "collection" } });
  assert.deepEqual(r.args, ["run", "--reporter-json", REPORT]);
  assert.equal(r.confirm.environment, null);
});

test("a Global environment adds --global-env and --workspace-path", () => {
  const r = plan({
    target: { kind: "request", path: "orders/Create Order.yml" }, environment: "local",
    globalEnvironment: "shared dev", workspacePath: "C:\\Users\\dev\\Bruno Workspace",
  });
  assert.deepEqual(r.args, [
    "run", "orders/Create Order.yml", "--env", "local",
    "--global-env", "shared dev", "--workspace-path", "C:/Users/dev/Bruno Workspace",
    "--reporter-json", REPORT,
  ]);
});

test("a Global environment without a workspace path, or the reverse, adds neither", () => {
  const a = plan({ target: { kind: "collection" }, globalEnvironment: "shared" });
  const b = plan({ target: { kind: "collection" }, workspacePath: "/home/dev/ws" });
  assert.deepEqual(a.args, ["run", "--reporter-json", REPORT]);
  assert.deepEqual(b.args, ["run", "--reporter-json", REPORT]);
});

test("a target missing from the tree still plans, with a fallback count", () => {
  assert.equal(plan({ target: { kind: "request", path: "gone.yml" } }).count, 1);
  assert.equal(plan({ target: { kind: "folder", path: "gone" } }).count, 0);
});

test("a POSIX root is the working directory", () => {
  const c = parseCollection({ root: "/home/dev/shop api/", files: readTree("bru") });
  const r = planRun({ collection: c, target: { kind: "folder", path: "orders" }, environment: "local", reportPath: "/tmp/r.json" });
  assert.equal(r.cwd, "/home/dev/shop api");
  assert.deepEqual(r.args, ["run", "orders", "-r", "--env", "local", "--reporter-json", "/tmp/r.json"]);
  assert.equal(r.count, 3);
});
