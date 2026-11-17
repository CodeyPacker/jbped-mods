import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { state, calls, reads } from "./herdr-shim.mjs";
import { FIXTURES } from "./helpers.mjs";
import * as machine from "../mods/brunr/machine.js";
import { parseCollection } from "../mods/brunr/parser.js";

const fx = FIXTURES.replace(/\/+$/, "");
const scratch = () => mkdtempSync(join(tmpdir(), "brunr-mach-"));
const reset = (extra = {}) => { Object.assign(state, { appHome: scratch(), home: "/nonexistent", platform: "linux", path: null, maxTimeout: Infinity }, extra); calls.length = 0; reads.length = 0; };
const collection = (dir = "yaml") => parseCollection({ root: `${fx}/${dir}`, files: {} });

/** A folder of fake programs. `bru` writes FAKE_REPORT to its --reporter-json path, as FAKE_MODE says. */
function fakeBin({ bru = true, node = true } = {}) {
  const bin = scratch();
  const put = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  if (node) put("node", 'echo v22.0.0');
  if (bru) put("bru", [
    '[ "$1" = --version ] && { echo 4.3.0; exit 0; }',
    'out=""; while [ $# -gt 0 ]; do [ "$1" = --reporter-json ] && out=$2; shift; done',
    'case "$FAKE_MODE" in',
    '  ok) cat "$FAKE_REPORT" > "$out"; echo ran; exit 0;;',
    '  fail) cat "$FAKE_REPORT" > "$out"; echo "the CLI failed" >&2; exit 1;;',
    '  noreport) echo "error: no such environment" >&2; exit 1;;',
    '  slow) cat "$FAKE_REPORT" > "$out"; exec sleep 5;;',
    'esac',
  ].join("\n"));
  for (const tool of ["sh", "cat", "sleep", "rm", "find", "env"]) {
    try { const p = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(); if (p && !existsSync(join(bin, tool))) put(tool, `exec ${p} "$@"`); } catch {}
  }
  return bin;
}

const reportsLeft = (home) => { try { return readdirSync(join(home, "data/brunr")); } catch { return []; } };

test("bru is started by name, and as bru.cmd on Windows here", () => {
  reset({ platform: "linux" });
  assert.deepEqual(machine.bruCommand(null), ["bru", []]);
  reset({ platform: "windows" });
  assert.deepEqual(machine.bruCommand(null), ["bru.cmd", []]);
  assert.deepEqual(machine.bruCommand("box"), ["bru", []]);
});

test("readCollection reads only Collection files, never .env, on this computer", async () => {
  reset();
  const files = await machine.readCollection(null, `${fx}/yaml`);
  assert.ok(existsSync(`${fx}/yaml/.env`), "the fixture has a .env");
  assert.ok(!Object.keys(files).some((p) => p.includes(".env")));
  assert.ok(!("notes/readme.md" in files));
  assert.ok("opencollection.yml" in files && "products/top sellers/Best Sellers.yml" in files);
  assert.ok(!reads.some((r) => r.path.includes(".env")), "no read of .env");
});

test("readCollection on another Machine lists then reads in two execs, never touching .env", async () => {
  reset();
  const files = await machine.readCollection("box", `${fx}/yaml`);
  const local = await machine.readCollection(null, `${fx}/yaml`);
  assert.deepEqual(files, local);
  const remote = calls.filter((c) => c.opts.on === "box");
  assert.equal(remote.length, 2);
  assert.ok(!remote.some((c) => c.args.some((a) => /(^|\/)\.env$/.test(a))));
});

test("readCollection gives nothing for a folder that is not a Collection, and throws for a missing one", async () => {
  reset();
  assert.deepEqual(await machine.readCollection(null, `${fx}/reports`), {});
  await assert.rejects(machine.readCollection(null, "/nonexistent/c"));
  await assert.rejects(machine.readCollection("box", "/nonexistent/c"));
});

test("checkCli finds bru and node", async () => {
  reset({ path: fakeBin() });
  assert.deepEqual(await machine.checkCli(null), { bru: "4.3.0", node: "v22.0.0", step: null });
});

test("checkCli with bru missing names the CLI install step", async () => {
  reset({ path: fakeBin({ bru: false }) });
  const c = await machine.checkCli(null);
  assert.equal(c.bru, null);
  assert.equal(c.node, "v22.0.0");
  assert.equal(c.step.copy, "npm i -g @usebruno/cli");
});

test("checkCli with Node missing names Node first", async () => {
  reset({ path: fakeBin({ bru: false, node: false }) });
  const c = await machine.checkCli("box");
  assert.deepEqual([c.bru, c.node], [null, null]);
  assert.match(c.step.text, /^Install Node\.js/);
});

const runArgs = { machine: null, target: { kind: "request", path: "Get Health.yml" }, environment: "local" };

test("a Run reads the report and deletes it on success", async () => {
  reset({ path: fakeBin() });
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_REPORT = `${fx}/reports/pass-request.json`;
  const r = await machine.runBru({ ...runArgs, collection: collection() });
  assert.equal(r.message, null);
  assert.equal(r.responses.length, 1);
  assert.equal(r.responses[0].status, 200);
  const run = calls.find((c) => c.cmd === "bru");
  assert.equal(run.opts.cwd, `${fx}/yaml`);
  assert.deepEqual(run.args.slice(0, 4), ["run", "Get Health.yml", "--env", "local"]);
  assert.match(run.args.at(-1), /\/data\/brunr\/run-[^/]+\.json$/);
  assert.deepEqual(reportsLeft(state.appHome), []);
});

test("a Run deletes its report when the CLI fails", async () => {
  reset({ path: fakeBin() });
  process.env.FAKE_MODE = "fail";
  process.env.FAKE_REPORT = `${fx}/reports/fail-assertion.json`;
  const r = await machine.runBru({ ...runArgs, collection: collection() });
  assert.equal(r.ok, false);
  assert.ok(r.responses[0].tests.some((t) => !t.ok));
  assert.deepEqual(reportsLeft(state.appHome), []);
});

test("a Run with no report shows the CLI's message", async () => {
  reset({ path: fakeBin() });
  process.env.FAKE_MODE = "noreport";
  const r = await machine.runBru({ ...runArgs, collection: collection() });
  assert.equal(r.message, "error: no such environment");
  assert.deepEqual(reportsLeft(state.appHome), []);
});

test("a Run that times out says so and deletes its report", async () => {
  reset({ path: fakeBin(), maxTimeout: 700 });
  process.env.FAKE_MODE = "slow";
  process.env.FAKE_REPORT = `${fx}/reports/pass-request.json`;
  const r = await machine.runBru({ ...runArgs, collection: collection() });
  assert.match(r.message, /timed out/i);
  assert.deepEqual(reportsLeft(state.appHome), []);
});

test("a Run whose exec throws deletes its report and names the cause", async () => {
  reset({ path: scratch() });
  const r = await machine.runBru({ ...runArgs, collection: collection() });
  assert.match(r.message, /^Cannot start bru/);
  assert.deepEqual(reportsLeft(state.appHome), []);
});

test("a Run on another Machine uses /tmp and deletes the report there", async () => {
  reset({ path: fakeBin() });
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_REPORT = `${fx}/reports/pass-request.json`;
  const r = await machine.runBru({ ...runArgs, machine: "box", collection: collection() });
  assert.equal(r.responses.length, 1);
  const run = calls.find((c) => c.cmd === "bru");
  assert.equal(run.opts.on, "box");
  const report = run.args.at(-1);
  assert.match(report, /^\/tmp\/brunr-[^/]+\.json$/);
  assert.ok(calls.some((c) => c.cmd === "rm" && c.args.includes(report) && c.opts.on === "box"));
  assert.ok(!existsSync(report));
});

test("clearLocalReports removes reports left by an earlier session", async () => {
  reset();
  mkdirSync(join(state.appHome, "data/brunr"), { recursive: true });
  writeFileSync(join(state.appHome, "data/brunr/run-old.json"), "[]");
  writeFileSync(join(state.appHome, "data/brunr/keep.txt"), "x");
  await machine.clearLocalReports();
  assert.deepEqual(reportsLeft(state.appHome), ["keep.txt"]);
});

// The real Bruno CLI against the fixture server, as Dockr's stack test runs Docker.
const realBru = (() => {
  if (process.env.BRUNR_SKIP_BRU === "1") return false;
  try { execFileSync("bru", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("the real bru runs a Request and a folder through runBru", { skip: !realBru && "bru is not on PATH" }, async () => {
  reset();
  const server = spawn(process.execPath, [`${fx}/server.mjs`], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    // A fixture server already running on the port (started by hand) serves the Run as well.
    const started = await new Promise((res) => { server.stdout.once("data", () => res(true)); server.once("exit", () => res(false)); });
    if (!started) assert.ok((await fetch("http://127.0.0.1:47911/health")).ok, "the fixture server did not start and none answers on 47911");
    const files = await machine.readCollection(null, `${fx}/yaml`);
    const c = parseCollection({ root: `${fx}/yaml`, files });
    const one = await machine.runBru({ machine: null, collection: c, target: { kind: "request", path: "products/List Products.yml" }, environment: "local" });
    assert.equal(one.message, null, one.message);
    assert.equal(one.responses[0].status, 200);
    assert.equal(one.responses[0].language, "json");
    const folder = await machine.runBru({ machine: null, collection: c, target: { kind: "folder", path: "products" }, environment: "local" });
    assert.ok(folder.responses.length >= 3);
    assert.ok(folder.responses.some((r) => !r.ok), "Missing Product fails its assertion");
    assert.deepEqual(reportsLeft(state.appHome), []);
  } finally { server.kill(); }
});
