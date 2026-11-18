// Spaces on another machine: the pure helpers (remote.js), stores that carry their machine, and
// workspaces read there but kept here. The shim runs machine "vps" locally and records each call.
import { remotePath, rootId, idOf, isRemote, mapLimit, REMOTE } from "../mods/wingman/remote.js";
import { Store, PlainRoot } from "../mods/wingman/store.js";
import { spaceRoots, addFolder, removeFolder, findWorkspace, spaceFolder, pathFor, parseJsonc, withFolders } from "../mods/wingman/workspace.js";
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
assert.ok(REMOTE.rootsMs >= 5000 && REMOTE.changesMs >= 5000 && REMOTE.treeMs >= 10000);
assert.ok(REMOTE.watchMs >= 5000 && REMOTE.captureMs >= 5000 && REMOTE.reconcileMs >= 15000);

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
  // Writes run there, compare-and-swap: a save, a stale save refused, undo.
  const f = { rel: "a.txt", path: `${repo}/a.txt`, basePath: null };
  remoteCalls.length = 0;
  const w = await st.apply(f, { target: "current", before: "one\n", after: "two\n" });
  assert.equal(readFileSync(`${repo}/a.txt`, "utf8"), "two\n");
  assert.ok(remoteCalls.length === 1 && remoteCalls[0].on === "vps" && remoteCalls[0].cmd === "sh"); // one call, no read first
  await assert.rejects(st.apply(f, { target: "current", before: "one\n", after: "three\n" }), /changed since it was read/);
  assert.equal(readFileSync(`${repo}/a.txt`, "utf8"), "two\n");
  await st.undo([w]);
  assert.equal(readFileSync(`${repo}/a.txt`, "utf8"), "one\n");
  const plain = new PlainRoot(`${dir}/plain`, "vps");
  assert.equal(plain.on, "vps"); assert.equal(new PlainRoot(`${dir}/plain`).on, null);
  mkdirSync(`${dir}/plain`);
  const pw = await plain.apply({ rel: "n.txt", path: `${dir}/plain/n.txt` }, { target: "current", before: null, after: "x" });
  assert.equal(readFileSync(`${dir}/plain/n.txt`, "utf8"), "x");
  await plain.undo([pw]);
  assert.ok(!existsSync(`${dir}/plain/n.txt`));

  // ---- workspaces of a space on another machine ------------------------------------------
  // Its folder holds a workspace file there, read and edited through the machine. spaces.json (the
  // Claude hook's record of repos it edited, there too once it's installed) comes after the file's folders.
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
  assert.deepEqual(r.roots, [`${t1}/api`, `${t1}/web`, `${dir}/agent-found`]);
  assert.equal(r.names.get(`${t1}/web`), "Web");
  assert.deepEqual(remoteCalls.map((c) => c.cmd ?? "read"), ["sh", "read"]); // one listing, one read, there
  assert.ok(remoteCalls.every((c) => c.on === "vps"));
  writeFileSync(`${data}/spaces.json`, "{}");
  // Read again within 30 s: from the cache, no calls.
  remoteCalls.length = 0;
  await spaceRoots(sp, [`${t1}/api`]);
  assert.equal(remoteCalls.length, 0);
  // Wingman edits the machine's file there (compare-and-swap), every other byte kept; no own file here.
  assert.equal(await findWorkspace(sp), null);
  const own = `${data}/workspaces/vps_s1.code-workspace`, there = `${t1}/t1.code-workspace`;
  remoteCalls.length = 0;
  await addFolder(sp, `${dir}/lib`, []);
  assert.ok(remoteCalls.every((c) => c.on === "vps"));
  assert.deepEqual(parseJsonc(readFileSync(there, "utf8")).folders.map((f) => f.path), ["api", "web", `${dir}/lib`]);
  assert.ok(readFileSync(there, "utf8").startsWith('{ "folders": [')); // the text around "folders" is kept
  assert.ok(!existsSync(own));
  r = await spaceRoots(sp, [`${t1}/api`]);
  assert.deepEqual(r.roots, [`${t1}/api`, `${t1}/web`, `${dir}/lib`]);
  await removeFolder(sp, `${t1}/web`); await removeFolder(sp, `${dir}/lib`);
  assert.deepEqual(parseJsonc(readFileSync(there, "utf8")).folders.map((f) => f.path), ["api"]);
  r = await spaceRoots(sp, [`${t1}/api`]);
  assert.deepEqual(r.roots, [`${t1}/api`]);
  // Adding back un-hides.
  await addFolder(sp, `${t1}/web`, r.roots);
  assert.ok((await spaceRoots(sp)).roots.includes(`${t1}/web`));
  // An own file here from before is still read, and removing a folder edits it too.
  mkdirSync(`${data}/workspaces`, { recursive: true });
  writeFileSync(own, withFolders(null, [{ path: `${dir}/old` }]));
  assert.ok((await spaceRoots(sp)).roots.includes(`${dir}/old`));
  await removeFolder(sp, `${dir}/old`);
  assert.deepEqual(parseJsonc(readFileSync(own, "utf8")).folders, []);
  assert.ok(!(await spaceRoots(sp)).roots.includes(`${dir}/old`));
  // No file there yet: adding a second repo makes one in the space's folder there, as here.
  const t2 = `${dir}/t2`;
  mkdirSync(t2);
  const sp2 = { id: "vps/s2", machine: "vps", folder: t2 };
  await addFolder(sp2, `${t2}/b`, [`${t2}/a`]);
  assert.deepEqual(parseJsonc(readFileSync(`${t2}/t2.code-workspace`, "utf8")).folders.map((f) => f.path), ["a", "b"]);
  assert.ok(!existsSync(`${data}/workspaces/vps_s2.code-workspace`));
  rmSync(`${data}/workspaces`, { recursive: true, force: true });
} finally {
  rmSync(dir, { recursive: true, force: true });
  for (const [n, t] of saved) t == null ? rmSync(`${data}/${n}`, { force: true }) : writeFileSync(`${data}/${n}`, t);
}
console.log("remote tests pass");
