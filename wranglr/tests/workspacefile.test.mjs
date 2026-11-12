import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCalls, writeCalls, reset } from "herdr";
import { workspaceFileText, writeWorkspaceFile } from "../mods/wranglr/workspacefile.js";

const ws = { name: "Arden", repos: ["dev.azure.com/Org/Proj/frontend", "github.com/Org/backend", "github.com/Org/absent"] };
let tmp;
before(() => { tmp = mkdtempSync(join(tmpdir(), "wranglr-wsf-")); });
after(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => reset());

test("a Repo under the home is relative, one elsewhere absolute, an unknown one left out", () => {
  const cloned = { wsl: { "dev.azure.com/Org/Proj/frontend": "/mnt/c/dev/arden/frontend/", "github.com/Org/backend": "/srv/backend" } };
  assert.deepEqual(JSON.parse(workspaceFileText(ws, "wsl", cloned, "/mnt/c/dev/arden/")), {
    folders: [{ path: "frontend", name: "frontend" }, { path: "/srv/backend", name: "backend" }],
    settings: {},
  });
});

test("a Repo whose root is the home itself is '.'", () => {
  const text = workspaceFileText({ name: "W", repos: ["x/y"] }, "", { "": { "x/y": "/h" } }, "/h");
  assert.deepEqual(JSON.parse(text).folders, [{ path: ".", name: "y" }]);
});

test("this computer: written once, unchanged content is not rewritten", async () => {
  const cloned = { "": { "github.com/Org/backend": join(tmp, "backend") } };
  assert.equal(await writeWorkspaceFile(ws, null, cloned, tmp), true);
  const file = join(tmp, "Arden.code-workspace");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).folders, [{ path: "backend", name: "backend" }]);
  assert.equal(await writeWorkspaceFile(ws, null, cloned, tmp), false);
  assert.equal(writeCalls.length, 1);
});

test("no home: skipped silently", async () => {
  assert.equal(await writeWorkspaceFile(ws, null, {}, null), false);
  assert.equal(writeCalls.length + execCalls.length, 0);
});

test("another Machine: written through exec with the text as an argument", async () => {
  const cloned = { vps: { "github.com/Org/backend": join(tmp, "remote", "backend") } };
  const home = join(tmp, "remote");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(home);
  assert.equal(await writeWorkspaceFile(ws, "vps", cloned, home), true);
  const call = execCalls.find((c) => c.cmd === "sh");
  const text = workspaceFileText(ws, "vps", cloned, home);
  assert.equal(call.on, "vps");
  assert.ok(!call.args[1].includes("backend"), "the script holds no content");
  assert.deepEqual(call.args.slice(2), ["wranglr", join(home, "Arden.code-workspace"), text]);
  assert.equal(readFileSync(join(home, "Arden.code-workspace"), "utf8"), text);
  assert.equal(writeCalls.length, 0);
  assert.equal(existsSync(join(home, "Arden.code-workspace")), true);
});
