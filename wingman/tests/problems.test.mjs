// problems.js: the checkers' parsers on real output (problems/: tsc 5.9 and eslint 9 from Linux
// Node and Windows Node, dotnet 10 on Windows; only the folder above each project was renamed),
// paths outside the root, caps, hostile text, detection, the run queue, line shifts after edits,
// stepping, the failure line and the prompt for the agent.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { PROBE_SH, parseProbe, dot, parseTsc, parseEslintJson, parseMsbuild, parseGeneric, parse, relOf, normRel, cleanMessage, capOutput, capDiags, detect, probes, ancestors, relFrom, customChecker,
  RunQueue, failureLine, shiftDiags, byLine, worst, problemRows, stepProblem, countText, stripText, buildProblemsPrompt,
  MAX_DIAGS, MAX_MESSAGE, MAX_OUTPUT, BINS, FILE_MS, PROJECT_MS } from "../mods/wingman/problems.js";
import { MAX_PROMPT } from "../mods/wingman/commentprompt.js";

const sample = (name) => readFileSync(new URL(`./problems/${name}`, import.meta.url), "utf8");

// ---- tsc, Linux Node (paths relative to the folder it ran in) ----
{
  const r = parseTsc(sample("tsc-linux.txt"), { root: "/work/tsproj", roots: ["/work/tsproj"], cwd: "", source: "tsc" });
  assert.equal(r.diags.length, 3);
  assert.deepEqual(r.diags[0], { root: "/work/tsproj", rel: "src/a.ts", line: 5, col: 28, severity: "error", code: "TS2345", message: "Argument of type 'string' is not assignable to parameter of type 'number'.", source: "tsc" });
  assert.deepEqual(r.diags.map((d) => `${d.rel}:${d.line}:${d.col}`), ["src/a.ts:5:28", "src/a.ts:8:14", "src/b.ts:2:28"]);
  // Ran in a sub-project: its paths are taken from there.
  const sub = parseTsc(sample("tsc-linux.txt"), { root: "/work", roots: ["/work"], cwd: "tsproj" });
  assert.equal(sub.diags[2].rel, "tsproj/src/b.ts");
}
// ---- tsc, Windows Node: CRLF, nothing of \r left in a message ----
{
  const text = sample("tsc-windows.txt");
  assert.ok(text.includes("\r\n"));
  const r = parseTsc(text, { root: "C:/work/tsproj-win", roots: ["C:/work/tsproj-win"], cwd: "" });
  assert.equal(r.diags.length, 3);
  assert.ok(r.diags.every((d) => !/\r/.test(d.message) && d.message.endsWith(".")));
  // A message continued on indented lines; a global error (no place) is a note.
  const more = parseTsc("src/x.ts(1,2): error TS2322: Type 'A' is not\r\n  assignable to 'B'.\r\nerror TS5083: Cannot read file '/w/tsconfig.json'.\r\n", { root: "/w", roots: ["/w"] });
  assert.equal(more.diags[0].message, "Type 'A' is not assignable to 'B'.");
  assert.deepEqual(more.notes, ["TS5083: Cannot read file '/w/tsconfig.json'."]);
}
// ---- eslint JSON, Linux (absolute POSIX paths) ----
{
  const r = parseEslintJson(sample("eslint-linux.json"), { root: "/work/tsproj", roots: ["/work/tsproj"], cwd: "" });
  assert.equal(r.diags.length, 3);
  assert.deepEqual(r.diags.map((d) => [d.rel, d.line, d.col, d.endLine, d.endCol, d.severity, d.code]), [
    ["src/a.ts", 5, 5, 5, 18, "error", "prefer-const"],
    ["src/a.ts", 6, 7, 6, 13, "warning", "@typescript-eslint/no-unused-vars"],
    ["src/a.ts", 7, 1, 7, 10, "error", "no-debugger"],
  ]);
  assert.equal(r.diags[0].source, "eslint");
}
// ---- eslint JSON, Windows (C:\ paths): matched to the root without case, also from WSL's /mnt view ----
{
  const text = sample("eslint-windows.json");
  for (const roots of [["C:/work/tsproj-win"], ["c:\\WORK\\tsproj-win"], ["/elsewhere", "C:/work/tsproj-win/"]]) {
    const r = parseEslintJson(text, { root: "C:/work/tsproj-win", roots });
    assert.deepEqual(r.diags.map((d) => d.rel), ["src/a.ts", "src/a.ts", "src/a.ts"], JSON.stringify(roots));
  }
  // The same report from WSL's eslint names /mnt/c/...: the root's WSL form matches it.
  const wsl = text.replace(/C:\\\\work/g, "/mnt/c/work").replace(/\\\\/g, "/");
  assert.equal(parseEslintJson(wsl, { root: "C:/work/tsproj-win", roots: ["C:/work/tsproj-win", "/mnt/c/work/tsproj-win"] }).diags.length, 3);
  // Outside the root: dropped (and kept as notes).
  const out = parseEslintJson(text, { root: "C:/work/other", roots: ["C:/work/other"] });
  assert.equal(out.diags.length, 0);
  assert.equal(out.notes.length, 3);
}
// ---- dotnet build (MSBuild), Windows: CRLF, each line twice (live and summary) kept once ----
{
  const r = parseMsbuild(sample("dotnet-windows.txt"), { root: "C:/work/DnApp", roots: ["C:/work/DnApp"], cwd: "" });
  assert.deepEqual(r.diags.map((d) => [d.rel, d.line, d.col, d.severity, d.code, d.message]), [
    ["Program.cs", 1, 9, "error", "CS0029", "Cannot implicitly convert type 'string' to 'int'"],
    ["Program.cs", 3, 5, "warning", "CS0168", "The variable 'unused' is declared but never used"],
  ]);
  const syn = parseMsbuild(sample("dotnet-syntax-windows.txt"), { root: "C:/work/DnApp", roots: ["C:/work/DnApp"] });
  assert.deepEqual(syn.diags.map((d) => [d.line, d.col, d.code, d.message]), [[2, 27, "CS1002", "; expected"]]);
  // From a solution one folder up: the project's files are under the root.
  assert.equal(parseMsbuild(sample("dotnet-windows.txt"), { root: "C:/work", roots: ["C:/work"] }).diags[0].rel, "DnApp/Program.cs");
  // Linux paths, a range, and errors with no place in the repo (an SDK targets file, MSBUILD itself) as notes.
  const lin = parseMsbuild([
    "/home/u/app/Api/Foo.cs(12,5,12,9): error CS0103: The name 'x' does not exist in the current context [/home/u/app/Api/Api.csproj]",
    "/usr/share/dotnet/sdk/9.0.100/Sdks/Microsoft.NET.Sdk/targets/Microsoft.PackageDependencyResolution.targets(266,5): error NETSDK1004: Assets file '/home/u/app/Api/obj/project.assets.json' not found. Run a NuGet package restore to generate this file. [/home/u/app/Api/Api.csproj]",
    "MSBUILD : error MSB1009: Project file does not exist.",
  ].join("\n"), { root: "/home/u/app", roots: ["/home/u/app"] });
  assert.deepEqual(lin.diags.map((d) => [d.rel, d.line, d.col, d.endLine, d.endCol]), [["Api/Foo.cs", 12, 5, 12, 9]]);
  assert.equal(lin.notes.length, 2);
  assert.match(lin.notes[0], /^NETSDK1004: Assets file/);
  assert.match(lin.notes[1], /^MSB1009/);
}
// ---- generic path:line:col: message ----
{
  const ctx = { root: "C:/r", roots: ["C:/r"], cwd: "" };
  const r = parseGeneric([
    "src/x.py:3:5: error: bad thing",
    "C:\\r\\lib\\a.py:2: warning: careful",
    "src/y.py:10:1: E501 line too long",
    "/etc/passwd:1:1: outside",
    "../x.py:1:1: climbs out",
    "src/../../x.py:1:1: climbs out too",
    "src/./z.py:4:2: note: dotted",
    "not a diagnostic line",
  ].join("\r\n"), ctx);
  assert.deepEqual(r.diags.map((d) => [d.rel, d.line, d.col, d.severity, d.message]), [
    ["src/x.py", 3, 5, "error", "bad thing"], ["lib/a.py", 2, 1, "warning", "careful"], ["src/y.py", 10, 1, "error", "E501 line too long"], ["src/z.py", 4, 2, "warning", "dotted"],
  ]);
  assert.equal(parse("nope", "a.c:1:1: x", { root: "/r", roots: ["/r"] }).diags.length, 1); // an unknown parser reads as generic
}
// ---- paths: inside the root only ----
assert.equal(normRel("a/./b/../c"), "a/c");
assert.equal(normRel("../a"), null);
assert.equal(relOf("src/../a.ts", { roots: ["/r"] }), "a.ts");
assert.equal(relOf("../../etc/passwd", { roots: ["/r"], cwd: "sub" }), null);
assert.equal(relOf("../shared/x.ts", { roots: ["/r"], cwd: "app" }), "shared/x.ts"); // a sibling project, still inside the root
assert.equal(relOf("/r2/a.ts", { roots: ["/r"] }), null); // a root that is a prefix of another folder's name
assert.equal(relOf("/r", { roots: ["/r"] }), null); // the root itself isn't a file
assert.equal(relOf("/R/a.ts", { roots: ["/r"] }), null); // POSIX paths keep case
assert.equal(relOf("C:\\R\\A.ts", { roots: ["c:/r"] }), "A.ts");
assert.equal(relOf("//wsl.localhost/Ubuntu/home/u/r/a.ts", { roots: ["//wsl.localhost/Ubuntu/home/u/r"] }), "a.ts");
assert.equal(relOf("file:///C:/r/a.ts", { roots: ["C:/r"] }), "a.ts");
assert.equal(relOf("a\x00b.ts", { roots: ["/r"] }), null);
assert.equal(relOf("", { roots: ["/r"] }), null);
assert.equal(parseTsc("../../../etc/shadow(1,1): error TS1: x\n", { root: "/r", roots: ["/r"], cwd: "a" }).diags.length, 0);

// ---- hostile text: control characters, ANSI, bidi overrides, newlines, length ----
{
  const evil = "bad \x1b[31mred\x1b[0m \u202Egnp.exe\u202C\u2066x\u2069 \u2028line\r\nnext\x07 \x9b";
  const m = cleanMessage(evil);
  assert.ok(!/[\x00-\x1F\x7F-\x9F\u2028\u202A-\u202E\u2066-\u2069]/.test(m), JSON.stringify(m));
  assert.equal(m, "bad [31mred[0m gnp.exex line next");
  assert.equal(cleanMessage("x".repeat(1000)).length, MAX_MESSAGE);
  assert.ok(cleanMessage("x".repeat(1000)).endsWith("…"));
  const json = JSON.stringify([{ filePath: "/r/a.ts", messages: [{ line: 1, column: 1, severity: 2, message: evil, ruleId: "x\ny" }, { line: "nope", column: -4, severity: 1, message: { toString: null } }, null, 7] }, null, "str", { filePath: "/r/b.ts" }]);
  const r = parseEslintJson(json, { root: "/r", roots: ["/r"] });
  assert.equal(r.diags.length, 2);
  assert.equal(r.diags[0].code, "x y");
  assert.deepEqual([r.diags[1].line, r.diags[1].col, r.diags[1].severity], [1, 1, "warning"]); // bad numbers: line 1, column 1
  assert.ok(typeof r.diags[1].message === "string");
  assert.equal(parseEslintJson("{\"__proto__\": 1}", {}).unparsed, true);
  assert.equal(parseEslintJson("Oops! Something went wrong!", {}).unparsed, true);
  assert.equal(parseEslintJson("(node:1) Warning: x\n[]", {}).diags.length, 0); // text before the JSON
  // Output past 2 MB isn't read.
  assert.equal(capOutput("a".repeat(MAX_OUTPUT + 10)).length, MAX_OUTPUT);
  const huge = "src/a.ts(1,1): error TS1: x\n".repeat(Math.ceil((MAX_OUTPUT + 1000) / 28));
  assert.ok(parseTsc(huge, { roots: ["/r"] }).diags.length <= Math.ceil(MAX_OUTPUT / 28));
}

// ---- caps: 1,000 kept per repo, errors first, the rest counted ----
{
  const many = Array.from({ length: 1500 }, (_, i) => ({ root: "/r", rel: `f${i % 7}.ts`, line: i + 1, col: 1, severity: i % 3 ? "warning" : "error", message: "m", source: "tsc" }));
  const { diags, more } = capDiags(many);
  assert.equal(diags.length, MAX_DIAGS);
  assert.equal(more, 500);
  assert.equal(diags.filter((d) => d.severity === "error").length, 500); // every error kept
  assert.equal(countText(diags, more), "500 errors, 500 warnings (… 500 more not shown)");
  assert.equal(countText([]), "No problems");
}

// ---- detection ----
{
  const has = (...paths) => { const s = new Set(paths); return (p) => s.has(p); };
  assert.deepEqual(ancestors("a/b/c.ts"), ["a/b", "a", ""]);
  assert.deepEqual(ancestors("c.ts"), [""]);
  assert.deepEqual(ancestors(null), [""]);
  assert.ok(probes("a/b.ts").includes("a/tsconfig.json") && probes("a/b.ts").includes(BINS.eslint) && probes("a/b.ts").includes("a/eslint.config.mjs"));
  assert.equal(relFrom("web", "node_modules/eslint/bin/eslint.js"), "../node_modules/eslint/bin/eslint.js");
  assert.equal(relFrom("web", "web/src/a.ts"), "src/a.ts");
  assert.equal(relFrom("", "a"), "a");

  // Nothing installed, or a config without eslint: nothing runs.
  assert.deepEqual(detect("src/a.ts", { exists: has("eslint.config.mjs", "tsconfig.json") }), []);
  assert.deepEqual(detect("src/a.ts", { exists: has(BINS.eslint, BINS.tsc) }), []);
  // eslint and tsc at the root.
  const both = detect("src/a.ts", { exists: has("eslint.config.mjs", "tsconfig.json", BINS.eslint, BINS.tsc) });
  assert.deepEqual(both.map((c) => [c.id, c.scope, c.cwd, c.unit, c.timeout]), [["eslint", "file", "", "eslint|src/a.ts", FILE_MS], ["tsc", "project", "", "tsc|", PROJECT_MS]]);
  assert.deepEqual(both[0].argv, ["node", BINS.eslint, "--format", "json", "./src/a.ts"]);
  assert.deepEqual(both[1].argv, ["node", BINS.tsc, "--noEmit", "--pretty", "false", "-p", "tsconfig.json"]);
  // A monorepo: config and tsconfig in web/, node_modules at the root.
  const mono = detect("web/src/a.vue", { exists: has("web/eslint.config.js", "web/tsconfig.json", BINS.eslint, BINS.tsc, BINS.vueTsc) });
  assert.deepEqual(mono.map((c) => [c.name, c.cwd]), [["eslint", "web"], ["vue-tsc", "web"]]);
  assert.equal(mono[0].argv[1], "../node_modules/eslint/bin/eslint.js");
  assert.equal(mono[0].argv[4], "./src/a.vue");
  assert.equal(mono[1].argv[1], "../node_modules/vue-tsc/bin/vue-tsc.js");
  // eslint below its config isn't the config's: a bin only in a sub-folder doesn't count for a root config.
  assert.deepEqual(detect("web/a.ts", { exists: has("eslint.config.js", "web/" + BINS.eslint) }), []);
  // Not a script file: no eslint, no tsc.
  assert.deepEqual(detect("README.md", { exists: has("eslint.config.mjs", "tsconfig.json", BINS.eslint, BINS.tsc) }), []);
  // A file name that looks like an option stays a path.
  assert.equal(detect("-rf.ts", { exists: has("eslint.config.mjs", BINS.eslint) })[0].argv[4], "./-rf.ts");
  // dotnet: nearest folder with a project; a solution there wins; only for C# files and the repo check.
  const ls = (m) => (d) => m[d] ?? [];
  const dn = detect("Api/Controllers/X.cs", { listing: ls({ "Api": ["Api.csproj", "appsettings.json"], "": ["App.sln", "B.slnx"] }) });
  assert.deepEqual(dn.map((c) => [c.id, c.cwd, c.unit]), [["dotnet", "Api", "dotnet|Api/Api.csproj"]]);
  assert.deepEqual(dn[0].argv, ["dotnet", "build", "./Api.csproj", "--no-restore", "-nologo", "-v:q", "-tl:off", "-clp:NoSummary"]);
  assert.equal(detect(null, { listing: ls({ "": ["Z.csproj", "App.sln"] }) })[0].argv[2], "./App.sln");
  assert.deepEqual(detect("src/a.ts", { listing: ls({ "": ["App.sln"] }) }), []);
  assert.deepEqual(detect(null, { listing: ls({ "": ["bad\nname.csproj"] }) }), []);
  // The repo as a whole: tsc at the root, never eslint.
  assert.deepEqual(detect(null, { exists: has("eslint.config.mjs", "tsconfig.json", BINS.eslint, BINS.tsc) }).map((c) => c.id), ["tsc"]);
  // The repo's own command: {file} makes it per file, filled in one pass; the parser must be a known one.
  const c1 = customChecker({ command: 'ruff check --output-format concise "{file}"', parser: "generic" }, "src/x {file}.py");
  assert.deepEqual([c1.scope, c1.unit, c1.argv], ["file", "custom|src/x {file}.py", ["ruff", "check", "--output-format", "concise", "./src/x {file}.py"]]);
  assert.equal(customChecker({ command: "ruff {file}" }, null), null);
  const c2 = customChecker({ command: "npx vue-tsc --noEmit", parser: "eval" }, "a.ts");
  assert.deepEqual([c2.scope, c2.parser, c2.timeout, c2.name], ["project", "generic", PROJECT_MS, "npx"]);
  assert.equal(customChecker({ command: "   " }, "a.ts"), null);
  assert.equal(customChecker(null, "a.ts"), null);
  assert.deepEqual(detect("a.ts", { custom: { command: "make check", parser: "tsc" } }).map((c) => [c.id, c.parser]), [["custom", "tsc"]]);
}

// ---- the run queue: never two runs of one key, one rerun with the newest request ----
{
  const q = new RunQueue();
  assert.equal(q.claim("k", { v: 1 }), true);
  assert.equal(q.claim("k", { v: 2 }), false);
  assert.equal(q.claim("k", { v: 3 }), false);
  assert.deepEqual(q.finish("k"), { v: 3 }); // exactly one rerun, the newest
  assert.equal(q.running("k"), true);
  assert.equal(q.finish("k"), null);
  assert.equal(q.running("k"), false);
  assert.equal(q.claim("other"), true);
  assert.equal(q.finish("other"), null);
  // Driven like problemsview.request, with overlapping requests: at most one run at a time, and the
  // last request is always followed by a run that started after it.
  const runs = [];
  let live = 0, peak = 0;
  const request = (spec) => {
    if (!q.claim("x", spec)) return;
    (async () => {
      let job = spec;
      while (job) {
        live++; peak = Math.max(peak, live); runs.push(job.n);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        const next = q.finish("x");
        job = next === true ? job : next;
      }
    })();
  };
  for (let n = 1; n <= 10; n++) { request({ n }); await new Promise((r) => setTimeout(r, n % 3 ? 1 : 7)); }
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(peak, 1);
  assert.equal(runs.at(-1), 10);
  assert.ok(runs.length < 10, `queued requests collapsed: ${runs}`);
  assert.equal(q.size(), 0);
}

// ---- the failure line: one line, never for a run that reported something ----
{
  const t = new Error("Command timed out after 180000 ms");
  assert.equal(failureLine("tsc", t, { timeout: PROJECT_MS }), "tsc: timed out after 180 s");
  assert.equal(failureLine("eslint", { code: 1, stdout: "", stderr: "" }, { elapsed: 20000, timeout: FILE_MS }), "eslint: timed out after 20 s");
  assert.match(failureLine("tsc", new Error("cannot start node: program not found"), {}), /^tsc: couldn't start/);
  assert.match(failureLine("tsc", { code: 127, stdout: "", stderr: "sh: 1: exec: node: not found\n" }, {}), /^tsc: not found where the repo's tools run \(sh: 1: exec: node: not found\)$/);
  assert.equal(failureLine("eslint", { code: 2, stdout: "", stderr: "\nOops! Something went wrong! :(\n\nESLint: 9.39.5\n\nError: Cannot find module 'typescript-eslint'\n" }, {}), "eslint: exited with 2: Error: Cannot find module 'typescript-eslint'");
  assert.equal(failureLine("tsc", { code: 2, stdout: "x", stderr: "" }, { parsed: 3 }), null); // errors found: exit 2 is normal
  assert.equal(failureLine("tsc", { code: 0, stdout: "", stderr: "" }, {}), null); // clean
  assert.equal(failureLine("dotnet", { code: 1, stdout: "", stderr: "" }, { notes: ["NETSDK1004: Assets file not found"] }), "dotnet: NETSDK1004: Assets file not found");
  assert.equal(failureLine("eslint", { code: 0, stdout: "garbage", stderr: "" }, { unparsed: true }), "eslint: its output couldn't be read");
  assert.ok(!failureLine("x", { code: 1, stdout: "", stderr: "line\n".repeat(1000) + "y".repeat(500) }, {}).includes("\n"));
}

// ---- following edits ----
{
  const before = "a\nb\nc\nd\ne\n";
  const ds = [{ rel: "f", line: 1, col: 1, severity: "error", message: "on a" }, { rel: "f", line: 3, col: 2, endLine: 3, endCol: 4, severity: "error", message: "on c" }, { rel: "f", line: 5, col: 1, severity: "warning", message: "on e" }];
  assert.equal(shiftDiags(ds, before, before), ds);
  // Two lines added above c: c's and e's marks move down two, a's stays.
  const ins = shiftDiags(ds, before, "a\nb\nx\ny\nc\nd\ne\n");
  assert.deepEqual(ins.map((d) => [d.line, !!d.stale]), [[1, false], [5, false], [7, false]]);
  assert.equal(ins[1].endLine, 5);
  // A line deleted above e: e's mark moves up one.
  assert.deepEqual(shiftDiags(ds, before, "a\nb\nc\ne\n").map((d) => [d.line, !!d.stale]), [[1, false], [3, false], [4, false]]);
  // c itself edited: its mark is stale (dimmed), the others keep their lines.
  const ed = shiftDiags(ds, before, "a\nb\nC!\nd\ne\n");
  assert.deepEqual(ed.map((d) => [d.line, !!d.stale]), [[1, false], [3, true], [5, false]]);
  assert.equal(ed[1].endLine, undefined);
  // CRLF text against an LF anchor of the same lines: nothing moves.
  assert.deepEqual(shiftDiags(ds, before, before.replace(/\n/g, "\r\n")).map((d) => d.line), [1, 3, 5]);
  // Everything after the edit shifts even when the file shrinks a lot.
  assert.deepEqual(shiftDiags(ds, before, "e\n").map((d) => [d.line, !!d.stale]), [[1, true], [1, true], [1, false]]);
  const bl = byLine([...ds, { rel: "f", line: 1, col: 9, severity: "warning", message: "w" }, { rel: "f", line: 1, col: 5, severity: "error", message: "e2" }]);
  assert.deepEqual(bl.get(0).map((d) => d.message), ["on a", "e2", "w"]);
  assert.equal(worst(bl.get(4)), "warning");
  assert.equal(stripText(bl.get(0).map((d) => ({ ...d, source: "tsc", code: "TS1" }))), "tsc TS1: on a  (+2 more on this line)");
  assert.equal(stripText([]), "");
}

// ---- the tab's rows and f8 ----
{
  const D = (rel, line, severity = "error", col = 1) => ({ root: "/r", rel, line, col, severity, message: `${rel}:${line}`, source: "tsc" });
  const files = [
    { key: "/r|b.ts", root: "/r", rel: "b.ts", diags: [D("b.ts", 9, "warning")] },
    { key: "/r|a.ts", root: "/r", rel: "a.ts", diags: [D("a.ts", 7, "warning"), D("a.ts", 3)] },
    { key: "/r|c.ts", root: "/r", rel: "c.ts", diags: [D("c.ts", 1)] },
    { key: "/r|z.ts", root: "/r", rel: "z.ts", diags: [] },
  ];
  const rows = problemRows(files);
  assert.deepEqual(rows.map((r) => r.kind === "file" ? `F ${r.file.rel} ${r.file.errors}/${r.file.warnings}` : `  ${r.d.line}`), ["F a.ts 1/1", "  3", "  7", "F c.ts 1/0", "  1", "F b.ts 0/1", "  9"]);
  assert.deepEqual(problemRows(files, new Set(["/r|a.ts"])).map((r) => r.kind), ["file", "file", "diag", "file", "diag"]);
  // In the file first, then the next file in list order, wrapping.
  const at = (key, line, col = 0) => ({ key, line, col });
  assert.equal(stepProblem(files, at("/r|a.ts", 0)).d.line, 3);
  assert.equal(stepProblem(files, at("/r|a.ts", 2)).d.line, 7); // the cursor on line 3's problem: the next one
  assert.equal(stepProblem(files, at("/r|a.ts", 5, 3)).d.line, 7);
  assert.equal(stepProblem(files, at("/r|a.ts", 6, 5)).file.rel, "c.ts");
  assert.equal(stepProblem(files, at("/r|b.ts", 20)).file.rel, "a.ts"); // wraps
  assert.equal(stepProblem(files, at("/r|a.ts", 2, 0), -1).file.rel, "b.ts"); // back past the first
  assert.equal(stepProblem(files, at("/r|a.ts", 9), -1).d.line, 7);
  assert.equal(stepProblem(files, null).file.rel, "a.ts");
  assert.equal(stepProblem(files, at("/r|other.ts", 0)).file.rel, "a.ts");
  assert.equal(stepProblem([], null), null);
}

// ---- the prompt for the agent ----
{
  const ds = [
    { root: "C:/work/app", rel: "src/b.ts", line: 2, col: 28, severity: "error", code: "TS2339", message: "Property 'toUpperCase' does not exist on type 'number'.", source: "tsc" },
    { root: "C:/work/app", rel: "src/a.ts", line: 6, col: 7, severity: "warning", code: "@typescript-eslint/no-unused-vars", message: "'unused' is assigned a value but never used.", source: "eslint", stale: true },
  ];
  const lines = { "src/b.ts": ["import { add } from \"./a\";", "export const r = add(1, 2).toUpperCase();"], "src/a.ts": ["", "", "", "", "", "const unused = 5;"] };
  const p = buildProblemsPrompt(ds, { lineOf: (d) => lines[d.rel][d.line - 1], cwd: "/mnt/c/work/app", wsl: true, repos: new Map([["C:/work/app", "app"]]) });
  assert.equal(p, [
    "Problems reported by the project's own checkers (from Wingman, repo: app):",
    "",
    "1. src/b.ts:2:28 error TS2339 (tsc)",
    "   > export const r = add(1, 2).toUpperCase();",
    "   Property 'toUpperCase' does not exist on type 'number'.",
    "",
    "2. src/a.ts:6:7 warning @typescript-eslint/no-unused-vars (eslint) (the line was edited since the check)",
    "   > const unused = 5;",
    "   'unused' is assigned a value but never used.",
    "",
    "Please fix these problems. Reply with what you changed per item.",
  ].join("\n"));
  // No agent folder: full paths; a Windows agent keeps C:/.
  assert.match(buildProblemsPrompt(ds.slice(0, 1), {}), /^1\. C:\/work\/app\/src\/b\.ts:2:28/m);
  assert.match(buildProblemsPrompt(ds.slice(0, 1), { wsl: true }), /^1\. \/mnt\/c\/work\/app\/src\/b\.ts:2:28/m);
  // Hostile message and source line: no control characters reach the terminal.
  const evil = [{ root: "/r", rel: "a.ts", line: 1, col: 1, severity: "error", message: "x\x1b]0;pwned\x07\r\nrm -rf /", code: "C\x00D", source: "t\x1bs" }];
  const pe = buildProblemsPrompt(evil, { lineOf: () => "code\x1b[2J\r\nmore" });
  assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(pe), JSON.stringify(pe));
  assert.equal(pe.split("\n").filter((l) => l.includes("rm -rf")).length, 1); // the newline in the message didn't start a line of its own
  // Capped: what doesn't fit is counted, and the prompt stays under the limit hc send takes.
  const big = Array.from({ length: 2000 }, (_, i) => ({ root: "/r", rel: `src/f${i}.ts`, line: i + 1, col: 1, severity: "error", code: "TS1", message: "m".repeat(200), source: "tsc" }));
  const pb = buildProblemsPrompt(big, { lineOf: () => "x".repeat(300) });
  assert.ok(pb.length <= MAX_PROMPT, String(pb.length));
  assert.match(pb, /\(\d+ more not included: the prompt is capped at 30000 characters\.\)/);
  assert.ok(pb.endsWith("Please fix these problems. Reply with what you changed per item."));
  // Several repos: named in the header.
  assert.match(buildProblemsPrompt([{ ...ds[0] }, { ...ds[0], root: "C:/work/api" }], {}), /repos: app, api\):/);
}
// ---- PROBE_SH (another machine's detection) with a real sh, over hostile names ----
{
  const dir = mkdtempSync(join(tmpdir(), "wm-probe-"));
  try {
    for (const p of ["web/tsconfig.json", "web/eslint.config.mjs", BINS.eslint, BINS.tsc, "Api/Api.csproj", "Api/odd $(touch PWNED) name.csproj", "App.sln"]) {
      mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), "x");
    }
    const rel = "web/src/$(touch PWNED).ts", paths = probes(rel), dirs = ["Api", "", "-n"];
    const out = execFileSync("sh", ["-c", PROBE_SH, "wingman", ...paths.map(dot), "--", ...dirs.map(dot)], { cwd: dir, encoding: "utf8" });
    const { found, names } = parseProbe(out, dirs);
    assert.deepEqual([...found].sort(), [BINS.eslint, BINS.tsc, "web/eslint.config.mjs", "web/tsconfig.json"].sort());
    assert.deepEqual(names.get("Api").sort(), ["Api.csproj", "odd $(touch PWNED) name.csproj"]);
    assert.deepEqual(names.get(""), ["App.sln"]);
    assert.deepEqual(names.get("-n"), []);
    assert.ok(!existsSync(join(dir, "PWNED")) && !existsSync(join(dir, "web", "PWNED")));
    const specs = detect(rel, { exists: (p) => found.has(p) });
    assert.deepEqual(specs.map((s) => [s.id, s.cwd]), [["eslint", "web"], ["tsc", "web"]]);
    assert.equal(specs[0].argv.at(-1), "./src/$(touch PWNED).ts"); // an argument, never a shell word
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual([...parseProbe("f\t./a/../../x\nf\t./ok\nd\t./D/p.csproj\njunk\n", ["D"]).found], ["ok"]);
}
console.log("problems ok");
