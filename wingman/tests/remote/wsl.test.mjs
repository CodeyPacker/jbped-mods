// Against a real Herdr machine (not in run.sh's default set; it needs hc and the machine):
//   sh wingman/tests/run.sh remote/wsl
// hc is WINGMAN_REMOTE_HC, else hc.exe or hc on PATH; the machine is WINGMAN_REMOTE_ON (default
// "wsl"). The shim then sends `on` calls through `hc exec --on` / `hc file read --on`. Without
// either, the test prints why and passes. It makes a repo under /tmp/wingman-remote-* on the
// machine and deletes it afterwards.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const on = process.env.WINGMAN_REMOTE_ON || "wsl";
const which = (n) => { try { return execFileSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).trim() || null; } catch { return null; } };
const hcPath = process.env.WINGMAN_REMOTE_HC || which("hc.exe") || which("hc");
const skip = (why) => { console.log(`remote/wsl skipped: ${why}`); process.exit(0); };
if (!hcPath) skip("no hc found (set WINGMAN_REMOTE_HC)");
try {
  const j = JSON.parse(execFileSync(hcPath, ["exec", "--json", "--on", on, "--timeout", "15", "--", "true"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] }));
  if (j.error || j.code !== 0) skip(`machine ${on} unreachable: ${j.error?.message ?? `exit ${j.code}`}`);
} catch (e) {
  let why = String(e.message ?? e).split("\n")[0];
  try { why = JSON.parse(e.stderr).error.message; } catch {}
  skip(`machine ${on} unreachable: ${why}`);
}
process.env.WINGMAN_REMOTE_HC = hcPath;

const { exec, readTextFile, remoteCalls } = await import("herdr");
const { Store } = await import("../../mods/wingman/store.js");
const { STATUS_V2, parseStatusV2, onDisk, NUMSTAT, parseNumstat, discardCommands, commitCommands, READ, statusLetter } = await import("../../mods/wingman/changes.js");
const { STATUS_TREE, parseStatus: parseTree } = await import("../../mods/wingman/filetree.js");
const { listDir, pathKind } = await import("../../mods/wingman/fsx.js");
const { diffHunks } = await import("../../mods/wingman/merge.js");
const { git } = await import("../../mods/wingman/git.js");

const sh = async (script, ...args) => {
  const r = await exec("sh", ["-c", script, "x", ...args], { on });
  if (r.code !== 0) throw new Error(`sh: ${r.stderr || r.stdout}`);
  return r.stdout;
};
const timed = async (label, f) => { const t = Date.now(), n = remoteCalls.length, r = await f(); console.log(`${label}: ${Date.now() - t} ms, ${remoteCalls.length - n} calls`); return r; };

const root = (await sh("mktemp -d /tmp/wingman-remote-XXXXXX")).trim();
assert.match(root, /^\/tmp\/wingman-remote-/);
try {
  await sh(`cd "$1" && git init -q && git config user.email t@t && git config user.name t && mkdir -p src node_modules/x &&
    printf 'one\\ntwo\\nthree\\n' > src/a.txt && printf 'keep\\n' > keep.txt && printf 'gone\\n' > gone.txt &&
    printf 'node_modules/\\n' > .gitignore && printf 'x' > node_modules/x/i.js && git add -A && git commit -qm c1`, root);

  // Store.open from a folder inside, on the machine: paths stay the machine's.
  remoteCalls.length = 0;
  const st = await timed("Store.open", () => Store.open(`${root}/src`, on));
  assert.equal(st.root, root); assert.equal(st.on, on); assert.equal(st.gitDir, `${root}/.git`);
  assert.equal(await st.branch() !== null, true);
  const head = await st.head();
  assert.match(head, /^[0-9a-f]{40}$/);

  // Changes: one status call names HEAD and the files.
  await sh(`cd "$1" && printf 'one\\nTWO\\nthree\\nfour\\n' > src/a.txt && rm gone.txt && printf 'new\\r\\nfile' > 'new file.txt'`, root);
  const s = await timed("status (v2)", () => st.git(STATUS_V2));
  const { head: h2, list } = parseStatusV2(s.stdout);
  assert.equal(h2, head);
  const byRel = Object.fromEntries(list.map((x) => [x.rel, statusLetter(x.xy)]));
  assert.deepEqual(byRel, { "src/a.txt": "M", "gone.txt": "D", "new file.txt": "A" });

  // Diff texts: HEAD's from git there, the working tree's read there, the diff computed here.
  const [show, cur] = await timed("diff texts", () => Promise.all([st.git([...READ, "show", "HEAD:src/a.txt"]), readTextFile(`${root}/src/a.txt`, { on })]));
  assert.equal(show.stdout, "one\ntwo\nthree\n"); assert.equal(cur, "one\nTWO\nthree\nfour\n");
  const hunks = await diffHunks(show.stdout, cur);
  assert.equal(hunks.length, 2); // line 2 changed, line 4 added
  assert.equal(await readTextFile(`${root}/new file.txt`, { on }), "new\r\nfile"); // bytes kept: CRLF, no final newline
  assert.equal(await readTextFile(`${root}/gone.txt`, { on }), null);
  const counts = parseNumstat((await st.git(NUMSTAT)).stdout);
  assert.deepEqual(counts.get("src/a.txt"), { add: 2, del: 1, binary: false });

  // The refresh's content check: one hash-object over the files on disk notices a same-status edit.
  const hash = async () => (await st.git(["hash-object", "--no-filters", "--", ...onDisk(list)])).stdout;
  const h1 = await timed("hash-object", hash);
  await sh(`printf 'one\\nTWO!\\nthree\\nfour\\n' > "$1/src/a.txt"`, root);
  assert.equal(parseStatusV2((await st.git(STATUS_V2)).stdout).list.length, list.length);
  assert.notEqual(await hash(), h1);

  // Tree: file list and status letters with ignored paths, a disk listing, a path's kind.
  const [ls, ts] = await timed("tree pass", () => Promise.all([st.git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]), st.git(STATUS_TREE)]));
  assert.ok(ls.stdout.split("\0").includes("new file.txt"));
  assert.deepEqual(parseTree(ts.stdout).ignored, ["node_modules/"]);
  const listed = await timed("listDir", () => listDir(`${root}/node_modules`, { on }));
  assert.deepEqual(listed.entries, [{ name: "x", dir: true }]);
  assert.equal(await pathKind(`${root}/src`, { on }), "dir");
  assert.equal(await pathKind(`${root}/nope`, { on }), null);
  // A missing folder can't be git's working folder: the call rejects (what folderKind relies on).
  await assert.rejects(git(["status"], { cwd: `${root}/nope`, on }));
  await assert.rejects(Store.open(`${root}/nope`, on));

  // Commit the checked files only; discard one tracked and one new file.
  for (const args of commitCommands(["src/a.txt", "gone.txt"], "remote commit")) {
    const r = await st.git(args, { timeout: 120000 });
    assert.equal(r.code, 0, r.stderr);
  }
  assert.notEqual(await st.head(), head);
  assert.equal((await st.git(["log", "-1", "--format=%s"])).stdout.trim(), "remote commit");
  let now = parseStatusV2((await st.git(STATUS_V2)).stdout).list;
  assert.deepEqual(now.map((x) => x.rel), ["new file.txt"]);
  await sh(`printf 'changed\\n' > "$1/keep.txt"`, root);
  for (const args of [...discardCommands("keep.txt", true), ...discardCommands("new file.txt", false)]) assert.equal((await st.git(args)).code, 0);
  now = parseStatusV2((await st.git(STATUS_V2)).stdout).list;
  assert.deepEqual(now, []);
  assert.equal(await readTextFile(`${root}/keep.txt`, { on }), "keep\n");
  assert.equal(await readTextFile(`${root}/new file.txt`, { on }), null);
  // Writes refuse on another machine.
  await assert.rejects(st.apply({ rel: "keep.txt", path: `${root}/keep.txt` }, { target: "current", before: "keep\n", after: "x" }), /read-only/);
  assert.ok(remoteCalls.every((c) => c.on === on));
} finally {
  await exec("rm", ["-rf", "--", root], { on });
  assert.equal(await pathKind(root, { on }), null);
}
console.log(`remote/wsl ok on ${on}`);
