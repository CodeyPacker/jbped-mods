// G6 sync: ahead/behind from local refs, Fetch, Pull (fast-forward only), Push and Publish against
// LOCAL bare remotes only, the argument lists hostile names can reach, and a remote that wants a
// password failing at once instead of waiting for a prompt.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";

// No user or system git config: no credential helper, no GCM window, no hooks of the user's.
const cfg = mkdtempSync(`${tmpdir()}/sy-cfg-`);
writeFileSync(`${cfg}/gitconfig`, "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = `${cfg}/gitconfig`; process.env.GIT_CONFIG_NOSYSTEM = "1";

const { parseTrack, parseInfo, parseRemotes, counts, cantSync, fetchArgs, pullArgs, pushArgs, publishArgs, cantPublish, confirmText, errorLine, cleanLine, failMessage, runSync, readInfo, envCandidates, unpublishedArgs, SYNC_ENV } = await import("../mods/wingman/sync.js");
const { git } = await import("../mods/wingman/git.js");
const { branchOf } = await import("../mods/wingman/store.js");
const { remoteCalls } = await import("herdr");

// ---- pure ----
assert.deepEqual(parseTrack("ahead 2, behind 1"), { ahead: 2, behind: 1, gone: false });
assert.deepEqual(parseTrack("behind 3"), { ahead: 0, behind: 3, gone: false });
assert.deepEqual(parseTrack(""), { ahead: 0, behind: 0, gone: false });
assert.deepEqual(parseTrack("gone"), { ahead: 0, behind: 0, gone: true });
assert.deepEqual(parseRemotes("origin\nup-stream\n-f\n--force\n../x\nhttp://h/x\n"), ["origin", "up-stream"]);
{
  const out = "refs/heads/main\0refs/remotes/origin/main\0origin/main\0ahead 2, behind 1\0origin\0refs/heads/main\n";
  const i = parseInfo("main", out, ["origin"]);
  assert.equal(i.upstream, "origin/main"); assert.equal(i.remote, "origin"); assert.equal(i.remoteRef, "refs/heads/main");
  assert.equal(counts(i), "↑2 ↓1");
  assert.equal(cantSync(i, "pull"), null); assert.equal(cantSync(i, "push"), null);
  assert.deepEqual(pushArgs(i), ["push", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", "refs/heads/main:refs/heads/main"]);
  assert.deepEqual(pullArgs(i), ["pull", "--ff-only", "--no-rebase", "--no-autostash", "--", "origin", "refs/heads/main"]);
  assert.match(confirmText("push", i), /^Push 2 commits from main to origin\/main\? It's 1 behind/);
  // No upstream: push says publish; detached: nothing but fetch.
  const none = parseInfo("feat", "refs/heads/feat\0\0\0\0\0\n", ["origin"]);
  assert.equal(none.upstream, null); assert.match(cantSync(none, "push"), /no upstream: Publish it/); assert.equal(cantPublish(none), null);
  assert.equal(counts(none), "");
  assert.deepEqual(publishArgs(none), ["push", "-u", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", "refs/heads/feat:refs/heads/feat"]);
  assert.match(cantPublish(parseInfo("feat", "", ["upstream"])), /no remote named origin/);
  const det = parseInfo("@0123456789ab", "", ["origin"]);
  assert.equal(det.detached, true); assert.match(cantSync(det, "pull"), /detached/); assert.match(cantPublish(det), /detached/);
  assert.deepEqual(fetchArgs(det), ["fetch", "--", "origin"]);
  assert.match(cantSync(parseInfo(null, "", []), "push"), /No commits yet/);
  // Gone, local upstream, nothing to push.
  assert.match(cantSync(parseInfo("main", "refs/heads/main\0refs/remotes/origin/main\0origin/main\0gone\0origin\0refs/heads/main\n", ["origin"]), "push"), /gone/);
  assert.match(cantSync(parseInfo("main", "refs/heads/main\0refs/heads/dev\0dev\0\0.\0refs/heads/dev\n", ["origin"]), "push"), /local branch/);
  assert.match(cantSync(parseInfo("main", "refs/heads/main\0refs/remotes/origin/main\0origin/main\0\0origin\0refs/heads/main\n", ["origin"]), "push"), /Nothing to push/);
  assert.throws(() => fetchArgs(parseInfo("main", "", [])), /no remote/);
}
// The refusal list: whatever a ref, a remote or the upstream config holds, the argument lists
// never carry a force, a delete, tags, --all, --mirror or --no-verify, and the refspec's source is
// always refs/heads/<the branch>.
{
  const bad = /^(-f|--force.*|--mirror|--all|--tags|--delete|-d|--no-verify|-n|--prune|--follow-tags|-o|--push-option.*|--exec.*|--receive-pack.*|--upload-pack.*|--repo.*|-u)$/;
  const hostile = ["-f", "--force", "+main", "+refs/heads/x", ":refs/heads/main", "--mirror", "main:main", "--all", "-o x", "refs/heads/a:refs/heads/b", "a..b", "--no-verify", "@{-1}", "x;rm -rf /", "-", ".", "..", "--receive-pack=sh"];
  let tried = 0;
  for (const branch of ["main", "+x", "a;b", ...hostile]) for (const remote of ["origin", ...hostile]) for (const ref of ["refs/heads/main", ...hostile]) {
    const out = `refs/heads/${branch}\0refs/remotes/${remote}/x\0${remote}/x\0ahead 1\0${remote}\0${ref}\n`;
    for (const remotes of [[remote], ["origin"], parseRemotes([remote, "origin"].join("\n"))]) {
      const i = parseInfo(branch, out, remotes);
      for (const make of [pushArgs, publishArgs, pullArgs, fetchArgs]) {
        let a;
        try { a = make(i); } catch { continue; }
        tried++;
        const dd = a.indexOf("--"), opts = a.slice(1, dd), after = a.slice(dd + 1);
        for (const x of opts) assert.ok(!bad.test(x) || (make === publishArgs && x === "-u"), `${make.name}: ${x}`);
        assert.ok(dd > 0, "-- before the remote");
        assert.ok(!after[0].startsWith("-") && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(after[0]), `remote ${after[0]}`);
        if (make === pushArgs || make === publishArgs) {
          assert.equal(after.length, 2);
          assert.ok(after[1].startsWith(`refs/heads/${branch}:refs/heads/`), after[1]);
          assert.equal(after[1].split(":").length, 2);
        }
        if (make === pullArgs) assert.ok(/^refs\/heads\/[^:]+$/.test(after[1]));
      }
    }
  }
  assert.ok(tried > 50, `checked ${tried}`);
}
assert.equal(errorLine("hint: x\nfatal: Not possible to fast-forward, aborting.\nhint: y\n"), "fatal: Not possible to fast-forward, aborting.");
assert.equal(errorLine("To x\n ! [rejected] main -> main (fetch first)\nerror: failed to push some refs to 'x'\n"), "error: failed to push some refs to 'x'");
assert.equal(errorLine("error: Your local changes to the following files would be overwritten by checkout:\n\tmath.js\n\tb c.js\nPlease commit your changes or stash them before you switch branches.\nAborting\n"),
  "error: Your local changes to the following files would be overwritten by checkout: math.js, b c.js");
assert.match(failMessage("push", { code: 1, stderr: "To x\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'x'\nhint: Updates were rejected\n" }), /^The remote has commits this branch doesn't: Pull first \(nothing was forced\)\. git: error: failed to push/);
assert.equal(cleanLine("a\x1b[31mred\x07\u202Eevil\nb"), "a[31mredevil b");
assert.equal(cleanLine("x".repeat(400)).length, 300);
assert.match(failMessage("push", new Error("timed out")), /timed out after 120 s/);
assert.match(failMessage("fetch", new Error("`herdr.exec`: wsl.exe took longer than 120 s and was stopped")), /^git fetch timed out after 120 s: run it once in a terminal/);
assert.deepEqual(envCandidates("C:\\Program Files\\Git\\cmd\\git.exe\r\n"), ["C:/Program Files/Git/usr/bin/env.exe", "C:/Program Files/usr/bin/env.exe"]);
assert.ok(envCandidates("C:\\Program Files\\Git\\mingw64\\bin\\git.exe").includes("C:/Program Files/Git/usr/bin/env.exe"));
assert.ok(SYNC_ENV.includes("GIT_TERMINAL_PROMPT=0"));

// ---- real repos, local bare remotes ----
const made = [cfg];
const tmp = (p) => { const d = mkdtempSync(`${tmpdir()}/${p}`); made.push(d); return d; };
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const bare = tmp("sy-bare-");
sh(bare, "init", "-q", "--bare", "-b", "main");
const a = tmp("sy-a-"), b = tmp("sy-b-");
sh(a, "init", "-q", "-b", "main"); writeFileSync(`${a}/f.txt`, "1\n"); sh(a, "add", "."); sh(a, "commit", "-qm", "one");
sh(a, "remote", "add", "origin", bare);
const stA = { root: a, on: null }, stB = { root: b, on: null };
const info = async (dir) => readInfo((args) => git(args, { cwd: dir }), branchOf(readFileSync(`${dir}/.git/HEAD`, "utf8")));
const ok = (r, what) => { assert.equal(r.code, 0, `${what}: ${r.stderr}`); return r; };
try {
  // Publish: no upstream, origin exists.
  let i = await info(a);
  assert.equal(i.upstream, null); assert.deepEqual(i.remotes, ["origin"]);
  assert.equal(Number(sh(a, ...unpublishedArgs())), 1);
  ok(await runSync(stA, publishArgs(i)), "publish");
  i = await info(a);
  assert.equal(i.upstream, "origin/main"); assert.equal(counts(i), "");
  assert.equal(sh(bare, "rev-parse", "main"), sh(a, "rev-parse", "HEAD"));
  assert.equal(sh(a, "config", "branch.main.remote"), "origin");
  // A tag isn't pushed with the branch.
  sh(a, "tag", "v1"); sh(a, "tag", "-a", "v2", "-m", "t");
  writeFileSync(`${a}/f.txt`, "1\n2\n"); sh(a, "commit", "-qam", "two");
  i = await info(a);
  assert.equal(i.ahead, 1); assert.equal(counts(i), "↑1");
  ok(await runSync(stA, pushArgs(i)), "push");
  assert.equal(sh(bare, "rev-parse", "main"), sh(a, "rev-parse", "HEAD"));
  assert.equal(sh(bare, "tag"), "", "no tags pushed");
  assert.equal((await info(a)).ahead, 0);
  // Another clone moves the remote; a fetch shows ↓1, pull fast-forwards.
  sh(b, "clone", "-q", bare, ".");
  writeFileSync(`${b}/g.txt`, "g\n"); sh(b, "add", "."); sh(b, "commit", "-qm", "three"); sh(b, "push", "-q");
  assert.equal((await info(a)).behind, 0, "local refs only: no fetch yet");
  ok(await runSync(stA, fetchArgs(await info(a))), "fetch");
  i = await info(a);
  assert.equal(i.behind, 1); assert.equal(counts(i), "↓1");
  ok(await runSync(stA, pullArgs(i)), "pull");
  assert.equal(sh(a, "rev-parse", "HEAD"), sh(b, "rev-parse", "HEAD"));
  assert.equal(readFileSync(`${a}/g.txt`, "utf8"), "g\n");
  // Diverged: pull refuses and nothing changes (no merge, no rebase, local edits kept).
  writeFileSync(`${b}/g.txt`, "g\nfrom b\n"); sh(b, "commit", "-qam", "b4"); sh(b, "push", "-q");
  writeFileSync(`${a}/f.txt`, "1\n2\nfrom a\n"); sh(a, "commit", "-qam", "a4");
  writeFileSync(`${a}/f.txt`, "1\n2\nfrom a\nunsaved\n");
  ok(await runSync(stA, fetchArgs(await info(a))), "fetch 2");
  i = await info(a);
  assert.equal(counts(i), "↑1 ↓1");
  const head = sh(a, "rev-parse", "HEAD"), status = sh(a, "status", "--porcelain");
  const r = await runSync(stA, pullArgs(i));
  assert.notEqual(r.code, 0);
  assert.match(failMessage("pull", r), /^Can't fast-forward: .*Nothing was changed \(no merge, no rebase\)\. git: fatal: Not possible to fast-forward/);
  assert.equal(sh(a, "rev-parse", "HEAD"), head); assert.equal(sh(a, "status", "--porcelain"), status);
  assert.equal(readFileSync(`${a}/f.txt`, "utf8"), "1\n2\nfrom a\nunsaved\n");
  assert.equal(sh(a, "log", "--format=%s", "-1"), "a4");
  // Push of a branch that's behind is git's refusal (never forced): the remote keeps b's commit.
  const p = await runSync(stA, pushArgs(i));
  assert.notEqual(p.code, 0); assert.match(failMessage("push", p), /error: failed to push some refs/);
  assert.equal(sh(bare, "rev-parse", "main"), sh(b, "rev-parse", "HEAD"));
  // Detached HEAD: counts and pull/push off, fetch still works.
  sh(a, "stash", "-q"); sh(a, "checkout", "-q", "--detach");
  i = await info(a);
  assert.equal(i.detached, true); assert.throws(() => pushArgs(i), /detached/);
  ok(await runSync(stA, fetchArgs(i)), "fetch detached");
  sh(a, "checkout", "-q", "main"); sh(a, "stash", "pop", "-q");
  // A new branch: Push says publish; Publish makes origin/feat and tracks it.
  sh(a, "switch", "-q", "-c", "feat");
  i = await info(a);
  assert.match(cantSync(i, "push"), /Publish/);
  ok(await runSync(stA, publishArgs(i)), "publish feat");
  assert.equal((await info(a)).upstream, "origin/feat");
  assert.equal(sh(bare, "rev-parse", "feat"), sh(a, "rev-parse", "HEAD"));
  // Another machine: the same call runs there (the shim runs `on` calls here and records them), through env.
  const before = remoteCalls.length;
  ok(await runSync({ root: a, on: "box" }, fetchArgs(await info(a))), "fetch on box");
  const call = remoteCalls.slice(before).find((c) => c.cmd === "env");
  assert.ok(call && call.on === "box" && call.args.includes("GIT_TERMINAL_PROMPT=0") && call.args.includes("git"), JSON.stringify(call));

  // A remote that needs a login fails at once (no prompt waits): an HTTP 401 server, and a port
  // nothing listens on (one just closed: in this test sandbox a connect to port 9 is dropped, not
  // refused, so there it ends only at the 120 s limit, which the shim's exec doesn't apply).
  const server = createServer((_req, res) => { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="x"' }); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  sh(a, "remote", "add", "auth", `http://127.0.0.1:${port}/x.git`);
  const gone = createServer(); await new Promise((r) => gone.listen(0, "127.0.0.1", r));
  const deadPort = gone.address().port; await new Promise((r) => gone.close(r));
  sh(a, "remote", "add", "dead", `http://127.0.0.1:${deadPort}/x.git`);
  for (const [remote, want] of [["auth", /terminal prompts disabled|could not read Username/i], ["dead", /(Failed to connect|Couldn't connect|Connection refused)/i]]) {
    const t0 = Date.now();
    const rr = await runSync(stA, ["fetch", "--", remote], 20000);
    const ms = Date.now() - t0;
    assert.notEqual(rr.code, 0); assert.ok(ms < 10000, `${remote} took ${ms} ms`);
    const msg = failMessage("fetch", rr);
    assert.match(msg, want, msg);
    if (remote === "auth") assert.match(msg, /run it once in a terminal/);
    assert.ok(!/[\x00-\x1F]/.test(msg));
  }
  server.closeAllConnections(); server.close();
} finally {
  for (const d of made) rmSync(d, { recursive: true, force: true });
}
