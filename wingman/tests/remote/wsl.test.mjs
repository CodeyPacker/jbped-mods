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
const { STATUS_V2, parseStatusV2, onDisk, NUMSTAT, parseNumstat, discardCommands, commitCommands, pathspecText, READ, statusLetter } = await import("../../mods/wingman/changes.js");
const { STATUS_TREE, parseStatus: parseTree } = await import("../../mods/wingman/filetree.js");
const { listDir, pathKind, writeText, removeFile, makeDir, fingerprints, callBytes, SAFE_CALL, STALE, createFile, createDir, movePath, deleteFile, deleteTree } = await import("../../mods/wingman/fsx.js");
const { newTarget, renameTarget } = await import("../../mods/wingman/fileops.js");
const { Capture } = await import("../../mods/wingman/capture.js");
const { acceptAt, rejectAt, rejectAll } = await import("../../mods/wingman/model.js");
const { createHash } = await import("node:crypto");
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
  const commit = async (rels, msg) => {
    const spec = st.tempPath("pathspec");
    await st.withTemp(spec, pathspecText(rels), async () => {
      for (const args of commitCommands(rels, msg, spec)) {
        const r = await st.git(args, { timeout: 120000 });
        assert.equal(r.code, 0, r.stderr);
      }
    });
    assert.equal(await pathKind(spec, { on }), null);
  };
  await timed("commit (2 files)", () => commit(["src/a.txt", "gone.txt"], "remote commit"));
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
  // Names, not patterns: discarding app/[slug]/p.txt leaves app/s/p.txt; committing "*" commits only "*".
  await sh(`cd "$1" && mkdir -p 'app/[slug]' app/s && echo 1 > 'app/[slug]/p.txt' && echo 1 > app/s/p.txt && echo 1 > '*' && git add -A && git commit -qm pat && echo 2 > 'app/[slug]/p.txt' && echo 2 > app/s/p.txt && echo 2 > '*'`, root);
  for (const args of discardCommands("app/[slug]/p.txt", true)) assert.equal((await st.git(args)).code, 0);
  assert.equal(await readTextFile(`${root}/app/[slug]/p.txt`, { on }), "1\n");
  assert.equal(await readTextFile(`${root}/app/s/p.txt`, { on }), "2\n");
  // 400 files with long names in one commit: their names (about 80 KB) go in a file there.
  const many = Array.from({ length: 400 }, (_, i) => `deep/${"long-folder-name-".repeat(6)}/${String(i).padStart(3, "0")}-${"x".repeat(80)}.txt`);
  await sh(`cd "$1" && d=$(dirname "$2") && mkdir -p "$d" && i=0 && while [ $i -lt 400 ]; do n=$(printf %03d $i); printf '%s\\n' "$n" > "$d/$n-$3.txt"; i=$((i+1)); done`, root, many[0], "x".repeat(80));
  await timed("commit (401 files, long names)", () => commit(["*", ...many], "many"));
  const shown = (await st.git(["show", "--name-only", "-z", "--format=", "HEAD"])).stdout.split("\0").filter(Boolean).sort();
  assert.deepEqual(shown, ["*", ...many].sort());
  assert.deepEqual(parseStatusV2((await st.git(STATUS_V2)).stdout).list.map((x) => x.rel), ["app/s/p.txt"]);
  for (const args of discardCommands("app/s/p.txt", true)) assert.equal((await st.git(args)).code, 0);
  assert.ok(remoteCalls.every((c) => c.on === on));

  // ---- D1: writes there (fsx.writeText through hc exec: the Windows command line route) ----------
  const sha = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
  const remoteSha = async (p) => (await sh('sha256sum < "$1"', p)).split(" ")[0];
  const temps = async () => (await sh('find "$1" -name ".wingman-*"', root)).trim();
  const w = `${root}/w`;
  await timed("makeDir", () => makeDir(`${w}/sub/deep`, { on }));
  assert.equal(await pathKind(`${w}/sub/deep`, { on }), "dir");
  const nasty = "a\r\nb\tc \"q\" 'q' `b` \\n \\\\ \\0 \\x41 $HOME ${x} $(id) $$ !! %s %d %% %n é 中文 😀 \u00a0 \u2028 mid\ufeffbom -n -e --help * ? [a] ; | & > <";
  const cases = { nasty, crlf: "one\r\ntwo\r\n", nofinal: "no final newline", final: "x\n", empty: "", lone: "\n", dash: "-n", quotes: '"\\'.repeat(6000) };
  for (const [name, text] of Object.entries(cases)) {
    const p = `${w}/${name}.txt`;
    await timed(`write ${name} (${Buffer.byteLength(text)} B)`, () => writeText(p, text, null, { on }));
    assert.equal(await remoteSha(p), sha(text), name);
    await writeText(p, text + "+", text, { on });
    assert.equal(await remoteSha(p), sha(text + "+"), `${name} overwrite`);
  }
  // Stale refused, create only if absent, removal.
  const cas = `${w}/nasty.txt`;
  await assert.rejects(writeText(cas, "x", "not it", { on }), (e) => e.message.includes(STALE));
  await assert.rejects(writeText(cas, "x", null, { on }), (e) => e.message.includes(STALE));
  assert.equal(await remoteSha(cas), sha(nasty + "+"));
  await assert.rejects(removeFile(cas, "not it", { on }), (e) => e.message.includes(STALE));
  await timed("removeFile", () => removeFile(cas, nasty + "+", { on }));
  assert.equal(await pathKind(cas, { on }), null);
  // Mode and links.
  await sh('printf "#!/bin/sh\\n" > "$1/run.sh" && chmod 750 "$1/run.sh" && printf t1 > "$1/sub/target" && ln -s sub/target "$1/link"', w);
  await writeText(`${w}/run.sh`, "#!/bin/sh\necho hi\n", "#!/bin/sh\n", { on });
  assert.equal((await sh('stat -c %a "$1"', `${w}/run.sh`)).trim(), "750");
  await writeText(`${w}/link`, "t2", "t1", { on });
  assert.equal((await sh('[ -L "$1/link" ] && cat "$1/sub/target"', w)), "t2");
  // Big files: chunked on the safe route (hc exec can't take 1 MB in one call), probed once.
  const k200 = (nasty + "\n").repeat(Math.ceil(200000 / Buffer.byteLength(nasty + "\n")));
  let n0 = remoteCalls.length;
  await timed(`write 200 KB (${Buffer.byteLength(k200)} B)`, () => writeText(`${w}/k200.txt`, k200, null, { on }));
  console.log(`  call size ${callBytes(on)}, ${remoteCalls.length - n0} calls`);
  assert.equal(await remoteSha(`${w}/k200.txt`), sha(k200));
  const mb = "0123456789abcdef é\n".repeat(Math.ceil(1500000 / 20));
  n0 = remoteCalls.length;
  await timed(`write 1.5 MB (${Buffer.byteLength(mb)} B)`, () => writeText(`${w}/mb.txt`, mb, null, { on }));
  console.log(`  ${remoteCalls.length - n0} calls`);
  assert.equal(await remoteSha(`${w}/mb.txt`), sha(mb));
  assert.equal(await temps(), "");
  // A forced failure: stale at the last piece leaves the file and no temp file.
  await assert.rejects(writeText(`${w}/k200.txt`, k200 + "x", "not it", { on }), (e) => e.message.includes(STALE));
  assert.equal(await remoteSha(`${w}/k200.txt`), sha(k200));
  // A folder that can't be written (the first step fails).
  await sh('mkdir "$1/ro" && printf keep > "$1/ro/f" && chmod 555 "$1/ro"', w);
  await assert.rejects(writeText(`${w}/ro/f`, k200, "keep", { on }), /cannot write beside/);
  await assert.rejects(writeText(`${w}/ro/f`, "small", "keep", { on }), /cannot write beside/);
  await sh('chmod 755 "$1/ro"', w);
  assert.equal(await temps(), "");
  // Fingerprints: one call for several files.
  const fp = await timed("fingerprints (3 paths)", () => fingerprints([`${w}/crlf.txt`, `${w}/gone`, `${w}/sub`], { on }));
  assert.deepEqual(fp, { [`${w}/crlf.txt`]: sha("one\r\ntwo\r\n+"), [`${w}/gone`]: null, [`${w}/sub`]: null });
  await sh('rm -rf "$1"', w);

  // ---- the Explorer's file operations there (create, rename, move, delete, confinement) ------------
  // Everything happens inside the test's own folder; the confinement checks refuse before anything runs.
  const x = `${root}/ops`, xo = { on };
  const odd = ["with space.txt", "it's.txt", '"q".txt', "$HOME.txt", "`id`.txt", "中文.md", "-n"];
  await timed("createFile", () => createFile(`${x}/a.txt`, root, xo));
  assert.equal(await readTextFile(`${x}/a.txt`, { on }), "");
  await sh('printf keep > "$1"', `${x}/a.txt`);
  await assert.rejects(createFile(`${x}/a.txt`, root, xo), (e) => e.code === "exists");
  assert.equal(await readTextFile(`${x}/a.txt`, { on }), "keep");
  const nt = newTarget({ root, dir: "ops", name: "deep/er/n.ts" });
  await createFile(nt.path, root, xo);
  assert.equal(await pathKind(`${x}/deep/er/n.ts`, { on }), "file");
  await timed("createDir", () => createDir(`${x}/d1/d2`, root, xo));
  await assert.rejects(createDir(`${x}/d1`, root, xo), /already exists/);
  for (const n of odd) { await createFile(`${x}/odd/${n}`, root, xo); assert.equal(await pathKind(`${x}/odd/${n}`, { on }), "file", n); }
  await timed("movePath", () => movePath(`${x}/a.txt`, `${x}/b.txt`, root, xo));
  assert.equal(await readTextFile(`${x}/b.txt`, { on }), "keep"); assert.equal(await pathKind(`${x}/a.txt`, { on }), null);
  await createFile(`${x}/c.txt`, root, xo);
  await assert.rejects(movePath(`${x}/c.txt`, `${x}/b.txt`, root, xo), (e) => e.code === "exists");
  assert.equal(await readTextFile(`${x}/b.txt`, { on }), "keep");
  const rt = renameTarget({ root, rel: "ops/b.txt", name: "moved/in/b.txt" });
  await movePath(rt.fromPath, rt.path, root, xo);
  assert.equal(await readTextFile(`${x}/moved/in/b.txt`, { on }), "keep");
  await movePath(`${x}/d1`, `${x}/D1`, root, xo); // case-only, on a case-sensitive file system
  assert.equal(await pathKind(`${x}/D1/d2`, { on }), "dir");
  const fancy = `${x}/odd/中文 \`x\` $y.txt`;
  await movePath(`${x}/odd/it's.txt`, fancy, root, xo);
  assert.equal(await pathKind(fancy, { on }), "file");
  await timed("deleteFile", () => deleteFile(`${x}/c.txt`, root, xo));
  assert.equal(await pathKind(`${x}/c.txt`, { on }), null);
  await assert.rejects(deleteFile(`${x}/D1`, root, xo), /is a folder/);
  await sh('mkdir -p "$1/tree/a/b" && printf f > "$1/tree/a/b/f" && printf r > "$1/tree/ro" && chmod 444 "$1/tree/ro"', x);
  await timed("deleteTree", () => deleteTree(`${x}/tree`, root, xo));
  assert.equal(await pathKind(`${x}/tree`, { on }), null);
  const refused = (p) => assert.rejects(p, /isn't inside|refusing/);
  await refused(deleteTree(root, root, xo)); // the root itself
  await refused(deleteTree(`${x}/../..`, root, xo));
  await refused(deleteTree(`${root}/.git`, root, xo));
  await refused(deleteFile(`${root}/.git/HEAD`, root, xo));
  await refused(createFile(`${root}-escape`, root, xo));
  await refused(movePath(`${x}/D1`, `${root}-escape`, root, xo));
  assert.equal(await pathKind(`${root}/.git/HEAD`, { on }), "file");
  assert.equal(await pathKind(`${root}-escape`, { on }), null);
  await deleteTree(x, root, xo);
  assert.equal(await pathKind(x, { on }), null);

  // ---- D2/D3: a review round trip there ------------------------------------------------------------
  await sh(`cd "$1" && printf 'a1\\na2\\na3\\na4\\na5\\na6\\n' > rev.txt && git add rev.txt && git commit -qm rev`, root);
  const st2 = await Store.open(root, on), cap = new Capture(st2);
  const t0 = await timed("snapshot", () => cap.snapshot());
  await timed("setState", () => cap.setState({ tree: t0, since: Date.now() }));
  await sh(`cd "$1" && printf 'a1\\nA2\\na3\\na4\\na5\\nA6\\n' > rev.txt && printf 'made\\n' > made.txt`, root);
  const t1 = await timed("snapshot (after edits)", () => cap.snapshot());
  assert.equal(await timed("adopt (2 files)", () => cap.adopt(t0, t1, null, "spA")), 2);
  const ix = await st2.index();
  let rf = await timed("load", () => st2.load("rev.txt", ix["rev.txt"]));
  assert.equal(rf.hunks.length, 2);
  const act = async (f, action) => { const { write } = action(f); return st2.apply(f, write); };
  await timed("accept", () => act(rf, (s) => acceptAt(s, 0)));
  rf = await st2.load("rev.txt", ix["rev.txt"]);
  assert.equal(rf.hunks.length, 1);
  const rej = await timed("reject", () => act(rf, (s) => rejectAt(s, 0)));
  assert.equal(await readTextFile(`${root}/rev.txt`, { on }), "a1\nA2\na3\na4\na5\na6\n");
  await timed("undo", () => st2.undo([rej]));
  assert.equal(await readTextFile(`${root}/rev.txt`, { on }), "a1\nA2\na3\na4\na5\nA6\n");
  const mf = await st2.load("made.txt", ix["made.txt"]);
  await act(mf, rejectAll);
  assert.equal(await readTextFile(`${root}/made.txt`, { on }), null);
  await sh(`cd "$1" && git add rev.txt && git commit -qm agent`, root);
  await timed("reconcile", () => st2.reconcile(() => "spA"));
  const done = JSON.parse(await readTextFile(`${st2.dir}/index.json`, { on }));
  assert.ok(!done.files["rev.txt"] && Object.keys(done.done).some((k) => k.endsWith("|rev.txt")));
  await cap.setState({ tree: null });
  assert.equal(await temps(), "");
  assert.ok(remoteCalls.every((c) => c.on === on));
} finally {
  await exec("rm", ["-rf", "--", root], { on });
  assert.equal(await pathKind(root, { on }), null);
}

// ---- the Claude hook on the machine --------------------------------------------------------
// In /tmp/wingman-hook-* there, with a throwaway home: the settings path and data folder are passed
// explicitly, so the machine's real ~/.claude and data folder are never read or written.
{
  const { installHook, uninstallHook, hookStatus, hookState, parseSettings } = await import("../../mods/wingman/hooksetup.js");
  const { Journal, queueFeedback } = await import("../../mods/wingman/journal.js");
  const { readFileSync } = await import("node:fs");
  const hookText = readFileSync(new URL("../../mods/wingman/hooks/wingman-hook.sh", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const top = (await sh("mktemp -d /tmp/wingman-hook-XXXXXX")).trim();
  assert.match(top, /^\/tmp\/wingman-hook-/);
  const home = `${top}/home`, data = `${home}/.config/herdr-app/data/wingman`, settings = `${home}/.claude/settings.json`, repo = `${top}/repo`;
  const opts = { dataDir: data, settingsPath: settings };
  const original = JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }, null, 2) + "\n";
  try {
    await sh(`mkdir -p "$1/.claude" && printf %s "$2" > "$1/.claude/settings.json"`, home, original);
    await sh(`mkdir -p "$1" && cd "$1" && git init -q -b main && git config user.email t@t && git config user.name t && printf 'one\\ntwo\\n' > a.txt && git add -A && git commit -qm c1`, repo);
    assert.equal((await hookStatus(on, opts)).state, "none");
    console.log(await timed("hook install", () => installHook(on, hookText, opts)));
    const s = await timed("hook status", () => hookStatus(on, { ...opts, hookText }));
    assert.equal(s.state, "installed"); assert.equal(s.dataThere, true); assert.equal(s.current, true);
    const installed = await readTextFile(settings, { on });
    assert.equal(await readTextFile(`${settings}.bak-herdr-wingman`, { on }), original);
    assert.match(await installHook(on, hookText, opts), /^Already installed/);
    assert.equal(await readTextFile(settings, { on }), installed);

    // Claude edits a.txt: the hook runs as the settings entry says, in a terminal-like environment
    // (HC_TERMINAL_ID set, the throwaway home, nothing from Windows), its input piped by the script.
    const cmd = (event) => parseSettings(installed).hooks[event].at(-1).hooks[0].command;
    const runHook = (command, input) => sh(`printf %s "$1" | env -u WSLENV -u HC_TERMINAL_SOCKET -u HERDR_WINGMAN_DIR HOME="$2" HC_TERMINAL_ID=t9 sh -c "$3"`, input, home, command);
    await sh(`printf 'one\\nTWO\\n' > "$1/a.txt"`, repo);
    const event = JSON.stringify({ cwd: repo, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: `${repo}/a.txt` }, tool_response: { originalFile: "one\ntwo\n", type: "update" } });
    assert.equal(await runHook(cmd("PostToolUse"), event), "");
    assert.match(await sh(`ls "$1/events"`, data), /^\d+-t9-\d+\.json\n$/);
    const j = new Journal(() => {});
    const r = await timed("hook drain", () => j.drainOn(on, { dataDir: data }));
    assert.deepEqual(r, { installed: true, adopted: 1, events: 1 });
    assert.equal(await sh(`ls -A "$1/events"`, data), "");
    const index = JSON.parse(await readTextFile(`${repo}/.git/wingman/index.json`, { on }));
    assert.equal(index.files["a.txt"].by, `${on}/t9`);
    assert.equal(await readTextFile(`${repo}/.git/wingman/baselines/${index.files["a.txt"].baseline}`, { on }), "one\ntwo\n");

    // A note for that terminal: the hook hands it to Claude on its next prompt.
    await timed("hook feedback", () => queueFeedback(`${on}/t9`, "Code review: the user rejected line 2", { on, dataDir: data }));
    const out = JSON.parse(await runHook(cmd("UserPromptSubmit"), "{}"));
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Code review: the user rejected line 2" } });

    console.log(await timed("hook remove", () => uninstallHook(on, opts)));
    assert.equal(await readTextFile(settings, { on }), original);
    assert.equal(hookState(parseSettings(await readTextFile(settings, { on })), s.hook).state, "none");
    // Left in the home: the settings file and its backup, nothing else.
    assert.equal(await sh(`cd "$1" && find . | sort`, home), "./.claude\n./.claude/settings.json\n./.claude/settings.json.bak-herdr-wingman\n.\n".split("\n").filter(Boolean).sort().join("\n") + "\n");
  } finally {
    await exec("rm", ["-rf", "--", top], { on });
    assert.equal(await pathKind(top, { on }), null);
  }
}
console.log(`remote/wsl ok on ${on}`);
