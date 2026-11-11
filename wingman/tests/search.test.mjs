import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { git } from "../mods/wingman/git.js";
import { grepArgs, parseGrep, searchRepo, replaceInLine, replacePlan } from "../mods/wingman/search.js";

// ---- a real repo ---------------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "wm-search-"));
const sh = (...a) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
sh("init", "-q", "."); sh("config", "user.email", "t@t"); sh("config", "user.name", "t");
put(".gitignore", "ignored.txt\nbuild/\n");
put("a.txt", "Hello World\nhello again\nnothing\nHELLOWORLD\n");
put("src/app.ts", "const hello = 1;\nlet x = 'quote\" and $dollar and \\\\back\\\\';\n\tlet tab\there;\n");
put("src/deep/more.ts", "export const Hello = () => 'hello';\n");
put("src/lib.js", "hello from js\n");
put("docs/readme.md", "hello docs\n-dash start and --flag here\n");
put("node_modules/pkg/index.js", "hello from a vendored dependency\n");
put("with space/f g.txt", "hello in a spaced path\nC:/x/y and a:b:c colons 12:34\n");
put("crlf.txt", "first hello\r\nsecond line\r\nthird hello\r\n");
put("unicode.txt", "café CAFÉ naïve\nwiden hello 日本語 hello\n");
put("long.min.js", "x".repeat(2500) + "needle one needle two" + "y".repeat(2500) + "\n");
put("bin.dat", Buffer.concat([Buffer.from("hello\0binary\n")]));
sh("add", "-A"); sh("commit", "-q", "-m", "init");
put("new.txt", "hello untracked\n");           // untracked, not ignored
put("ignored.txt", "hello ignored\n");         // ignored
put("build/out.txt", "hello build output\n");  // ignored folder

const S = (query, o = {}) => searchRepo(git, root, { query, ...o });
const rels = (r) => r.files.map((f) => f.rel).sort();
const only = (r) => r.files.flatMap((f) => f.matches.map((m) => [f.rel, m.line]));

// ---- grepArgs ----------------------------------------------------------------------------------------
assert.equal(grepArgs({ query: "" }), null);
assert.equal(grepArgs({}), null);
assert.throws(() => grepArgs({ query: "a\nb" }), /Search can't span lines/);
assert.throws(() => grepArgs({ query: "a\\nb", regex: true }), /Search can't span lines/);
assert.throws(() => grepArgs({ query: "(", regex: true }), /Invalid regular expression/);
assert.throws(() => grepArgs({ query: "*a", regex: true }), /Invalid regular expression/);
for (const q of ["a(?=b)", "(?:a)", "a+?", "a??", "\\1", "[[:alpha:]]", "[]a]", "a{", "[\\.]", "\\<a"])
  assert.throws(() => grepArgs({ query: q, regex: true }), Error, q);
const a = grepArgs({ query: "x" });
assert.deepEqual(a.slice(0, 11), ["grep", "-n", "--column", "-I", "--untracked", "-z", "--no-color", "-F", "-i", "-ex", "--"]);
assert.ok(!grepArgs({ query: "x", cased: true }).includes("-i"));
assert.ok(grepArgs({ query: "x", word: true }).includes("-w"));
assert.ok(grepArgs({ query: "x", regex: true }).includes("-E"));
assert.ok(grepArgs({ query: "\\d+\\w\\s\\D\\W\\S[\\d_]\\t", regex: true }).includes("-e[0-9]+[A-Za-z0-9_][[:space:]][^0-9][^A-Za-z0-9_][^[:space:]][0-9_]\t"));
assert.deepEqual(grepArgs({ query: "x", include: "src/**, *.ts", exclude: "docs" }).slice(11),
  [":(glob)src/**", ":(glob)src/**/**", ":(glob)**/*.ts", ":(glob)**/*.ts/**", ":(exclude,glob)**/docs", ":(exclude,glob)**/docs/**"]);

// ---- searchRepo: scope --------------------------------------------------------------------------------
let r = await S("hello");
assert.equal(r.error, null);
assert.deepEqual(rels(r), ["a.txt", "crlf.txt", "docs/readme.md", "new.txt", "node_modules/pkg/index.js", "src/app.ts", "src/deep/more.ts", "src/lib.js", "unicode.txt", "with space/f g.txt"]);
assert.ok(!rels(r).includes("ignored.txt") && !rels(r).includes("build/out.txt"), "ignored files never match");
assert.ok(!rels(r).includes("bin.dat"), "binary files never match");
assert.ok(rels(r).includes("new.txt"), "untracked files match");
assert.equal(r.truncated, false);
assert.equal(r.total, r.files.reduce((n, f) => n + f.matches.length, 0));

// ---- options ---------------------------------------------------------------------------------------------
r = await S("hello", { include: "a.txt" });
assert.deepEqual(only(r), [["a.txt", 1], ["a.txt", 2], ["a.txt", 4]]);
r = await S("hello", { include: "a.txt", cased: true });
assert.deepEqual(only(r), [["a.txt", 2]]);
r = await S("Hello", { include: "a.txt", cased: true });
assert.deepEqual(only(r), [["a.txt", 1]]);
r = await S("hello", { include: "a.txt", word: true });
assert.deepEqual(only(r), [["a.txt", 1], ["a.txt", 2]], "HELLOWORLD is not the word hello");
r = await S("hello.*again", { include: "a.txt" });
assert.equal(r.total, 0, "plain mode: '.' is a dot");
r = await S("hello.*again", { include: "a.txt", regex: true });
assert.deepEqual(only(r), [["a.txt", 2]]);
assert.deepEqual(r.files[0].matches[0].ranges, [[0, 11]]);
r = await S("\\bhello\\b \\w+", { include: "a.txt", regex: true });
assert.deepEqual(only(r), [["a.txt", 1], ["a.txt", 2]]);
r = await S("^\\w+ \\w+$", { include: "a.txt", regex: true, cased: true });
assert.deepEqual(only(r), [["a.txt", 1], ["a.txt", 2]]);
r = await S("[0-9]{2}:\\d\\d", { include: "with space/**", regex: true });
assert.deepEqual(r.files[0].matches[0].ranges, [[r.files[0].matches[0].text.indexOf("12:34"), r.files[0].matches[0].text.indexOf("12:34") + 5]]);
r = await S("(hello|HELLOW)o?r?", { include: "a.txt", regex: true });
assert.equal(r.total, 3);
r = await S("hello", { include: "a.txt", regex: true, word: true });
assert.deepEqual(only(r), [["a.txt", 1], ["a.txt", 2]]);

// ---- awkward queries ---------------------------------------------------------------------------------------
r = await S("--flag");
assert.deepEqual(only(r), [["docs/readme.md", 2]]);
r = await S("-dash start");
assert.deepEqual(only(r), [["docs/readme.md", 2]]);
r = await S("-", { include: "docs/**", regex: true });
assert.equal(r.total, 1);
r = await S("'quote\" and $dollar");
assert.deepEqual(only(r), [["src/app.ts", 2]]);
r = await S("$dollar and \\\\back\\\\");
assert.deepEqual(only(r), [["src/app.ts", 2]]);
r = await S("tab\there");
assert.deepEqual(only(r), [["src/app.ts", 3]]);
r = await S("let tab\\there", { regex: true });
assert.deepEqual(only(r), [["src/app.ts", 3]]);
r = await S("hello in a spaced");
assert.deepEqual(only(r), [["with space/f g.txt", 1]]);
r = await S("C:/x/y");
assert.deepEqual(only(r), [["with space/f g.txt", 2]], "a Windows-looking query is not a path");
r = await S("a:b:c colons 12:34");
assert.deepEqual(r.files[0].matches[0], { line: 2, col: 11, text: "C:/x/y and a:b:c colons 12:34", ranges: [[11, 29]] });
r = await S("a.b", { regex: false });
assert.equal(r.total, 0);
r = await S("(", {});
assert.equal(r.error, null, "( is plain text in plain mode");

// ---- globs --------------------------------------------------------------------------------------------------
const globs = async (include, exclude = "") => rels(await S("hello", { include, exclude }));
assert.deepEqual(await globs("*.ts"), ["src/app.ts", "src/deep/more.ts"]);
assert.deepEqual(await globs("src/**"), ["src/app.ts", "src/deep/more.ts", "src/lib.js"]);
assert.deepEqual(await globs("src"), ["src/app.ts", "src/deep/more.ts", "src/lib.js"]);
assert.deepEqual(await globs("deep"), ["src/deep/more.ts"], "a bare folder name matches anywhere");
assert.deepEqual(await globs("src/*.ts"), ["src/app.ts"]);
assert.deepEqual(await globs("src/**/*.ts"), ["src/app.ts", "src/deep/more.ts"]);
assert.deepEqual(await globs("*.js, docs, *.md"), ["docs/readme.md", "node_modules/pkg/index.js", "src/lib.js"]);
assert.deepEqual(await globs("  *.js  ,  docs  "), ["docs/readme.md", "node_modules/pkg/index.js", "src/lib.js"]);
assert.deepEqual(await globs("with space"), ["with space/f g.txt"]);
assert.deepEqual(await globs("*.{ts,md}"), ["docs/readme.md", "src/app.ts", "src/deep/more.ts"]);
assert.deepEqual(await globs("src/deep/"), ["src/deep/more.ts"]);
assert.deepEqual(await globs("./a.txt"), ["a.txt"]);
assert.deepEqual(await globs("", "node_modules, src, *.txt, *.md, long.min.js"), []);
assert.deepEqual(await globs("", "node_modules, src, crlf.txt, with space, docs"), ["a.txt", "new.txt", "unicode.txt"]);
assert.deepEqual(await globs("src/**", "deep"), ["src/app.ts", "src/lib.js"]);
assert.deepEqual(await globs("*.js", "node_modules/**"), ["src/lib.js"]);
assert.deepEqual(await globs(" , ,"), (await globs("")), "empty entries are ignored");

// ---- parse: line endings, long lines, non-ASCII ----------------------------------------------------------------------
r = await S("hello", { include: "crlf.txt" });
assert.deepEqual(r.files[0].matches.map((m) => [m.line, m.text, m.col, m.ranges]), [[1, "first hello", 6, [[6, 11]]], [3, "third hello", 6, [[6, 11]]]]);
r = await S("needle", { include: "long.min.js" });
{
  const m = r.files[0].matches[0];
  assert.ok(m.text.length <= 400 && m.text.length >= 300, `cut to ~400: ${m.text.length}`);
  assert.equal(m.ranges.length, 2);
  for (const [f, t] of m.ranges) assert.equal(m.text.slice(f, t), "needle");
  assert.equal(m.col, m.ranges[0][0]);
  assert.ok(m.col > 0 && m.col <= 100);
}
r = await S("one needle two", { include: "long.min.js" });
assert.equal(r.files[0].matches[0].text.slice(...r.files[0].matches[0].ranges[0]), "one needle two");
r = await S("y", { include: "long.min.js", cased: true, word: false });
{ const m = r.files[0].matches[0]; assert.equal(m.text.length, 400); assert.ok(m.ranges.length >= 1); }
// match near the end of a long line
put("tail.txt", "z".repeat(3000) + "needle\n");
r = await S("needle", { include: "tail.txt" });
{ const m = r.files[0].matches[0]; assert.equal(m.text.slice(...m.ranges[0]), "needle"); assert.ok(m.text.length <= 400); }
// non-ASCII: columns are characters, not bytes
r = await S("hello", { include: "unicode.txt" });
assert.deepEqual(r.files[0].matches[0].ranges, [[6, 11], [16, 21]]);
assert.equal(r.files[0].matches[0].col, 6);
r = await S("日本語");
assert.deepEqual(r.files[0].matches[0].ranges, [[12, 15]]);
r = await S("naïve", { include: "unicode.txt", cased: true });
assert.deepEqual(r.files[0].matches[0].ranges, [[10, 15]]);
// é/É: the JavaScript side folds them, git does only in a UTF-8 locale. Record what git does here.
r = await S("CAFÉ", { include: "unicode.txt" });
const folded = r.total === 1;
if (folded) assert.deepEqual(r.files[0].matches[0].ranges, [[0, 4], [5, 9]]);
console.log("git folds é/É with -i in this locale:", folded);

// ---- max / truncated / no matches / errors --------------------------------------------------------------------------------
r = await searchRepo(git, root, { query: "hello" }, { max: 3 });
assert.equal(r.total, 3); assert.equal(r.truncated, true);
assert.equal(r.files.reduce((n, f) => n + f.matches.length, 0), 3);
r = await searchRepo(git, root, { query: "hello", include: "a.txt" }, { max: 3 });
assert.equal(r.total, 3); assert.equal(r.truncated, false, "exactly max matches is not truncated");
r = await S("zzz-not-there");
assert.deepEqual(r, { files: [], total: 0, truncated: false, error: null });
r = await S("");
assert.deepEqual(r, { files: [], total: 0, truncated: false, error: null });
r = await S("(", { regex: true });
assert.match(r.error, /Invalid regular expression/); assert.equal(r.total, 0);
r = await S("a\nb");
assert.equal(r.error, "Search can't span lines");
r = await searchRepo(git, join(root, "nope"), { query: "x" });
assert.ok(r.error, "a folder that is not there is an error");
r = await searchRepo(async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository\n" }), root, { query: "x" });
assert.equal(r.error, "not a git repository");
r = await searchRepo(async () => ({ code: 0, stdout: "a.txt\x001\x001\x00hel", stderr: "" }), root, { query: "x" });
assert.equal(r.truncated, true); assert.equal(r.total, 0); // output cut mid-record
{ let seen; await searchRepo(async (args, o) => (seen = [args, o], { code: 1, stdout: "", stderr: "" }), "/r", { query: "x" }, { on: "vps" });
  assert.equal(seen[1].cwd, "/r"); assert.equal(seen[1].on, "vps"); }
// parseGrep on its own: a path with a newline and colons
assert.deepEqual(parseGrep("we\nird:1:2\x005\x003\x00a b\r\nx\x001\x001\x00zzz\n", { query: "b" }).files.map((f) => [f.rel, f.matches[0].line, f.matches[0].text, f.matches[0].ranges]),
  [["we\nird:1:2", 5, "a b", [[2, 3]]], ["x", 1, "zzz", []]]);

// ---- replaceInLine -----------------------------------------------------------------------------------------------------------
assert.equal(replaceInLine("Hello hello HELLO", { query: "hello" }, "bye"), "bye bye bye");
assert.equal(replaceInLine("Hello hello", { query: "hello", cased: true }, "bye"), "Hello bye");
assert.equal(replaceInLine("a.b axb", { query: "a.b" }, "$&$1"), "$&$1 axb", "plain mode: no $ handling");
assert.equal(replaceInLine("hello helloworld", { query: "hello", word: true }, "x"), "x helloworld");
assert.equal(replaceInLine("john@home", { query: "(\\w+)@(\\w+)", regex: true }, "$2@$1"), "home@john");
assert.equal(replaceInLine("abc", { query: "b", regex: true }, "[$&]"), "a[b]c");
assert.equal(replaceInLine("abc", { query: "b", regex: true }, "$$"), "a$c");
assert.equal(replaceInLine("abc", { query: "b", regex: true }, "$$&"), "a$&c");
assert.equal(replaceInLine("abc", { query: "(b)", regex: true }, "$2|$1$1"), "a$2|bbc");
assert.equal(replaceInLine("abc", { query: "x*", regex: true }, "-"), "abc", "empty matches are not replaced");
assert.equal(replaceInLine("abc", { query: "" }, "-"), "abc");
assert.equal(replaceInLine("a1b22", { query: "\\d+", regex: true }, "<$&>"), "a<1>b<22>");
assert.equal(replaceInLine("aaa", { query: "a" }, ""), "");

// ---- replacePlan ----------------------------------------------------------------------------------------------------------------
{
  const found = await S("hello", { include: "crlf.txt,a.txt" });
  const texts = { "crlf.txt": "first hello\r\nsecond line\r\nthird hello\r\n", "a.txt": "Hello World\nhello again\nnothing\nHELLOWORLD" };
  const plan = replacePlan(found.files, texts, { query: "hello" }, "bye");
  assert.deepEqual(plan, [
    { rel: "a.txt", text: "bye World\nbye again\nnothing\nbyeWORLD", count: 3 },
    { rel: "crlf.txt", text: "first bye\r\nsecond line\r\nthird bye\r\n", count: 2 },
  ].sort((x, y) => found.files.findIndex((f) => f.rel === x.rel) - found.files.findIndex((f) => f.rel === y.rel)));
  // a Map works; files without text and files with nothing to replace are left out
  const m = new Map([["crlf.txt", "no match here\r\n"]]);
  assert.deepEqual(replacePlan(found.files, m, { query: "hello" }, "x"), []);
  // only reported lines change, matches are found again in the full (uncut) line
  const long = await S("needle", { include: "long.min.js" });
  const full = "x".repeat(2500) + "needle one needle two" + "y".repeat(2500) + "\n";
  const [p] = replacePlan(long.files, { "long.min.js": full }, { query: "needle" }, "N");
  assert.equal(p.count, 2); assert.equal(p.text, full.replaceAll("needle", "N"));
  const subset = [{ rel: "crlf.txt", matches: [{ line: 3 }] }];
  assert.equal(replacePlan(subset, { "crlf.txt": texts["crlf.txt"] }, { query: "hello" }, "Z")[0].text, "first hello\r\nsecond line\r\nthird Z\r\n");
  // regex groups across a plan, CRLF without final newline, mixed endings
  const rx = replacePlan([{ rel: "m", matches: [{ line: 1 }, { line: 2 }, { line: 3 }] }], { m: "k=1\r\nk=2\nk=3\r" }, { query: "k=(\\d)", regex: true }, "v$1");
  assert.deepEqual(rx, [{ rel: "m", text: "v1\r\nv2\nv3\r", count: 3 }]);
}

console.log("search tests pass");
