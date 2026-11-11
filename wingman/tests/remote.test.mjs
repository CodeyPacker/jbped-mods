// Spaces on another machine: the pure helpers (remote.js), stores that carry their machine, and
// workspaces read there but kept here. The shim runs machine "vps" locally and records each call.
import { remotePath, rootId, idOf, isRemote, readOnlyNote, mapLimit, REMOTE } from "../mods/wingman/remote.js";
import { Store, PlainRoot } from "../mods/wingman/store.js";
import { spaceRoots, addFolder, removeFolder, findWorkspace, spaceFolder, pathFor, parseJsonc } from "../mods/wingman/workspace.js";
import { remoteCalls } from "herdr";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

// ---- pure ------------------------------------------------------------------------
assert.equal(remotePath("/home/me/repo/"), "/home/me/repo");
assert.equal(remotePath("/home/Me/Repo"), "/home/Me/Repo"); // never lowercased
assert.equal(remotePath("/"), "/");
assert.equal(remotePath("/mnt/c/dev"), "/mnt/c/dev"); // never drive-converted
assert.equal(remotePath("/a\\b"), "/a\\b"); // a POSIX name may hold a backslash
assert.equal(remotePath("C:\\Users\\Me\\repo\\"), "C:/Users/Me/repo"); // a Windows machine's path
assert.equal(remotePath("C:\\"), "C:/");
assert.equal(remotePath("C:"), "C:/");
assert.equal(remotePath("\\\\host\\share\\x"), "//host/share/x");
assert.equal(remotePath(""), null); assert.equal(remotePath(null), null);

assert.equal(rootId("/r"), "/r"); // this computer: the path itself, as before
assert.notEqual(rootId("/r", "vps"), "/r");
assert.notEqual(rootId("/r", "vps"), rootId("/r", "box"));
assert.equal(idOf({ root: "/r", on: "vps" }), rootId("/r", "vps"));
assert.equal(idOf({ root: "/r" }), "/r");
assert.equal(isRemote({ on: "vps" }), true); assert.equal(isRemote({ on: null }), false); assert.equal(isRemote(null), false);
assert.match(readOnlyNote("src/a.js", "vps"), /^a\.js is on vps: .*read-only/);
assert.ok(REMOTE.rootsMs >= 5000 && REMOTE.changesMs >= 5000 && REMOTE.treeMs >= 10000);

{ // mapLimit: order kept, never more than `limit` at once, limit 1 strictly one after another
  let running = 0, most = 0;
  const order = [];
  const out = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, i) => {
    running++; most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, ms));
    running--; order.push(i); return ms * 2;
  });
  assert.deepEqual(out, [60, 10, 40, 2, 20]); assert.equal(most, 2);
  const seq = [];
  await mapLimit([3, 1, 2], 1, async (ms, i) => { seq.push(`s${i}`); await new Promise((r) => setTimeout(r, ms)); seq.push(`e${i}`); });
  assert.deepEqual(seq, ["s0", "e0", "s1", "e1", "s2", "e2"]);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
}

// ---- stores carry their machine --------------------------------------------------------
const dir = mkdtempSync(`${tmpdir()}/wremote-`), g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
const home = process.env.WINGMAN_TEST_HOME, data = `${home}/data/wingman`;
mkdirSync(data, { recursive: true });
const saved = ["spaces.json", "hidden.json"].map((n) => [n, existsSync(`${data}/${n}`) ? readFileSync(`${data}/${n}`, "utf8") : null]);
try {
  const repo = `${dir}/repo`;
  mkdirSync(`${repo}/sub`, { recursive: true }); g(repo, "init", "-q"); g(repo, "config", "user.email", "t@t"); g(repo, "config", "user.name", "t");
  writeFileSync(`${repo}/a.txt`, "one\n"); g(repo, "add", "."); g(repo, "commit", "-qm", "c1");
  remoteCalls.length = 0;
  const st = await Store.open(`${repo}/sub`, "vps");
  assert.equal(st.on, "vps"); assert.equal(st.root, repo);
  assert.ok(st.gitDir.endsWith("/.git"));
  assert.ok(await st.head());
  assert.equal(await st.branch() !== null, true);
  assert.equal(await st.blobAt("HEAD", "a.txt"), "one\n");
  // Every call ran on the machine, and git where the repo is.
  assert.ok(remoteCalls.length >= 4 && remoteCalls.every((c) => c.on === "vps"));
  assert.ok(remoteCalls.filter((c) => c.cmd === "git").every((c) => c.cwd === repo || c.cwd === `${repo}/sub`));
  // Paths git printed are kept as printed (no hostPath, no WSL conversion).
  const local = await Store.open(repo);
  assert.equal(local.on, null); assert.equal(local.root, st.root);
  assert.notEqual(idOf(local), idOf(st));
  // Read-only there: writes refuse before touching anything.
  const f = { rel: "a.txt", path: `${repo}/a.txt`, basePath: null };
  await assert.rejects(st.apply(f, { target: "current", before: "one\n", after: "two\n" }), /a\.txt is on vps: .*read-only/);
  await assert.rejects(st.undo([{ path: `${repo}/a.txt`, before: "one\n", after: "two\n" }]), /read-only/);
  const plain = new PlainRoot(`${dir}/plain`, "vps");
  assert.equal(plain.on, "vps"); assert.equal(new PlainRoot(`${dir}/plain`).on, null);
  await assert.rejects(plain.apply({ rel: "n.txt", path: `${dir}/plain/n.txt` }, { target: "current", before: null, after: "x" }), /read-only/);
  assert.equal(readFileSync(`${repo}/a.txt`, "utf8"), "one\n");
  assert.ok(!existsSync(`${dir}/plain/n.txt`));

  // ---- workspaces of a space on another machine ------------------------------------------
  // Its folder holds a workspace file there (read through the machine, never written); repos added
  // by hand go to Wingman's own file here. spaces.json (the Claude hook's) doesn't apply.
  const t1 = `${dir}/t1`;
  mkdirSync(`${t1}/api`, { recursive: true }); mkdirSync(`${t1}/web`);
  const wsText = '{ "folders": [ { "path": "api" }, { "path": "web", "name": "Web" } ] }\n';
  writeFileSync(`${t1}/t1.code-workspace`, wsText);
  const sp = { id: "vps/s1", machine: "vps", folder: `${t1}/` };
  writeFileSync(`${data}/spaces.json`, JSON.stringify({ "vps/s1": [`${dir}/agent-found`] }));
  rmSync(`${data}/hidden.json`, { force: true });
  assert.equal(spaceFolder(sp), t1);
  assert.equal(spaceFolder({ machine: "vps", folder: "/home/me" }), null); // a home folder is no workspace's folder
  assert.equal(pathFor(sp)("/home/me/x/"), "/home/me/x");
  remoteCalls.length = 0;
  let r = await spaceRoots(sp, [`${t1}/api`]);
  assert.deepEqual(r.roots, [`${t1}/api`, `${t1}/web`]);
  assert.equal(r.names.get(`${t1}/web`), "Web");
  assert.deepEqual(remoteCalls.map((c) => c.cmd ?? "read"), ["sh", "read"]); // one listing, one read, there
  assert.ok(remoteCalls.every((c) => c.on === "vps"));
  // Read again within 30 s: from the cache, no calls.
  remoteCalls.length = 0;
  await spaceRoots(sp, [`${t1}/api`]);
  assert.equal(remoteCalls.length, 0);
  // Wingman reads and edits its own file for the space, not the machine's.
  assert.equal(await findWorkspace(sp), null);
  // Adding a repo by hand: Wingman's own file, holding the machine's paths as they are; one repo is enough.
  await addFolder(sp, `${dir}/lib`, []);
  const own = `${data}/workspaces/vps_s1.code-workspace`;
  assert.deepEqual(parseJsonc(readFileSync(own, "utf8")).folders.map((f) => f.path), [`${dir}/lib`]);
  assert.equal(readFileSync(`${t1}/t1.code-workspace`, "utf8"), wsText); // never written there
  r = await spaceRoots(sp, [`${t1}/api`]);
  assert.deepEqual(r.roots, [`${t1}/api`, `${t1}/web`, `${dir}/lib`]);
  // Removing a folder the machine's file lists hides it (that file isn't edited); removing an own one edits Wingman's file.
  await removeFolder(sp, `${t1}/web`); await removeFolder(sp, `${dir}/lib`);
  assert.equal(readFileSync(`${t1}/t1.code-workspace`, "utf8"), wsText);
  assert.deepEqual(parseJsonc(readFileSync(own, "utf8")).folders, []);
  r = await spaceRoots(sp, [`${t1}/api`]);
  assert.deepEqual(r.roots, [`${t1}/api`]);
  // Adding back un-hides.
  await addFolder(sp, `${t1}/web`, r.roots);
  assert.ok((await spaceRoots(sp)).roots.includes(`${t1}/web`));
  rmSync(`${data}/workspaces`, { recursive: true, force: true });
} finally {
  rmSync(dir, { recursive: true, force: true });
  for (const [n, t] of saved) t == null ? rmSync(`${data}/${n}`, { force: true }) : writeFileSync(`${data}/${n}`, t);
}
console.log("remote tests pass");
