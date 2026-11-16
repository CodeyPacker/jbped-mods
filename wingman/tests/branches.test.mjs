// G6 branches: names checked before git sees them (hostile ones refused), the list (current first,
// most recent next, capped), switching with git's own refusal intact, unsaved edits blocking a
// switch, and Review's per-branch parking bringing back the same review after a switch and back.
import { nameProblem, checkArgs, LIST, parseBranches, switchArgs, createArgs, unsavedIn, unsavedMessage, ago, MAX_BRANCHES } from "../mods/wingman/branches.js";
import { git } from "../mods/wingman/git.js";
import { Store } from "../mods/wingman/store.js";
import { Capture } from "../mods/wingman/capture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const hostile = ["-x", "--force", "-", "--discard-changes", "a..b", "a b", " a", "a\tb", "a;b c", "a\nb", "x~1", "x^", "a:b", "a?", "a*", "a[b", "a\\b",
  "@{-1}", "x@{u}", "@", "HEAD", "x.lock", "a/.b", "a/", "/a", "a//b", ".a", "a.", "", "   ", "\x1b[31m", "x".repeat(201)];
for (const n of hostile) {
  assert.ok(nameProblem(n), `refused: ${JSON.stringify(n)}`);
  assert.throws(() => switchArgs(n)); assert.throws(() => createArgs(n));
}
for (const n of ["main", "feature/x-1", "a;b", "+x", "release-2.0", "ü"]) assert.equal(nameProblem(n), null, n);
assert.deepEqual(switchArgs("a;b"), ["switch", "--no-guess", "--", "a;b"]);
assert.deepEqual(createArgs("feat/1"), ["switch", "--no-track", "-c", "feat/1", "HEAD"]);
// Never a force, a discard or a merge of local changes, never a stash.
for (const a of [switchArgs("x"), createArgs("x")]) for (const x of a) assert.ok(!/^(-f|--force|--discard-changes|-m|--merge|--conflict.*|stash|-C|--force-create)$/.test(x), x);

// parseBranches: current first, then by date as listed, capped.
{
  const out = ["refs/heads/b\x00300", "refs/heads/main\x00100", "refs/heads/a\x00200", "refs/tags/v1\x0050", ""].join("\n");
  const { list, more } = parseBranches(out, "main");
  assert.deepEqual(list.map((b) => b.name), ["main", "b", "a"]); assert.equal(list[0].current, true); assert.equal(more, false);
  const many = Array.from({ length: MAX_BRANCHES + 1 }, (_, i) => `refs/heads/n${i}\x00${1000 - i}`).join("\n");
  const r = parseBranches(many, `n${MAX_BRANCHES}`);
  assert.equal(r.list.length, MAX_BRANCHES); assert.equal(r.list[0].name, `n${MAX_BRANCHES}`); assert.equal(r.more, true);
}
assert.deepEqual(unsavedIn("/r", ["/r|a.js", "/r2|b.js", "/r|d/c.js", "/r|a.js"]), ["a.js", "d/c.js"]);
assert.match(unsavedMessage(["a", "b", "c", "d", "e", "f", "g"]), /^Unsaved edits in Edit: a, b, c, d, e and 2 more\. Save or discard/);
assert.equal(ago(1000, 1000 * 1000 + 3 * 86400 * 1000), "3 days ago"); assert.equal(ago(0), "");

const made = [];
try {
  const dir = mkdtempSync(`${tmpdir()}/br-`); made.push(dir);
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" }).trim();
  const run = (args) => git(args, { cwd: dir });
  g("init", "-q", "-b", "main"); writeFileSync(`${dir}/f.txt`, "1\n2\n3\n"); g("add", "."); g("commit", "-qm", "c1");
  // git agrees with the names Wingman lets through, and refuses what Wingman refuses.
  for (const n of ["ok/name", "a;b", "+x"]) assert.equal((await run(checkArgs(n))).code, 0, n);
  for (const n of ["a..b", "a b", "x.lock", "@{-1}"]) assert.notEqual((await run(checkArgs(n))).code, 0, n);
  // New branch from HEAD, then the list.
  assert.equal((await run(createArgs("a;b"))).code, 0);
  assert.equal(g("branch", "--show-current"), "a;b");
  assert.equal((await run(switchArgs("main"))).code, 0);
  const { list } = parseBranches((await run(LIST)).stdout, "main");
  assert.deepEqual(list.map((b) => b.name).sort(), ["a;b", "main"]); assert.equal(list[0].name, "main");
  // A branch that doesn't exist locally isn't guessed from a remote name.
  assert.notEqual((await run(switchArgs("nope"))).code, 0);
  // git's own refusal: a local change the switch would overwrite stays, and so does the branch.
  g("switch", "-q", "a;b"); writeFileSync(`${dir}/f.txt`, "1\nX\n3\n"); g("commit", "-qam", "on a;b"); g("switch", "-q", "main");
  writeFileSync(`${dir}/f.txt`, "1\n2\nlocal\n");
  const r = await run(switchArgs("a;b"));
  assert.notEqual(r.code, 0); assert.match(r.stderr, /would be overwritten/);
  assert.equal(g("branch", "--show-current"), "main"); assert.equal(readFileSync(`${dir}/f.txt`, "utf8"), "1\n2\nlocal\n");
  g("checkout", "-q", "--", "f.txt");

  // Review parks changes per branch: switch away and back, the same review is there.
  const st = await Store.open(dir), cap = new Capture(st);
  await st.reconcile();
  const t0 = await cap.snapshot();
  writeFileSync(`${dir}/f.txt`, "1\n2\nAGENT\n");
  assert.equal(await cap.adopt(t0, await cap.snapshot()), 1);
  await st.reconcile();
  const before = await st.index();
  assert.deepEqual(Object.keys(before), ["f.txt"]); assert.equal(before["f.txt"].branch, "main");
  g("stash", "-q"); // the agent's edit set aside so the switch can go (the user's own choice, never Wingman's)
  assert.equal((await run(switchArgs("a;b"))).code, 0);
  await st.reconcile();
  assert.deepEqual(Object.keys(await st.index()), [], "parked on main");
  assert.equal((await run(switchArgs("main"))).code, 0); g("stash", "pop", "-q");
  await st.reconcile();
  const back = await st.index();
  assert.deepEqual(back, before, "the same review entry is back");
  const loaded = await st.load("f.txt", back["f.txt"]);
  assert.deepEqual(loaded.hunks, [{ o: 2, oc: 1, n: 2, nc: 1 }]);
} finally { for (const d of made) rmSync(d, { recursive: true, force: true }); }
