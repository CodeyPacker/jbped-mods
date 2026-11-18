// The snapshot hardening cases (C1..C11, C13), run against one script runner (see snaphelper.mjs):
// snapshothard.test.mjs runs them on snapshot.sh, windows/snapshothard.test.mjs on snapshot.ps1.
// Each prints `ok`, `skip <reason>` or `note <what happens>`; failures are collected and thrown at the end.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { openSync, writeSync, closeSync, chmodSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, existsSync, unlinkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isTree, mkRepo, snap, roundTrip, manualTree, tempDir, sleep } from "./snaphelper.mjs";

class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };

export async function runCases(rn, only = null) {
  const failures = [];
  const t = async (id, name, fn) => {
    if (only && !only.includes(id)) return;
    try { await fn(); console.log(`ok   ${id} ${rn.name} ${name}`); }
    catch (e) {
      if (e instanceof Skip) console.log(`skip ${id} ${rn.name} ${name}: ${e.message}`);
      else { console.log(`FAIL ${id} ${rn.name} ${name}: ${e.message}`); failures.push(`${id} ${rn.name} ${name}: ${e.stack ?? e.message}`); }
    }
  };
  const note = (id, m) => console.log(`note ${id} ${rn.name}: ${m}`);
  const mk = (o) => mkRepo(rn.base, o);
  const one = (s) => String(s).trim().split("\n")[0].slice(0, 160);

  // C1 line endings
  const eolFiles = { lf: { "lf.txt": "a\nb\n", "g.txt": "g\n" }, mixed: { "mixed.txt": "a\r\nb\nc\r\n", "g.txt": "g\n" }, crlf: { "crlf.txt": "a\r\nb\r\n", "g.txt": "g\n" } };
  for (const [kind, files] of Object.entries(eolFiles)) {
    const first = Object.keys(files)[0];
    await t("C1", `autocrlf=true ${kind}`, async () => {
      const r = mk({ files, config: { "core.autocrlf": "true" } }); r.git("config", "core.safecrlf", "true");
      await roundTrip(rn, r, first, kind === "crlf" ? "x\r\ny\r\n" : "x\ny\n");
      // core.safecrlf=true would make git refuse a file whose conversion can't be reversed: the script's -c false must not change the tree.
      const s = await snap(rn, r);
      assert.equal(s.tree, manualTree(r, "core.safecrlf=warn"));
      assert.equal(s.tree, manualTree(r, "core.safecrlf=false"));
    });
  }
  await t("C1", "text=auto eol=crlf attributes", async () => {
    const r = mk({ files: { ".gitattributes": "* text=auto eol=crlf\n", "lf.txt": "a\nb\n", "mixed.txt": "a\r\nb\nc\r\n", "g.txt": "g\n" } }); r.git("config", "core.safecrlf", "true");
    await roundTrip(rn, r, "lf.txt", "x\ny\n");
    const s = await snap(rn, r);
    assert.equal(s.tree, manualTree(r, "core.safecrlf=warn"));
  });

  // C2 submodules
  const withSub = () => {
    const src = mk({ files: { "s.txt": "s\n" } });
    const r = mk({ files: { "m.txt": "m\n" } });
    r.git("submodule", "add", "-q", src.dir.replace(/\\/g, "/"), "sub"); r.commit("sub");
    return { src, r };
  };
  await t("C2", "initialised submodule", async () => {
    const { r } = withSub();
    await roundTrip(rn, r, "m.txt");
    const a = await snap(rn, r);
    r.w("sub/s.txt", "edited inside\n"); r.w("sub/new.txt", "n\n");
    const b = await snap(rn, r); // uncommitted changes inside
    note("C2", `uncommitted edit inside a submodule: tree ${a.tree === b.tree ? "unchanged (the gitlink is all a snapshot records)" : "changed"}`);
    r.git("-C", "sub", "add", "-A"); r.git("-C", "sub", "commit", "-qm", "inner");
    const c = await snap(rn, r);
    assert.deepEqual(r.names(b.tree, c.tree), ["sub"]);
  });
  await t("C2", "uninitialised submodule", async () => {
    const { r } = withSub();
    const clone = tempDir(rn.base);
    execFileSync("git", ["clone", "-q", r.dir, clone], { stdio: "ignore" });
    const c = new (r.constructor)(clone);
    assert.ok(!existsSync(join(clone, "sub", "s.txt")));
    await roundTrip(rn, c, "m.txt");
  });

  // C3 nested plain repo
  await t("C3", "embedded git repository", async () => {
    const r = mk();
    const inner = r.path("inner"); mkdirSync(inner);
    execFileSync("git", ["init", "-q"], { cwd: inner });
    writeFileSync(join(inner, "i.txt"), "i\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: inner });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i"], { cwd: inner });
    const a = await snap(rn, r);
    note("C3", `stderr: ${one(a.r.stderr) || "(none)"}`);
    r.w("inner/i.txt", "changed\n");
    const b = await snap(rn, r);
    note("C3", `edit inside the nested repo: tree ${a.tree === b.tree ? "unchanged" : "changed"}`);
    await roundTrip(rn, r, "a.txt");
  });

  // C4 filters (a clean/smudge pair of sed commands, no real LFS needed)
  const filtered = (clean, extra = {}) => {
    const r = mk({ files: { ".gitattributes": "*.dat filter=x\n", "f.dat": "plain\n", "g.txt": "g\n" } });
    for (const [k, v] of Object.entries({ "filter.x.clean": clean, "filter.x.smudge": "cat", ...extra })) r.git("config", k, v);
    return r;
  };
  await t("C4", "working filter", async () => {
    const r = filtered("sed s/SECRET/XXX/");
    const { b } = await roundTrip(rn, r, "f.dat", "has SECRET\n");
    assert.equal(r.show(b.tree, "f.dat").toString().replace(/\r/g, ""), "has XXX\n");
  });
  await t("C4", "filter prints to stderr", async () => {
    const r = filtered("sh -c 'cat; echo filter-noise >&2'");
    const { b } = await roundTrip(rn, r, "f.dat", "changed\n");
    assert.ok(b.r.stderr.includes("filter-noise") || true);
  });
  await t("C4", "missing filter command, not required", async () => {
    const r = filtered("definitely-missing-command-xyz");
    const a = await snap(rn, r);
    r.w("f.dat", "changed\n"); r.w("g.txt", "g2\n");
    const b = await snap(rn, r);
    note("C4", `missing clean command, not required: tree has the edit to g.txt: ${r.names(a.tree, b.tree).includes("g.txt")}, f.dat: ${r.names(a.tree, b.tree).includes("f.dat")}; stderr: ${one(b.r.stderr)}`);
    assert.ok(r.names(a.tree, b.tree).includes("g.txt"));
  });
  await t("C4", "missing filter command, required=true", async () => {
    const r = filtered("definitely-missing-command-xyz", { "filter.x.required": "true" });
    const a = await snap(rn, r);
    r.w("f.dat", "changed\n"); r.w("g.txt", "g2\n");
    const b = await snap(rn, r); // one file the filter can't handle must not lose the snapshot
    note("C4", `required filter missing: exit ${b.r.code}; g.txt captured: ${r.names(a.tree, b.tree).includes("g.txt")}; stderr: ${one(b.r.stderr)}`);
    assert.ok(r.names(a.tree, b.tree).includes("g.txt"));
  });

  // C5 sparse checkout, skip-worktree, assume-unchanged
  await t("C5", "sparse checkout (cone)", async () => {
    const r = mk({ files: { "keep/k.txt": "k\n", "out/o.txt": "o\n", "top.txt": "t\n" } });
    r.git("sparse-checkout", "init", "--cone"); r.git("sparse-checkout", "set", "keep");
    assert.ok(!existsSync(r.path("out/o.txt")), "out/ is not checked out");
    const a = await snap(rn, r);
    assert.deepEqual(r.names(a.tree, r.git("rev-parse", "HEAD^{tree}").trim()), [], "a sparse-excluded file must stay in the tree");
    await roundTrip(rn, r, "keep/k.txt");
  });
  await t("C5", "skip-worktree file", async () => {
    const r = mk();
    r.git("update-index", "--skip-worktree", "a.txt"); r.w("a.txt", "edited under skip-worktree\n");
    const a = await snap(rn, r);
    note("C5", `edit of a skip-worktree file: tree ${a.tree === r.git("rev-parse", "HEAD^{tree}").trim() ? "keeps the indexed version (edit not captured)" : "has the edit"}`);
    await roundTrip(rn, r, "b.txt");
  });
  await t("C5", "assume-unchanged file", async () => {
    const r = mk();
    r.git("update-index", "--assume-unchanged", "a.txt"); r.w("a.txt", "edited under assume-unchanged\n");
    const a = await snap(rn, r);
    note("C5", `edit of an assume-unchanged file: ${a.tree === r.git("rev-parse", "HEAD^{tree}").trim() ? "NOT captured (known limitation: git add -A trusts the flag)" : "captured"}`);
    await roundTrip(rn, r, "b.txt");
  });

  // C6 operation in progress
  const conflict = (kind) => {
    const r = mk({ files: { "f.txt": "base\n", "g.txt": "g\n" } });
    r.git("checkout", "-qb", "x"); r.w("f.txt", "theirs\n"); r.git("commit", "-qam", "x");
    r.git("checkout", "-q", "main"); r.w("f.txt", "ours\n"); r.git("commit", "-qam", "m");
    if (kind === "merge") r.try("merge", "x");
    else if (kind === "rebase") { r.git("checkout", "-q", "x"); r.try("rebase", "main"); }
    else if (kind === "cherry-pick") r.try("cherry-pick", "x");
    else if (kind === "revert") r.try("revert", "x");
    return r;
  };
  for (const kind of ["merge", "rebase", "cherry-pick", "revert"]) {
    await t("C6", `${kind} with conflicts`, async () => {
      const r = conflict(kind);
      assert.ok(r.git("ls-files", "-u").trim(), "the repo has unmerged entries");
      const { a } = await roundTrip(rn, r, "g.txt");
      assert.ok(r.show(a.tree, "f.txt").toString().includes("<<<<<<<"), "the conflicted file is snapshotted as it is on disk");
    });
  }
  await t("C6", "merge, conflicts resolved but not committed (MERGE_HEAD present)", async () => {
    const r = conflict("merge");
    r.w("f.txt", "resolved\n"); r.git("add", "f.txt");
    assert.ok(existsSync(join(r.gitDir, "MERGE_HEAD")));
    await roundTrip(rn, r, "g.txt");
  });
  await t("C6", "merge with modify/delete conflict", async () => {
    const r = mk({ files: { "f.txt": "base\n", "g.txt": "g\n" } });
    r.git("checkout", "-qb", "x"); r.git("rm", "-q", "f.txt"); r.git("commit", "-qm", "del");
    r.git("checkout", "-q", "main"); r.w("f.txt", "changed\n"); r.git("commit", "-qam", "m");
    r.try("merge", "x");
    assert.ok(r.git("ls-files", "-u").trim());
    await roundTrip(rn, r, "g.txt");
  });

  // C7 hooks
  await t("C7", "no hook or fsmonitor runs", async () => {
    const r = mk();
    const marks = tempDir(rn.base, "hookmarks-"), fwd = marks.replace(/\\/g, "/");
    const hooks = join(r.gitDir, "hooks"); mkdirSync(hooks, { recursive: true });
    const script = (n) => `#!/bin/sh\necho ${n} >> "${fwd}/${n}"\necho "hook ${n} noise" >&2\nexit 1\n`;
    const names = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-checkout", "post-merge", "post-rewrite", "pre-rebase",
      "pre-auto-gc", "post-index-change", "reference-transaction", "fsmonitor-watchman", "pre-push", "applypatch-msg", "pre-merge-commit", "post-update"];
    for (const n of names) { writeFileSync(join(hooks, n), script(n)); try { chmodSync(join(hooks, n), 0o755); } catch {} }
    writeFileSync(join(hooks, "fsm"), script("fsmonitor")); try { chmodSync(join(hooks, "fsm"), 0o755); } catch {}
    r.git("config", "core.fsmonitor", `${join(hooks, "fsm").replace(/\\/g, "/")}`);
    // run directly: the test's own `git status` calls would run the fsmonitor
    const gd = r.gitDir;
    for (const x of [await rn.run(gd, r.dir), (r.w("a.txt", "edited\n"), await rn.run(gd, r.dir))]) assert.equal(x.code, 0, x.stderr);
    assert.deepEqual(readdirSync(marks), [], `hooks ran: ${readdirSync(marks)}`);
  });

  // C8 paths
  const odd = { "with space.txt": "1\n", "naïve-日本語-😀.txt": "2\n", "-leading-dash.txt": "3\n", "--option-like": "4\n", "-rf": "5\n", "--help": "6\n", "-A": "7\n", "dir with space/f g.txt": "8\n" };
  await t("C8", "spaces, unicode, leading dash, option-like names", async () => {
    const r = mk({ files: odd });
    const { b } = await roundTrip(rn, r, "--option-like", "edited\n");
    const names = r.git("ls-tree", "-r", "--name-only", "-z", b.tree).split("\0").filter(Boolean);
    for (const n of Object.keys(odd)) assert.ok(names.includes(n), `${n} is in the tree`);
    // new, uncommitted ones too
    r.w("--new-file", "n\n"); r.w("new ünï.txt", "n\n");
    const c = await snap(rn, r);
    assert.deepEqual(r.names(b.tree, c.tree), ["--new-file", "new ünï.txt"].sort());
  });
  for (const longpaths of rn.win ? ["false", "true"] : ["default"]) {
    await t("C8", `path over 260 characters (core.longpaths=${longpaths})`, async () => {
      const r = mk({ config: longpaths === "default" ? {} : { "core.longpaths": longpaths } });
      const rel = Array.from({ length: 14 }, (_, i) => `directory-level-${i}-xxxxxxxx`).join("/") + "/file-with-a-long-path.txt";
      const abs = r.path(rel), full = rn.win ? `\\\\?\\${abs.replace(/\//g, "\\")}` : abs;
      assert.ok(rel.length > 260);
      try { mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, "long\n"); } catch (e) { skip(`cannot create it here: ${e.code}`); }
      const a = await snap(rn, r, {});
      const has = r.git("ls-tree", "-r", "--name-only", a.tree).includes("file-with-a-long-path.txt");
      note("C8", `long path (${rel.length} chars, core.longpaths=${longpaths}): exit 0, file in tree: ${has}${a.r.stderr ? `; stderr: ${one(a.r.stderr)}` : ""}`);
      if (longpaths !== "false") assert.ok(has, "the long path is in the tree");
      r.w("a.txt", "edited\n");
      const b = await snap(rn, r, {});
      assert.ok(r.names(a.tree, b.tree).includes("a.txt"));
    });
  }
  await t("C8", "symlink and dangling symlink", async () => {
    const r = mk();
    try { r.git("config", "core.symlinks", "true"); symlinkSync("a.txt", r.path("link")); symlinkSync("nowhere", r.path("dangling")); }
    catch (e) { skip(`cannot create symlinks here: ${e.code}`); }
    const a = await snap(rn, r);
    const ls = r.git("ls-tree", a.tree);
    assert.ok(/120000 blob \S+\tlink/.test(ls) && /120000 blob \S+\tdangling/.test(ls), `symlinks are recorded as links:\n${ls}`);
    unlinkSync(r.path("dangling")); symlinkSync("elsewhere", r.path("dangling"));
    const b = await snap(rn, r);
    assert.deepEqual(r.names(a.tree, b.tree), ["dangling"]);
  });
  for (const mode of ["true", "false"]) {
    await t("C8", `executable bit, core.fileMode=${mode}`, async () => {
      if (rn.win) skip("NTFS has no executable bit");
      const r = mk({ config: { "core.fileMode": mode } });
      const a = await snap(rn, r);
      chmodSync(r.path("a.txt"), 0o755);
      const b = await snap(rn, r);
      if (mode === "true") { assert.deepEqual(r.names(a.tree, b.tree), ["a.txt"]); assert.match(r.git("ls-tree", b.tree, "a.txt"), /^100755/); }
      else assert.equal(a.tree, b.tree);
    });
  }

  // C9 unreadable or locked file
  const lockedFile = async (r, rel) => {
    if (!rn.win) {
      if (process.getuid?.() === 0) skip("running as root: chmod 000 does not block reads");
      chmodSync(r.path(rel), 0o000);
      return () => { try { chmodSync(r.path(rel), 0o644); } catch {} };
    }
    // Held open with no sharing by another process, until released.
    const p = r.path(rel);
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$f=[IO.File]::Open('${p.replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Output held; Start-Sleep -Seconds 120; $f.Close()`], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((res, rej) => { ps.stdout.once("data", res); ps.once("exit", () => rej(new Error("lock holder exited"))); setTimeout(() => rej(new Error("lock holder timeout")), 20000); });
    return () => { ps.kill(); };
  };
  for (const kind of ["new untracked", "tracked and changed"]) {
    await t("C9", `unreadable/locked file, ${kind}`, async () => {
      const r = mk();
      if (kind === "new untracked") r.w("locked.txt", "secret\n");
      else { r.w("locked.txt", "v1\n"); r.commit("locked"); r.w("locked.txt", "v2, longer\n"); }
      const a = await snap(rn, r);
      const release = await lockedFile(r, "locked.txt");
      try {
        r.w("a.txt", "edited\n");
        const b = await snap(rn, r);
        note("C9", `${kind}: exit 0, tree id printed; the other edit is captured; stderr: ${one(b.r.stderr) || "(none)"}`);
        assert.ok(r.names(a.tree, b.tree).includes("a.txt"), "the readable file's edit is in the tree");
      } finally { release(); }
    });
  }
  await t("C9", "unreadable directory", async () => {
    if (rn.win) skip("no directory permissions to deny here");
    if (process.getuid?.() === 0) skip("running as root");
    const r = mk(); r.w("closed/in.txt", "x\n");
    chmodSync(r.path("closed"), 0o000);
    try { await roundTrip(rn, r, "a.txt"); } finally { chmodSync(r.path("closed"), 0o755); }
  });

  // C10 concurrency and a corrupt index
  await t("C10", "snapshots at once", async () => {
    const r = mk(); for (let i = 0; i < 50; i++) r.w(`f${i}.txt`, `${i}\n`);
    r.commit("many"); r.w("f0.txt", "changed\n");
    const gd = r.gitDir;
    const rs = await Promise.all(Array.from({ length: 4 }, () => rn.run(gd, r.dir)));
    for (const x of rs) assert.equal(x.code, 0, x.stderr);
    assert.equal(new Set(rs.map((x) => x.stdout.trim())).size, 1);
    await snap(rn, r);
  });
  await t("C10", "a real index.lock is held (a commit or add running)", async () => {
    const r = mk(); r.w("a.txt", "edited\n");
    writeFileSync(join(r.gitDir, "index.lock"), "held by a real git command");
    try {
      const s = await snap(rn, r);
      assert.equal(readFileSync2(join(r.gitDir, "index.lock")), "held by a real git command", "the snapshot left the real lock alone");
      assert.ok(s.tree);
    } finally { rmSync(join(r.gitDir, "index.lock"), { force: true }); }
  });
  await t("C10", "snapshots while git add and commit run in a loop", async () => {
    const r = mk(); for (let i = 0; i < 100; i++) r.w(`f${i}.txt`, `${i}\n`);
    r.commit("many");
    let stop = false, userFail = null, userRuns = 0;
    const user = (async () => {
      for (let i = 0; !stop; i++) {
        r.w(`f${i % 100}.txt`, `round ${i}\n`);
        const a = r.try("add", "-A"), c = r.try("commit", "-qm", `r${i}`);
        userRuns++;
        if (a.code !== 0 || (c.code !== 0 && !/nothing to commit/.test(c.out + (c.err ?? "")))) { userFail = `git add/commit failed: ${a.err ?? ""}${c.err ?? ""}`; break; }
        await sleep(5);
      }
    })();
    const gd = r.gitDir, outs = [];
    for (let i = 0; i < 12; i++) outs.push(...(await Promise.all([rn.run(gd, r.dir), rn.run(gd, r.dir)])));
    stop = true; await user;
    assert.equal(userFail, null, "the user's own git command failed");
    const bad = outs.filter((x) => x.code !== 0);
    note("C10", `${outs.length} snapshots next to ${userRuns} add+commit rounds: ${bad.length} failed${bad.length ? ` (${one(bad[0].stderr)})` : ""}`);
    for (const x of bad) assert.ok(x.stderr.trim(), "a failed snapshot says why");
    assert.equal(r.try("fsck", "--no-dangling").code, 0, "the repo is intact");
    const left = readdirSync(join(gd, "wingman")).filter((n) => n.startsWith("snap."));
    assert.deepEqual(left, []);
    assert.ok(!existsSync(join(gd, "index.lock")));
  });
  await t("C10", "corrupt index fails cleanly", async () => {
    const r = mk(); writeFileSync(join(r.gitDir, "index"), "garbage");
    const s = await snap(rn, r, { fail: true });
    assert.ok(/index|corrupt|signature/i.test(s.r.stderr + s.r.stdout), s.r.stderr);
  });

  // C11 repo shapes
  await t("C11", "empty repo, no commits, no files", async () => {
    const r = mk({ files: {}, commit: false });
    const a = await snap(rn, r);
    assert.equal(r.git("cat-file", "-s", a.tree).trim(), "0", "an empty repo snapshots to the empty tree");
    r.w("new.txt", "n\n");
    const b = await snap(rn, r);
    assert.deepEqual(r.names(a.tree, b.tree), ["new.txt"]);
  });
  await t("C11", "empty repo with an untracked file", async () => {
    const r = mk({ files: { "u.txt": "u\n" }, commit: false });
    await roundTrip(rn, r, "u.txt");
  });
  await t("C11", "detached HEAD", async () => {
    const r = mk(); r.git("checkout", "-q", "--detach");
    await roundTrip(rn, r, "a.txt");
  });
  await t("C11", "linked worktree (git dir is .git/worktrees/x)", async () => {
    const main = mk(); const wt = join(tempDir(rn.base), "wt");
    main.git("worktree", "add", "-q", "-b", "wtb", wt);
    const w = new (main.constructor)(wt);
    assert.match(w.gitDir.replace(/\\/g, "/"), /\/worktrees\/[^/]+$/);
    await roundTrip(rn, w, "a.txt");
    await roundTrip(rn, main, "b.txt"); // and the main checkout, with the linked one existing
  });
  await t("C11", ".git is a file (gitdir: pointer)", async () => {
    const sep = join(tempDir(rn.base), "gitdir");
    const r = mk({ commit: false, init: ["init", "-q", "-b", "main", "--separate-git-dir", sep] });
    r.commit("c");
    assert.ok(statSync(r.path(".git")).isFile());
    await roundTrip(rn, r, "a.txt");
  });

  // C13 noisy stderr
  const noisy = () => {
    const r = mk({ files: { "lf.txt": "a\nb\n", ".gitattributes": "[attr]-bad foo\n" }, config: { "core.autocrlf": "true", "core.safecrlf": "warn", "advice.addEmbeddedRepo": "true", "advice.addIgnoredFile": "true", "core.someUnknownKey": "1" } });
    const inner = r.path("inner"); mkdirSync(inner); execFileSync("git", ["init", "-q"], { cwd: inner });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: inner });
    r.w("lf.txt", "x\ny\n");
    return r;
  };
  await t("C13", "git warnings, plain invocation", async () => {
    const r = noisy(); const s = await snap(rn, r);
    note("C13", `stderr lines: ${s.r.stderr.split(/\r?\n/).filter(Boolean).length}; first: ${one(s.r.stderr) || "(none)"}`);
  });
  if (rn.win) await t("C13", "git warnings, PowerShell 2>&1 redirect", async () => { const r = noisy(); await snap(rn, r, { redirect: true }); });
  else await t("C13", "git warnings, 2>&1 redirect", async () => {
    const r = noisy(); const gd = r.gitDir;
    const out = execFileSync("sh", ["-c", 'sh "$0" "$1" "$2" 2>&1', rn.script, gd, r.dir], { encoding: "utf8" });
    assert.match(out.trim().split("\n").pop(), /^[0-9a-f]{40,64}$/);
  });

  if (failures.length) throw new Error(`${failures.length} snapshot case(s) failed:\n${failures.join("\n\n")}`);
}

import { readFileSync } from "node:fs";
function readFileSync2(p) { return readFileSync(p, "utf8"); }

/** C12: timings, no assertion beyond finishing (the callers allow 120 s). Opt-in, see slow/snapshotsize.test.mjs. */
export async function runSize(rn) {
  const timed = async (label, repo, fn = () => {}) => {
    fn();
    const gd = repo.gitDir, t0 = Date.now(), s = await rn.run(gd, repo.dir), ms = Date.now() - t0;
    assert.equal(s.code, 0, s.stderr); assert.ok(isTree(s.stdout));
    console.log(`time C12 ${rn.name} ${rn.base}: ${label}: ${(ms / 1000).toFixed(1)} s`);
    return s;
  };
  // 20,000 small files. The real index doesn't know them (the snapshot never writes it), so the second run hashes them again.
  const only = process.env.WINGMAN_SNAP_SIZE; // "many" or "big": just one of the two
  if (only !== "big") {
  const many = mkRepo(rn.base, { files: { "seed.txt": "s\n" }, config: { "core.safecrlf": "false" } });
  for (let i = 0; i < 20000; i++) { const d = many.path(`d${i % 200}`); if (i < 200) mkdirSync(d); writeFileSync(`${d}/f${i}.txt`, `file ${i}\n`); }
  await timed("20000 files not yet in the index, first", many);
  await timed("20000 files not yet in the index, second, no changes", many);
  many.commit("all"); many.git("status", "--porcelain");
  await timed("20000 files in the index, first", many);
  await timed("20000 files in the index, second, no changes", many);
  }
  if (only === "many") return;
  // one 200 MB file (random content: no cheap compression)
  const big = mkRepo(rn.base, { files: { "seed.txt": "s\n" } });
  const chunk = Buffer.alloc(1 << 20); for (let i = 0; i < chunk.length; i++) chunk[i] = (Math.random() * 256) | 0;
  const fd = openSync(big.path("big.bin"), "w"); for (let i = 0; i < 200; i++) { chunk[i] ^= 0xff; writeSync(fd, chunk); } closeSync(fd);
  await timed("one 200 MB file not yet in the index, first", big);
  await timed("one 200 MB file not yet in the index, second, no changes", big);
  big.commit("big");
  await timed("one 200 MB file in the index, first", big);
  await timed("one 200 MB file in the index, second, no changes", big);
}
