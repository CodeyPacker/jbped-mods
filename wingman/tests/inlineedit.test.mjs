// inlineedit.js: instruction cleaning, prompt, answer cleaning, line replacement, the range
// re-check, argv template expansion and where the command runs.
import { cleanInstruction, MAX_INSTRUCTION, target, targetProblem, relocate, buildPrompt, cleanAnswer, replaceLines, words, expand, usesFile, failure, whereLabel, DEFAULT_COMMAND, MAX_LINES, TIMEOUT_MS } from "../mods/wingman/inlineedit.js";
import { plan, exeFrom, TOOL_SH } from "../mods/wingman/toolpath.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// ---- instruction: control characters dropped, newlines become spaces, capped ----
assert.equal(cleanInstruction("  use const\n\tplease\r\n "), "use const please");
assert.equal(cleanInstruction("a\x00b\x07c\x1bd\x7fe\x9bf"), "abcdef");
assert.equal(cleanInstruction("x".repeat(MAX_INSTRUCTION + 50)).length, MAX_INSTRUCTION);
assert.equal(cleanInstruction(null), "");

// ---- target: clamped, ordered, the old lines without terminators ----
const crlf = "one\r\ntwo\r\nthree\r\n";
assert.deepEqual(target(crlf, 2, 1), { a: 1, b: 2, old: ["two", "three"] });
assert.deepEqual(target("a\nb", 5, 9), { a: 1, b: 1, old: ["b"] });
assert.deepEqual(target("", 0, 0), { a: 0, b: 0, old: [""] });
assert.match(targetProblem({ a: 0, b: MAX_LINES }), /at most/);
assert.equal(targetProblem({ a: 0, b: MAX_LINES - 1 }), null);

// ---- replaceLines: CRLF kept, start and end of file, more and fewer lines ----
assert.equal(replaceLines(crlf, 1, 1, ["TWO", "TWO-B"]), "one\r\nTWO\r\nTWO-B\r\nthree\r\n");
assert.equal(replaceLines(crlf, 0, 0, ["ONE"]), "ONE\r\ntwo\r\nthree\r\n"); // file start
assert.equal(replaceLines(crlf, 2, 2, ["THREE", "FOUR"]), "one\r\ntwo\r\nTHREE\r\nFOUR\r\n"); // file end, terminated
assert.equal(replaceLines("a\nb\nc", 2, 2, ["C1", "C2"]), "a\nb\nC1\nC2"); // file end, no final newline: still none
assert.equal(replaceLines("a\nb\nc\nd\n", 1, 2, ["X"]), "a\nX\nd\n"); // fewer lines
assert.equal(replaceLines("a\nb\nc\n", 1, 1, []), "a\nc\n"); // removed
assert.equal(replaceLines("a\nb\nc", 2, 2, []), "a\nb"); // last line removed, no final newline
assert.equal(replaceLines("a\nb\nc", 1, 2, []), "a");
assert.equal(replaceLines("", 0, 0, ["new"]), "new"); // empty file
assert.equal(replaceLines("only\n", 0, 0, ["x", "y"]), "x\ny\n");

// ---- relocate: same place, moved by an edit above, changed, ambiguous ----
const t0 = target("a\nb\nc\nd\n", 1, 2);
assert.deepEqual(relocate("a\nb\nc\nd\n", t0), t0);
assert.deepEqual(relocate("new\na\nb\nc\nd\n", t0), { ...t0, a: 2, b: 3 }); // a line added above
assert.deepEqual(relocate("a\nb\nc\nd\nedited below\n", t0), t0); // edited below: same place
assert.equal(relocate("a\nB\nc\nd\n", t0), null); // the target itself changed
assert.equal(relocate("x\ny\nb\nc\nb\nc\n", t0), null); // moved, and twice: can't tell
assert.equal(relocate("a\r\nb\r\nc\r\n", target("a\nb\nc\n", 1, 1)) !== null, true); // line endings don't count

// ---- prompt: path, language, delimited context and selection, instruction ----
const src = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
const p = buildPrompt({ path: "src/app.ts", language: "typescript", text: src, a: 9, b: 10, instruction: "rename" });
assert.match(p, /File: src\/app\.ts/);
assert.match(p, /Language: typescript/);
assert.match(p, /Selected: lines 10-11 of 20/);
assert.match(p, /~~~~~~~~ context before \(do not repeat\) ~~~~~~~~\nline5\nline6\nline7\nline8\nline9\n~~~~~~~~ end of context before/);
assert.match(p, /~~~~~~~~ selected lines ~~~~~~~~\nline10\nline11\n~~~~~~~~ end of selected lines ~~~~~~~~/);
assert.match(p, /~~~~~~~~ context after \(do not repeat\) ~~~~~~~~\nline12\nline13\nline14\nline15\nline16\n~~~~~~~~ end/);
assert.match(p, /Instruction: rename/);
assert.match(p, /No code fences/);
const top = buildPrompt({ path: "a.js", language: "", text: "x\ny\n", a: 0, b: 0, instruction: "i" });
assert.match(top, /\(the selection starts the file\)/);
assert.match(top, /Language: plain text/);
assert.match(buildPrompt({ path: "a.js", language: "js", text: "x\ny", a: 1, b: 1, instruction: "i" }), /\(the selection ends the file\)/);
assert.doesNotMatch(buildPrompt({ path: "a.js", language: "js", text: crlf, a: 0, b: 2, instruction: "i" }), /\r/); // CRLF file: no stray CRs

// ---- answer cleaning: one fence stripped, blank ends, CRLF ----
assert.deepEqual(cleanAnswer("```js\nconst x = 1;\nconst y = 2;\n```\n"), ["const x = 1;", "const y = 2;"]);
assert.deepEqual(cleanAnswer("```\n  indented\n```"), ["  indented"]);
assert.deepEqual(cleanAnswer("~~~python\nx = 1\n~~~"), ["x = 1"]);
assert.deepEqual(cleanAnswer("\n\n  keep indent\n\n"), ["  keep indent"]);
assert.deepEqual(cleanAnswer("a\r\nb\r\n"), ["a", "b"]);
assert.deepEqual(cleanAnswer("```js\n```js\ninner\n```\n```"), ["```js", "inner", "```"]); // only one fence goes
assert.deepEqual(cleanAnswer("x\n```\ny"), ["x", "```", "y"]); // a fence inside isn't stripped
assert.deepEqual(cleanAnswer("a  \nb\t"), ["a", "b"]); // trailing spaces dropped
assert.equal(cleanAnswer(""), null);
assert.equal(cleanAnswer("\n  \n"), null);
assert.equal(cleanAnswer("```\n```"), null);

// ---- template expansion: hostile text reaches argv unchanged, as one argument ----
assert.deepEqual(words('a "b c" "" d'), ["a", "b c", "", "d"]);
const hostile = `it's "quoted" $(rm -rf ~) \`id\` ; & | > {promptFile} {prompt}\nsecond line`;
const argv = expand(DEFAULT_COMMAND, { prompt: hostile });
assert.equal(argv[0], "claude");
assert.equal(argv.at(-1), hostile); // one argument, byte for byte, placeholders inside it left alone
assert.equal(argv.filter((a) => a === hostile).length, 1);
assert.deepEqual(argv.slice(1, -1), ["-p", "--output-format", "text", "--tools", "", "--permission-mode", "dontAsk", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--settings", '{"disableAllHooks":true}']);
assert.deepEqual(expand("my-llm --in {promptFile}", { prompt: "P", promptFile: "/tmp/x.txt" }), ["my-llm", "--in", "/tmp/x.txt"]);
assert.deepEqual(expand("my-llm --q={prompt}", { prompt: "{promptFile}" }), ["my-llm", "--q={promptFile}"]);
assert.deepEqual(expand("my-llm -x", { prompt: "P" }), ["my-llm", "-x", "P"]); // no placeholder: last argument
assert.throws(() => expand("my-llm {promptFile}", { prompt: "P" }), /promptFile/);
assert.throws(() => expand("   ", { prompt: "P" }), /Set the inline edit command/);
assert.equal(usesFile("x {promptFile}"), true);
assert.equal(usesFile(DEFAULT_COMMAND), false);

// ---- the real thing: the wrapper hands hostile argv to the program unchanged and unexecuted ----
const dir = mkdtempSync(join(tmpdir(), "wingman-ie-"));
try {
  const canary = join(dir, "pwned");
  const evil = `$(touch ${canary}) \`touch ${canary}\` "; touch ${canary}; echo '\nnext`;
  const pl = plan(["printf", "%s\\0", evil, "", "two words"], {});
  assert.equal(pl.cmd, "sh");
  const out = execFileSync(pl.cmd, pl.args, { encoding: "utf8" });
  assert.deepEqual(out.split("\0").slice(0, -1), [evil, "", "two words"]);
  assert.equal(existsSync(canary), false);
} finally { rmSync(dir, { recursive: true, force: true }); }

// ---- where the command runs ----
const av = ["claude", "-p", "P"];
assert.deepEqual(plan(av, { cwd: "/home/me/repo", timeout: TIMEOUT_MS }), { how: "sh", cmd: "sh", args: ["-lc", TOOL_SH, "wingman", "", ...av], opts: { cwd: "/home/me/repo", timeout: TIMEOUT_MS } });
assert.deepEqual(plan(av, { on: "box", cwd: "/srv/repo", timeout: TIMEOUT_MS, path: "/u/bin:/bin" }), { how: "remote", cmd: "sh", args: ["-lc", TOOL_SH, "wingman", "/u/bin:/bin", ...av], opts: { cwd: "/srv/repo", on: "box", timeout: TIMEOUT_MS } });
// Windows: a WSL-owned repo goes through wsl.exe even with a native claude.exe there.
assert.deepEqual(plan(av, { windows: true, owner: "wsl", nativeExe: "C:\\bin\\claude.exe", cwd: "//wsl.localhost/Ubuntu/home/me/r", wslCwd: "/home/me/r", distro: "Ubuntu", timeout: TIMEOUT_MS, path: "/n/bin" }),
  { how: "wsl", cmd: "wsl.exe", args: ["-d", "Ubuntu", "--cd", "/home/me/r", "-e", "sh", "-lc", TOOL_SH, "wingman", "/n/bin", ...av], opts: { timeout: TIMEOUT_MS } });
// A native repo with a native claude.exe: run it directly.
assert.deepEqual(plan(av, { windows: true, owner: "native", nativeExe: "C:\\bin\\claude.exe", cwd: "C:/dev/r", wslCwd: "/mnt/c/dev/r", timeout: TIMEOUT_MS }),
  { how: "native", cmd: "C:\\bin\\claude.exe", args: ["-p", "P"], opts: { cwd: "C:/dev/r", timeout: TIMEOUT_MS } });
// A native repo without one: WSL's.
assert.deepEqual(plan(av, { windows: true, owner: "native", nativeExe: null, cwd: "C:/dev/r", wslCwd: "/mnt/c/dev/r" }).args.slice(0, 4), ["--cd", "/mnt/c/dev/r", "-e", "sh"]);
assert.equal(exeFrom("C:\\a\\claude.cmd\r\nC:\\b\\claude.exe\r\n"), "C:\\b\\claude.exe");
assert.equal(exeFrom("C:\\a\\claude.cmd\r\n"), null);
assert.equal(exeFrom(""), null);

// ---- failures: one line each ----
assert.equal(failure({ code: 0, stdout: "x", stderr: "" }), null);
assert.match(failure({ code: 127, stdout: "", stderr: "sh: exec: claude: not found" }), /claude not found/);
assert.match(failure(new Error("cannot start claude: program not found")), /claude not found/);
assert.match(failure({ code: 1, stdout: "", stderr: "Warning: sign-in ends soon\nError: overloaded\n" }), /^claude exited with 1: Error: overloaded$/);
assert.match(failure({ code: 1, stdout: "", stderr: "" }, { elapsed: TIMEOUT_MS }), /timed out after 120 s/);
assert.match(failure(new Error("timed out")), /timed out/);
// Not signed in where it ran: Windows' claude.exe and WSL's claude sign in separately (seen: claude.exe
// signed out while WSL's claude was signed in), so the message says which one.
{
  const r = { code: 1, stdout: "", stderr: "Failed to authenticate: OAuth session expired and could not be refreshed\n" };
  assert.equal(failure(r, { where: whereLabel({ how: "native" }) }),
    "claude (Windows) isn't signed in: run `claude auth login` in Windows, then try again (Failed to authenticate: OAuth session expired and could not be refreshed)");
  assert.match(failure(r, { where: whereLabel({ how: "wsl" }) }), /^claude \(WSL\) isn't signed in: run `claude auth login` in WSL/);
  assert.match(failure(r, { where: whereLabel({ how: "remote", on: "vps" }) }), /^claude \(vps\) isn't signed in/);
  assert.match(failure(r), /^claude isn't signed in: run `claude auth login`, then/);
  assert.match(failure({ code: 1, stdout: "Invalid API key · Please run /login", stderr: "" }), /isn't signed in/);
  assert.equal(whereLabel({ how: "sh" }), null);
  assert.equal(whereLabel(null), null);
}

console.log("inlineedit ok");
