// Format on save: formatter discovery, the temp file (name, place, removal on every path), failure
// fallbacks, line endings, and how a formatted text meets the review (baseline and pending changes).
import { extOf, tempName, newId, ancestors, withEol, FORMATTERS, formattersFor, applyFormat, FORMAT_MS } from "../mods/wingman/format.js";
import { formatText, newFormatCache } from "../mods/wingman/formatrun.js";
import { check } from "../mods/wingman/edit.js";
import { segmentHunks } from "../mods/wingman/model.js";
import { ACTIONS, BY_ID, allowedIn, holders, resolve } from "../mods/wingman/keymap.js";
import { fake, execCalls as rawCalls } from "./herdr-shim.mjs";
import { TOOL_SH, PROBE_SH } from "../mods/wingman/toolpath.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

// Tools run under toolpath.js's wrapper (sh -lc TOOL_SH wingman <PATH> program args...): seen here as the program they run.
const unwrap = (cmd, args) => (cmd === "sh" && args[0] === "-lc" && args[1] === TOOL_SH ? { cmd: args[4], args: args.slice(5) } : { cmd, args });
const calls0 = { get length() { return rawCalls.length; } };
const execCalls = { get length() { return calls0.length; }, filter: (f) => all().filter(f), slice: (a, b) => all().slice(a, b) };
const all = () => rawCalls.map((c) => ({ ...c, ...unwrap(c.cmd, c.args) }));
const fakeTool = (fn) => (cmd, args, opts) => { const u = unwrap(cmd, args); return fn(u.cmd, u.args, opts); };

// ---- names ------------------------------------------------------------------------------------------
assert.equal(extOf("src/App.TSX"), "tsx");
assert.equal(extOf("a/b.test.ts"), "ts");
assert.equal(extOf("Makefile"), "");
assert.equal(extOf("x.a b"), "");
assert.equal(extOf("x.toolongextension"), "");
assert.equal(tempName("ab12", "ts"), ".wingman-fmt-ab12.ts");
assert.throws(() => tempName("a/../b", "ts"));
assert.throws(() => tempName("ab", "t s"));
assert.throws(() => tempName("", "ts"));
const ids = new Set(Array.from({ length: 500 }, () => newId()));
assert.equal(ids.size, 500, "ids are unique");
for (const id of ids) assert.match(id, /^[a-z0-9]+$/);
assert.deepEqual(ancestors("a/b"), ["a/b", "a", ""]);
assert.deepEqual(ancestors("a"), ["a", ""]);
assert.deepEqual(ancestors(""), [""]);
assert.equal(withEol("a\nb\r\nc\rd\n", "\r\n"), "a\r\nb\r\nc\r\nd\r\n");
assert.equal(withEol("a\r\nb", "\n"), "a\nb");
assert.equal(FORMAT_MS, 10000);

// ---- the table ----------------------------------------------------------------------------------------
assert.deepEqual(formattersFor("a.ts").map((f) => f.id), ["prettier"]);
assert.deepEqual(formattersFor("a.cs").map((f) => f.id), ["csharpier"]);
assert.deepEqual(formattersFor("a.py"), []);
assert.deepEqual(formattersFor("Dockerfile"), []);
for (const e of "js ts tsx json css scss html vue md yaml".split(" ")) assert.ok(formattersFor(`x.${e}`).length, e);

// ---- discovery (fake file system) ---------------------------------------------------------------------
const fsEnv = (files, extra = {}) => ({
  root: "/r", dir: "pkg/sub", windowsNative: false,
  kind: async (p) => (p in files ? "file" : null),
  read: async (p) => files[p] ?? null,
  ...extra,
});
const prettier = FORMATTERS.find((f) => f.id === "prettier"), csharpier = FORMATTERS.find((f) => f.id === "csharpier");
let tool = await prettier.find(fsEnv({ "/r/node_modules/.bin/prettier": "" }));
assert.equal(tool.cmd, "/r/node_modules/.bin/prettier", "found at the repo root");
assert.deepEqual(tool.write("/r/a/.wingman-fmt-x.ts"), ["--write", "/r/a/.wingman-fmt-x.ts"], "argv array");
assert.deepEqual(tool.info("/r/a/b.ts"), ["--file-info", "/r/a/b.ts"]);
tool = await prettier.find(fsEnv({ "/r/node_modules/.bin/prettier": "", "/r/pkg/node_modules/.bin/prettier": "" }));
assert.equal(tool.cmd, "/r/pkg/node_modules/.bin/prettier", "the nearest one wins");
assert.equal(await prettier.find(fsEnv({ "/other/node_modules/.bin/prettier": "" })), null, "none at or above the folder, up to the root");
assert.equal(await prettier.find(fsEnv({}, { dir: "" })), null);
tool = await prettier.find(fsEnv({ "/r/node_modules/.bin/prettier": "", "/r/node_modules/prettier/bin/prettier.cjs": "" }, { windowsNative: true }));
assert.equal(tool.cmd, "node", "Windows git's repos run the package's script with node");
assert.deepEqual(tool.write("T"), ["/r/node_modules/prettier/bin/prettier.cjs", "--write", "T"]);
tool = await prettier.find(fsEnv({ "/r/node_modules/.bin/prettier": "", "/r/node_modules/prettier/bin-prettier.js": "" }, { windowsNative: true }));
assert.deepEqual(tool.write("T"), ["/r/node_modules/prettier/bin-prettier.js", "--write", "T"], "Prettier 2");
assert.equal(await prettier.find(fsEnv({ "/r/node_modules/.bin/prettier": "" }, { windowsNative: true })), null, "no script to run");
assert.equal(prettier.find && tool.ignored('{"ignored":true,"inferredParser":"babel"}'), true);
assert.equal(tool.ignored('{"ignored":false,"inferredParser":null}'), true, "no parser: not handled");
assert.equal(tool.ignored('{"ignored":false,"inferredParser":"babel"}'), false);
assert.equal(tool.ignored("not json"), false);

assert.equal(await csharpier.find(fsEnv({})), null, "no config, no manifest");
tool = await csharpier.find(fsEnv({ "/r/.csharpierrc.json": "{}" }));
assert.deepEqual([tool.cmd, ...tool.write("F")], ["dotnet", "csharpier", "format", "F"]);
tool = await csharpier.find(fsEnv({ "/r/pkg/.csharpierrc": "" }));
assert.ok(tool, "a config in a folder between the file and the root");
tool = await csharpier.find(fsEnv({ "/r/.config/dotnet-tools.json": JSON.stringify({ version: 1, isRoot: true, tools: { csharpier: { version: "0.30.1", commands: ["dotnet-csharpier"] } } }) }));
assert.deepEqual([tool.cmd, ...tool.write("F")], ["dotnet", "csharpier", "F"], "0.x has no format subcommand");
tool = await csharpier.find(fsEnv({ "/r/.config/dotnet-tools.json": JSON.stringify({ tools: { csharpier: { version: "1.0.2" } } }) }));
assert.deepEqual(tool.write("F"), ["csharpier", "format", "F"]);
assert.equal(await csharpier.find(fsEnv({ "/r/.config/dotnet-tools.json": JSON.stringify({ tools: { "dotnet-ef": { version: "8.0.0" } } }) })), null, "a manifest without csharpier");
assert.equal(await csharpier.find(fsEnv({ "/r/.config/dotnet-tools.json": "{ not json" })), null);

// ---- formatText with a fake prettier on disk -----------------------------------------------------------
const repo = mkdtempSync(`${tmpdir()}/wingman-fmt-`);
const FAKE = `#!/bin/sh
here=$(cd "$(dirname "$0")/../.." && pwd)
{ for a in "$@"; do printf 'ARG:%s\\n' "$a"; done; echo ---; } >> "$here/calls.log"
case "$1" in
  --file-info)
    # like Prettier: .prettierignore is read from the working folder
    if [ -f .prettierignore ] && grep -q '^ig/' .prettierignore && case "$2" in */ig/*) true;; *) false;; esac; then echo '{"ignored":true,"inferredParser":null}'
    else echo '{"ignored":false,"inferredParser":"typescript"}'; fi ;;
  --write)
    f="$2"
    if grep -q SYNTAXERR "$f"; then echo "[error] $f: SyntaxError: boom" >&2; exit 2; fi
    if grep -q COLORERR "$f"; then printf '\\033[31m[error]\\033[39m %s: SyntaxError: colored\\n' "$f" >&2; exit 2; fi
    if grep -q VANISH "$f"; then rm "$f"; exit 0; fi
    sed 's/\\t/  /g' "$f" > "$f.new" && mv "$f.new" "$f"
    [ -n "$(tail -c1 "$f")" ] && echo >> "$f"
    exit 0 ;;
esac
`;
try {
  mkdirSync(`${repo}/node_modules/.bin`, { recursive: true });
  writeFileSync(`${repo}/node_modules/.bin/prettier`, FAKE);
  chmodSync(`${repo}/node_modules/.bin/prettier`, 0o755);
  mkdirSync(`${repo}/src/dir with space`, { recursive: true });
  const leftovers = () => [...readdirSync(repo), ...readdirSync(`${repo}/src`), ...readdirSync(`${repo}/src/dir with space`)].filter((n) => n.startsWith(".wingman-fmt-") || n.endsWith(".new"));
  const calls = () => { try { return readFileSync(`${repo}/calls.log`, "utf8"); } catch { return ""; } };
  const cache = newFormatCache();

  // Success: the buffer is formatted and the temp file is gone; the real file is never touched.
  writeFileSync(`${repo}/src/a.ts`, "ORIGINAL");
  let r = await formatText({ root: repo, rel: "src/a.ts", text: "if (x) {\n\treturn 1\n}", cache });
  assert.equal(r.status, "ok");
  assert.equal(r.text, "if (x) {\n  return 1\n}\n");
  assert.deepEqual(leftovers(), []);
  assert.equal(readFileSync(`${repo}/src/a.ts`, "utf8"), "ORIGINAL", "the file on disk is untouched");
  const argLines = calls().split("\n").filter((l) => l.startsWith("ARG:"));
  const writeArg = argLines.find((l) => l.includes(".wingman-fmt-"));
  assert.match(writeArg, new RegExp(`^ARG:${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/src/\\.wingman-fmt-[a-z0-9]+\\.ts$`), "beside the target, same extension, inside the repo");
  assert.ok(argLines.includes("ARG:--write") && argLines.includes("ARG:--file-info"));
  const t = execCalls.filter((c) => c.cmd.endsWith(".bin/prettier")).map((c) => c.timeout);
  assert.ok(t.length === 2 && t.every((x) => x <= 10000 && x >= 1000), `timeouts ${t}`);
  // Each call's arguments are an array and the working folder is the project Prettier was found in (it reads .prettierignore there).
  assert.ok(execCalls.filter((c) => c.cmd.endsWith(".bin/prettier")).every((c) => Array.isArray(c.args) && c.cwd === repo));

  // The cache: a second format in the folder finds the tool and the file's info without asking again.
  const before = execCalls.length;
  r = await formatText({ root: repo, rel: "src/a.ts", text: "a\tb", cache });
  assert.equal(r.status, "ok");
  assert.ok(!execCalls.slice(before).some((c) => c.cmd === "sh" && String(c.args[1]).includes("echo d; elif")), "no folder checks again");
  assert.equal(execCalls.slice(before).filter((c) => c.cmd.endsWith(".bin/prettier")).length, 1, "only the write: the file info is cached too");
  assert.equal(cache.tools.size, 1);
  assert.equal(cache.info.size, 1);
  assert.deepEqual(leftovers(), []);

  // File names with spaces, quotes and shell characters go through as arguments; the temp name never uses them.
  writeFileSync(`${repo}/src/dir with space/it's;a $(x).ts`, "x");
  r = await formatText({ root: repo, rel: "src/dir with space/it's;a $(x).ts", text: "a\tb", cache });
  assert.equal(r.status, "ok");
  assert.ok(calls().includes("ARG:" + `${repo}/src/dir with space/it's;a $(x).ts`), "the real file's name passed whole");
  assert.ok(!calls().split("\n").some((l) => l.includes(".wingman-fmt-") && /[ ';$()]/.test(l.replace(`${repo}/src/dir with space/`, "").replace(/^ARG:/, ""))), "temp name made of letters and digits");
  assert.deepEqual(leftovers(), []);

  // Failure: the formatter's message, the temp file removed.
  r = await formatText({ root: repo, rel: "src/a.ts", text: "SYNTAXERR", cache });
  assert.equal(r.status, "failed");
  assert.match(r.reason, /^Prettier: .*SyntaxError: boom/);
  assert.ok(!r.reason.includes(".wingman-fmt-"), "the real file's name, not the temp one");
  assert.deepEqual(leftovers(), []);

  // Colour codes in the tool's message are dropped.
  r = await formatText({ root: repo, rel: "src/a.ts", text: "COLORERR", cache });
  assert.equal(r.status, "failed");
  assert.match(r.reason, /^Prettier: .*SyntaxError: colored$/);
  assert.ok(!/[\u001b]|\[3\d/.test(r.reason), r.reason);
  assert.deepEqual(leftovers(), []);

  // The tool removes the temp file itself: nothing to read, nothing left, no leftover note.
  r = await formatText({ root: repo, rel: "src/a.ts", text: "VANISH", cache });
  assert.equal(r.status, "failed");
  assert.match(r.reason, /could not be read/);
  assert.equal(r.leftover, undefined);
  assert.deepEqual(leftovers(), []);

  // Timeout (the call rejects): a short reason, the temp file removed.
  fake.exec = fakeTool((cmd, args) => (cmd.endsWith(".bin/prettier") && args[0] === "--write" ? Promise.reject(new Error("command timed out after 10000 ms")) : undefined));
  r = await formatText({ root: repo, rel: "src/a.ts", text: "a\tb", cache });
  fake.exec = null;
  assert.deepEqual([r.status, r.reason], ["failed", "Prettier timed out"]);
  assert.deepEqual(leftovers(), [], "removed after a timeout");

  // The tool cannot start at all (any other error): reported, temp removed.
  fake.exec = fakeTool((cmd, args) => (cmd.endsWith(".bin/prettier") && args[0] === "--write" ? Promise.reject(new Error("cannot start prettier")) : undefined));
  r = await formatText({ root: repo, rel: "src/a.ts", text: "a", cache });
  fake.exec = null;
  assert.equal(r.status, "failed");
  assert.match(r.reason, /cannot start/);
  assert.deepEqual(leftovers(), []);

  // The file is ignored (or has no parser): nothing runs and no temp file is ever made.
  mkdirSync(`${repo}/ig`, { recursive: true });
  writeFileSync(`${repo}/.prettierignore`, "ig/\n");
  const written = [];
  fake.exec = fakeTool((cmd, args) => { if (args[0] === "--write") written.push(args); return undefined; });
  r = await formatText({ root: repo, rel: "ig/x.ts", text: "a", cache });
  fake.exec = null;
  assert.equal(r.status, "none");
  assert.equal(written.length, 0);
  assert.deepEqual(leftovers(), []);

  // No Prettier in the repo for a folder: none, and nothing is written.
  const bare = mkdtempSync(`${tmpdir()}/wingman-fmt-bare-`);
  try {
    r = await formatText({ root: bare, rel: "a.ts", text: "a", cache: newFormatCache() });
    assert.equal(r.status, "none");
    assert.deepEqual(readdirSync(bare), []);
    // An extension nothing handles.
    assert.equal((await formatText({ root: repo, rel: "src/a.py", text: "a", cache })).status, "none");
    assert.equal((await formatText({ root: repo, rel: "Makefile", text: "a", cache })).status, "none");
    // C# with no CSharpier configured: none.
    assert.equal((await formatText({ root: repo, rel: "src/a.cs", text: "a", cache })).status, "none");
  } finally { rmSync(bare, { recursive: true, force: true }); }

  // A file in a folder of the repo whose Prettier is above it (a monorepo package).
  mkdirSync(`${repo}/pkg/deep/er`, { recursive: true });
  r = await formatText({ root: repo, rel: "pkg/deep/er/a.ts", text: "a\tb", cache: newFormatCache() });
  assert.equal(r.status, "ok");
  assert.deepEqual(readdirSync(`${repo}/pkg/deep/er`), []);
} finally { rmSync(repo, { recursive: true, force: true }); }

// ---- the CSharpier route: config present, tool run as dotnet with an argv array -------------------------------
{
  const cs = mkdtempSync(`${tmpdir()}/wingman-fmt-cs-`);
  try {
    writeFileSync(`${cs}/.csharpierrc.json`, "{}");
    const seen = [];
    fake.exec = fakeTool((cmd, args, opts) => {
      if (cmd !== "dotnet") return undefined;
      seen.push({ cmd, args, cwd: opts.cwd });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    });
    const r = await formatText({ root: cs, rel: "A.cs", text: "class A{}", cache: newFormatCache() });
    fake.exec = null;
    assert.equal(r.status, "ok");
    assert.equal(r.text, "class A{}", "the temp file as the tool left it");
    assert.deepEqual(seen[0].args.slice(0, 2), ["csharpier", "format"]);
    assert.match(seen[0].args[2], /\/\.wingman-fmt-[a-z0-9]+\.cs$/);
    assert.equal(seen[0].cwd, cs);
    assert.deepEqual(readdirSync(cs), [".csharpierrc.json"]);
  } finally { fake.exec = null; rmSync(cs, { recursive: true, force: true }); }
}

// ---- applying the result to a reviewed file -------------------------------------------------------------
const lines = (t) => t.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l)).filter((l) => l !== "");
const crlf = (a) => a.map((l) => l.replace(/\n$/, "\r\n"));
function state(Bt, Ct, eol = "\n") {
  const B = lines(Bt), C = lines(Ct), conv = eol === "\n" ? (x) => x : crlf;
  const b = conv(B), c = conv(C);
  return { B: b, C: c, Btext: b.join(""), Ctext: c.join(""), hunks: segmentHunks(b, c, 0, 0), created: false };
}
const ok = (s) => { check(s); return s; };

// A plain buffer (no agent change): the baseline takes every formatting edit, so nothing is pending.
{
  const s = state("function f() {\n\treturn 1\n}\nlet a = 1\n", "function f() {\n\treturn 1\n}\nlet a = 1\n");
  const r = applyFormat(s, "function f() {\n  return 1;\n}\nlet a = 1;\n");
  assert.equal(r.state.Ctext, "function f() {\n  return 1;\n}\nlet a = 1;\n");
  assert.equal(r.state.Btext, r.state.Ctext, "baseline took the same edits");
  assert.deepEqual(ok(r.state).hunks, []);
}

// The agent changed lines 4-5. Formatting lines outside them is the user's edit (baseline too);
// formatting inside them stays part of the agent's pending change.
{
  const B = "import a from 'a'\nfunction f() {\n\treturn 1\n}\nconst x = 1\nconst y = 2\nlet z = 3\nexport default f\n";
  const C = "import a from 'a'\nfunction f() {\n\treturn 1\n}\nconst x = 10\nconst y = 20\nlet z = 3\nexport default f\n";
  const s = state(B, C);
  assert.equal(s.hunks.length, 1);
  const out = "import a from 'a';\nfunction f() {\n  return 1;\n}\nconst x = 10;\nconst y = 20;\nlet z = 3;\nexport default f;\n";
  const r = applyFormat(s, out);
  assert.equal(r.state.Ctext, out);
  ok(r.state);
  assert.equal(r.state.hunks.length, 1, "still one pending change");
  const h = r.state.hunks[0];
  assert.deepEqual([h.o, h.oc, h.n, h.nc], [4, 2, 4, 2], "the agent's lines are the same two");
  // Baseline: formatted outside the agent's lines, as it was inside them.
  assert.equal(r.state.Btext, "import a from 'a';\nfunction f() {\n  return 1;\n}\nconst x = 1\nconst y = 2\nlet z = 3;\nexport default f;\n");
  // The formatted agent lines show as the agent's change, with the formatter's text.
  assert.deepEqual(r.state.C.slice(4, 6), ["const x = 10;\n", "const y = 20;\n"]);
}

// Lines added and removed by the formatter, in and around the agent's change; the result is exact.
{
  const B = "a\nb\nc\nd\ne\nf\n", C = "a\nb\nNEW\nc\nd\ne\nf\n";
  const s = state(B, C);
  const out = "a\n\nb\nNEW\nNEW2\nc\ne\nf\n\n";
  const r = applyFormat(s, out);
  assert.equal(r.state.Ctext, out);
  ok(r.state);
}
// An empty-baseline file (created by the agent) formats entirely as pending.
{
  const s = { B: [], C: ["a\n", "b\n"], Btext: "", Ctext: "a\nb\n", hunks: [{ o: 0, oc: 0, n: 0, nc: 2 }], created: true };
  const r = applyFormat(s, "a;\nb;\n");
  assert.equal(r.state.Ctext, "a;\nb;\n");
  assert.deepEqual(ok(r.state).hunks, [{ o: 0, oc: 0, n: 0, nc: 2 }]);
  assert.equal(r.state.Btext, "");
}
// An empty buffer takes the formatter's text.
{
  const s = { B: [], C: [], Btext: "", Ctext: "", hunks: [], created: false };
  assert.equal(applyFormat(s, "x\n").state.Ctext, "x\n");
  assert.equal(applyFormat(s, ""), null, "nothing to apply to an empty buffer");
}

// CRLF stays CRLF: the formatter's LF output is converted, an unchanged file stays as it is.
{
  const s = state("a\nb\n", "a\nb\n", "\r\n");
  assert.equal(s.Ctext, "a\r\nb\r\n");
  const r = applyFormat(s, "a;\nb;\nc;\n");
  assert.equal(r.state.Ctext, "a;\r\nb;\r\nc;\r\n");
  assert.equal(r.state.Btext, r.state.Ctext);
  ok(r.state);
  assert.equal(applyFormat(s, "a\nb\n").same, true, "LF output for a CRLF file that needs no change: nothing to do");
  assert.equal(applyFormat(s, "a\r\nb\r\n").same, true);
  // The agent's lines in a CRLF file.
  const t = state("a\nb\nc\n", "a\nX\nc\n", "\r\n");
  const u = applyFormat(t, "a;\nX;\nc;\n");
  assert.equal(u.state.Ctext, "a;\r\nX;\r\nc;\r\n");
  assert.equal(u.state.Btext, "a;\r\nb\r\nc;\r\n");
  assert.equal(u.state.hunks.length, 1);
  ok(u.state);
}

// A final newline is added when the formatter ends with one; a file without one that stays so is left.
{
  const s = state("a\nb", "a\nb");
  const r = applyFormat(s, "a\nb\n");
  assert.equal(r.state.Ctext, "a\nb\n");
  assert.equal(r.state.Btext, "a\nb\n");
  ok(r.state);
  assert.equal(applyFormat(state("a\nb\n", "a\nb\n"), "a\nb\n").same, true);
}

// The cursor stays on its line: lines added above push it down, a changed line keeps its column.
{
  const s = state("a\n\tb\n\tc\nd\n", "a\n\tb\n\tc\nd\n");
  let r = applyFormat(s, "a\n\n  b\n  c\nd\n", null, { line: 2, col: 1 });
  assert.deepEqual(r.cursor, { line: 3, col: 1 }, "a line was added above: the cursor's line moved with its text");
  r = applyFormat(s, "a\n  b\n  c\nd\n", null, { line: 3, col: 1 });
  assert.deepEqual(r.cursor, { line: 3, col: 1 });
  r = applyFormat(s, "a\nd\n", null, { line: 2, col: 1 });
  assert.ok(r.cursor.line >= 0 && r.cursor.line < r.state.C.length, "inside removed lines: clamped to a line that exists");
  r = applyFormat(s, "a\n  b\n  c\nd\n", null, null);
  assert.equal(r.cursor, null);
}

// Highlighting: the edited lines are tokenized by the callback.
{
  const s = { ...state("a\nb\n", "a\nb\n"), newTok: ["A", "B"], oldTok: ["A", "B"] };
  const r = applyFormat(s, "a\nbb\n", (ls) => ls.map((l) => `tok:${l}`));
  assert.deepEqual(r.state.newTok, ["A", "tok:bb"]);
  assert.deepEqual(r.state.oldTok, ["A", "tok:bb"]);
}

// A big reformat (many lines changed) is exact and does not take long.
{
  const n = 3000, B = Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";
  const s = state(B, B);
  const out = Array.from({ length: n }, (_, i) => `  line ${i};`).join("\n") + "\n";
  const t0 = performance.now();
  const r = applyFormat(s, out);
  const ms = performance.now() - t0;
  assert.equal(r.state.Ctext, out);
  assert.ok(ms < 5000, `took ${ms} ms`);
  console.log(`  big reformat ${n} lines: ${ms.toFixed(0)} ms`);
}

// ---- the key and the command ----------------------------------------------------------------------------------
assert.ok(BY_ID.has("formatFile"));
assert.deepEqual(BY_ID.get("formatFile").keys, ["alt-shift-f"]);
assert.equal(BY_ID.get("formatFile").scope, "pane");
assert.deepEqual(holders(resolve({}), "alt-shift-f", "formatFile"), [], "no other Wingman action has the key");
assert.deepEqual(resolve({ formatFile: ["ctrl-alt-f"] }).get("formatFile"), ["ctrl-alt-f"], "rebindable");
assert.equal(allowedIn("formatFile", "editor"), true);
assert.equal(allowedIn("formatFile", "tree"), false, "not while the tree has the keyboard: it changes the file");
assert.equal(allowedIn("formatFile", "find"), false);
assert.equal(allowedIn("formatFile", "quick"), false);
assert.equal(allowedIn("save", "tree"), true);
assert.equal(ACTIONS.filter((a) => a.keys.includes("alt-shift-f")).length, 1);

// ---- where the tool runs (git.js's decision) ---------------------------------------------------------------------
const WINHOME = "C:/Users/me/.config/herdr-app"; // appHome() on Windows
const probes = (cmd, args) => {
  if (cmd === "wsl.exe" && args.includes('printf %s "$WSL_DISTRO_NAME"')) return Promise.resolve({ code: 0, stdout: "Ubuntu", stderr: "" });
  if (cmd === "where") return Promise.resolve({ code: 0, stdout: "C:/Program Files/Git/cmd/git", stderr: "" });
  return undefined;
};
// Windows with a repo in WSL's own files: wsl.exe, the program and the arguments as WSL paths.
{
  const saved = process.env.WINGMAN_TEST_HOME;
  process.env.WINGMAN_TEST_HOME = WINHOME;
  const wslCalls = [];
  fake.read = () => Promise.resolve(null);
  fake.exec = (cmd, args, opts) => {
    const p = probes(cmd, args);
    if (p) return p;
    // The PATH probe (once per distro), then the tool under the wrapper with that PATH.
    if (cmd === "wsl.exe" && args.includes(PROBE_SH)) return Promise.resolve({ code: 0, stdout: "banner\n__WINGMAN_PATH__/home/me/.nvm/versions/node/v22.1.0/bin:/usr/bin__WINGMAN_END__\n", stderr: "" });
    if (cmd === "wsl.exe" && args.includes(TOOL_SH)) { wslCalls.push({ args, timeout: opts.timeout }); return Promise.resolve({ code: 0, stdout: '{"ignored":true,"inferredParser":null}', stderr: "" }); }
    if (cmd === "wsl.exe" && args.includes("wingman")) return Promise.resolve({ code: 0, stdout: /^\/home\/me\/r\/node_modules\/\.bin\/prettier$/.test(args.at(-1)) ? "f\n" : "", stderr: "" });
    return undefined;
  };
  try {
    const r = await formatText({ root: "//wsl.localhost/Ubuntu/home/me/r", rel: "src/a.ts", text: "a", cache: newFormatCache() });
    assert.equal(r.status, "none", "ignored: nothing written");
    assert.deepEqual(wslCalls[0].args, ["-d", "Ubuntu", "--cd", "/home/me/r", "-e", "sh", "-lc", TOOL_SH, "wingman", "/home/me/.nvm/versions/node/v22.1.0/bin:/usr/bin", "/home/me/r/node_modules/.bin/prettier", "--file-info", "/home/me/r/src/a.ts"]);
    assert.ok(wslCalls[0].timeout <= 10000);
  } finally { fake.exec = null; fake.read = null; process.env.WINGMAN_TEST_HOME = saved; }
}
// A Windows drive repo made by Windows git: no WSL; Prettier runs as `node <package script>` (the .bin shim is a .cmd).
{
  const saved = process.env.WINGMAN_TEST_HOME;
  process.env.WINGMAN_TEST_HOME = WINHOME;
  const calls = [];
  fake.read = (p) => Promise.resolve(p === "C:/r/.git/config" ? "[core]\n\tfilemode = false\n" : null);
  fake.exec = (cmd, args, opts) => {
    // Prettier's script runs with the node.exe `where` finds (toolrun.js toolWhere).
    if (cmd === "where" && args[0] === "node") return Promise.resolve({ code: 0, stdout: "C:\\Program Files\\nodejs\\node.exe\r\n", stderr: "" });
    const p = probes(cmd, args);
    if (p) return p;
    if (cmd === "powershell") return Promise.resolve({ code: 0, stdout: / 'C:.r.node_modules.(?:\.bin.prettier|prettier.bin.prettier\.cjs)'$/.test(args.at(-1)) ? "f\n" : "", stderr: "" });
    if (cmd === "C:\\Program Files\\nodejs\\node.exe") { calls.push({ args, cwd: opts.cwd }); return Promise.resolve({ code: 0, stdout: '{"ignored":true,"inferredParser":null}', stderr: "" }); }
    return undefined;
  };
  try {
    const r = await formatText({ root: "C:/r", rel: "src/a.ts", text: "a", cache: newFormatCache() });
    assert.equal(r.status, "none", JSON.stringify(r));
    assert.deepEqual(calls[0].args, ["C:/r/node_modules/prettier/bin/prettier.cjs", "--file-info", "C:/r/src/a.ts"]);
    assert.equal(calls[0].cwd, "C:/r", "the folder Prettier was found in (its .prettierignore)");
  } finally { fake.exec = null; fake.read = null; process.env.WINGMAN_TEST_HOME = saved; }
}
