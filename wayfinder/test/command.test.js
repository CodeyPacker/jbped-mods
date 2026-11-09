import { test } from "node:test";
import assert from "node:assert/strict";
import { invocation } from "../mods/wayfinder/command.js";

test("wsl runner runs inside the distro", () => {
  assert.deepEqual(invocation("wsl:Ubuntu", "windows", "gh", ["--version"]),
    { command: "wsl.exe", args: ["-d", "Ubuntu", "--exec", "gh", "--version"], cwd: undefined });
});

test("wsl runner sets env and cwd", () => {
  const r = invocation("wsl:Ubuntu", "windows", "az", ["version"], { env: { AZURE_CONFIG_DIR: "/home/me/.wf/work" }, cwd: "/src" });
  assert.deepEqual(r.args, ["-d", "Ubuntu", "--cd", "/src", "--exec", "env", "AZURE_CONFIG_DIR=/home/me/.wf/work", "az", "version"]);
});

test("native runner runs directly, or through env", () => {
  assert.deepEqual(invocation("native", "linux", "gh", ["x"], { cwd: "/a" }), { command: "gh", args: ["x"], cwd: "/a" });
  assert.deepEqual(invocation("native", "macos", "gh", ["x"], { env: { GH_TOKEN: "t" } }), { command: "env", args: ["GH_TOKEN=t", "gh", "x"], cwd: undefined });
});

test("native env on Windows, bad names and unknown runners throw", () => {
  assert.throws(() => invocation("native", "windows", "gh", [], { env: { A: "1" } }), /wsl/);
  assert.throws(() => invocation("native", "linux", "gh", [], { env: { "A B": "1" } }), /Bad environment/);
  assert.throws(() => invocation("docker", "linux", "gh"), /Unknown runner/);
});

test("null env values are skipped", () => {
  assert.deepEqual(invocation("native", "linux", "gh", [], { env: { A: null } }).command, "gh");
});
