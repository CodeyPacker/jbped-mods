// Project-wide search (Ctrl+Shift+F): runs `git grep` in each repo. git is the one program every
// machine Wingman supports has (ripgrep is not), and `--untracked` makes it cover new files too
// while still skipping ignored ones. The module is pure apart from searchRepo, which takes the
// git function as an argument.
//
// One query, two engines: git does the finding, a JavaScript RegExp built from the same query
// finds each match's position (for highlights and Replace). To keep them in step, regex mode takes
// a subset both read the same way: git runs it as POSIX extended (-E, not -P which many git builds
// lack), and `\d \w \s \D \W \S` are rewritten to POSIX classes for git. What can't be written
// both ways is refused with a short message (see toEre).

const MAX_TEXT = 400, LEAD = 100, WORD = "[A-Za-z0-9_]";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SPAN = "Search can't span lines";

// ---- regex mode: JavaScript source -> POSIX extended source ------------------------------------

const CLASS = { d: "0-9", w: "A-Za-z0-9_", s: "[:space:]" };
const SYNTAX = ".[]()*+?{}|^$\\";

/** The query as git's extended syntax, or throws for what the two engines would read differently. */
function toEre(q) {
  let out = "", i = 0, quant = false; // quant: the last token was a quantifier (a `?` after it is lazy)
  const bad = (m) => { throw new Error(m); };
  while (i < q.length) {
    const c = q[i];
    if (c === "\\") {
      const n = q[i + 1];
      if (n === undefined) bad("Invalid regular expression: \\ at end of pattern");
      i += 2; quant = false;
      if (n === "n" || n === "r") bad(SPAN);
      if (n === "t") out += "\t";
      else if (n === "b" || n === "B") out += "\\" + n;
      else if (CLASS[n]) out += `[${CLASS[n]}]`;
      else if (CLASS[n.toLowerCase()]) out += `[^${CLASS[n.toLowerCase()]}]`;
      else if (SYNTAX.includes(n)) out += "\\" + n;
      else if (/[^A-Za-z0-9]/.test(n) && !"<>`'".includes(n)) out += n;
      else bad(`Not supported in a regular expression: \\${n}`);
    } else if (c === "[") {
      let j = i + 1, set = "[";
      if (q[j] === "^") { set += "^"; j++; }
      if (q[j] === "]") bad("Empty character class: [] is not supported");
      for (;; j++) {
        const k = q[j];
        if (k === undefined) bad("Invalid regular expression: unterminated character class");
        if (k === "]") break;
        if (k === "[" && ":.=".includes(q[j + 1] ?? "")) bad("POSIX classes like [[:alpha:]] are not supported");
        if (k === "\\") {
          const n = q[++j];
          if (n === "t") set += "\t";
          else if (n === "\\") set += "\\";
          else if (CLASS[n]) set += CLASS[n];
          else bad(`Not supported in a character class: \\${n ?? ""}`);
        } else set += k;
      }
      out += set + "]"; i = j + 1; quant = false;
    } else if (c === "(") {
      if (q[i + 1] === "?") bad("Not supported in a regular expression: (? groups and lookarounds");
      out += c; i++; quant = false;
    } else if (c === "{") {
      const m = /^\{\d+(?:,\d*)?\}/.exec(q.slice(i));
      if (!m) bad("Write a literal { as \\{");
      out += m[0]; i += m[0].length; quant = true;
    } else if ("*+?".includes(c)) {
      if (c === "?" && quant) bad("Not supported in a regular expression: lazy quantifiers (*? +? ??)");
      out += c; i++; quant = true;
    } else { out += c; i++; quant = false; }
  }
  return out;
}

// ---- the matcher (shared by grepArgs, parseGrep and the replace functions) -----------------------

/** The JavaScript RegExp for a search (global). Throws like grepArgs; null for an empty query. */
function matcher({ query = "", regex = false, cased = false, word = false } = {}) {
  if (!query) return null;
  if (/[\r\n]/.test(query)) throw new Error(SPAN);
  let src = regex ? query : escapeRe(query);
  if (word) src = `(?<!${WORD})(?:${src})(?!${WORD})`;
  try { return new RegExp(src, cased ? "g" : "gi"); }
  catch (e) { throw new Error("Invalid regular expression: " + String(e.message ?? e).replace(/^Invalid regular expression: /, "")); }
}

// ---- globs -> pathspecs ---------------------------------------------------------------------------

/** "a{b,c}d" -> ["abd", "acd"] (nested groups work). */
function braces(s) {
  const m = /\{([^{}]*)\}/.exec(s);
  return m ? m[1].split(",").flatMap((alt) => braces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length))) : [s];
}

/** Splits at commas outside {braces}. */
function splitGlobs(s) {
  const out = []; let depth = 0, cur = "";
  for (const c of s) {
    if (c === "{") depth++; else if (c === "}") depth = Math.max(0, depth - 1);
    if (c === "," && !depth) { out.push(cur); cur = ""; } else cur += c;
  }
  return [...out, cur];
}

/** "src/**, *.ts" -> git pathspecs. A glob without a slash matches at any depth, and a folder matches its contents. */
function pathspecs(list, magic) {
  const out = [];
  for (const raw of splitGlobs(list ?? "")) for (const g of braces(raw.trim())) {
    let p = g.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!p) continue;
    p = p.startsWith("/") ? p.replace(/^\/+/, "") : p.includes("/") ? p : `**/${p}`;
    out.push(`:(${magic}glob)${p}`, `:(${magic}glob)${p}/**`);
  }
  return out;
}

// ---- git grep ---------------------------------------------------------------------------------------

/** git grep arguments for a search, or null when the query is empty. Throws an Error with a short message for an invalid regular expression. */
export function grepArgs(opts = {}) {
  const { query = "", regex = false, cased = false, word = false, include = "", exclude = "" } = opts;
  if (!matcher(opts)) return null;
  // `-e<query>` in one argument: a query like "C:/x" is never taken for a Windows path (see wslArg in git.js).
  const args = ["grep", "-n", "--column", "-I", "--untracked", "-z", "--no-color", regex ? "-E" : "-F"];
  if (!cased) args.push("-i");
  if (word) args.push("-w");
  args.push("-e" + (regex ? toEre(query) : query), "--");
  const inc = pathspecs(include, ""), exc = pathspecs(exclude, "exclude,");
  return [...args, ...inc, ...exc];
}

/** The text cut to about MAX_TEXT characters around the first range, ranges shifted and clipped to it. */
function cut(line, ranges, anchor) {
  if (line.length <= MAX_TEXT) return { text: line, ranges, shift: 0 };
  const first = anchor;
  let a = Math.max(0, first - LEAD), b = Math.min(line.length, a + MAX_TEXT);
  a = Math.max(0, b - MAX_TEXT);
  const low = (c) => c >= 0xdc00 && c <= 0xdfff, high = (c) => c >= 0xd800 && c <= 0xdbff;
  if (a > 0 && low(line.charCodeAt(a))) a++;
  if (b < line.length && high(line.charCodeAt(b - 1))) b--;
  return {
    text: line.slice(a, b), shift: a,
    ranges: ranges.filter(([f, t]) => t > a && f < b).map(([f, t]) => [Math.max(f, a) - a, Math.min(t, b) - a]),
  };
}

/** The character offset of a 1-based UTF-8 byte column in `line`. */
function charOf(line, byteCol) {
  let bytes = 0, i = 0;
  for (const ch of line) {
    if (bytes >= byteCol - 1) break;
    const cp = ch.codePointAt(0);
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; i += ch.length;
  }
  return i;
}

/** git grep's output as [{ rel, matches: [{ line, col, text, ranges }] }], files in git's order, at most `max` matches in total: { files, total, truncated }. */
export function parseGrep(out, opts, max = 2000) {
  let re = null;
  try { re = matcher(opts); } catch { /* ranges stay empty; col still comes from git */ }
  const files = [], byRel = new Map();
  let total = 0, truncated = false, p = 0;
  // Records are `path NUL line NUL column NUL text \n`; the path may hold anything but NUL.
  while (p < out.length) {
    const a = out.indexOf("\0", p), b = out.indexOf("\0", a + 1), c = out.indexOf("\0", b + 1), e = out.indexOf("\n", c + 1);
    if (a < 0 || b < 0 || c < 0) { truncated = true; break; }
    const end = e < 0 ? out.length : e;
    if (e < 0) truncated = true; // output cut off mid-record (8 MiB cap): drop the partial line
    if (e < 0) break;
    if (total >= max) { truncated = true; break; }
    const rel = out.slice(p, a), line = out.slice(c + 1, end).replace(/\r$/, "");
    p = end + 1;
    const ranges = [];
    if (re) {
      re.lastIndex = 0;
      for (let m; (m = re.exec(line)); ) {
        if (!m[0]) { re.lastIndex++; continue; }
        ranges.push([m.index, m.index + m[0].length]);
      }
    }
    const col = ranges.length ? ranges[0][0] : charOf(line, Number(out.slice(b + 1, c)) || 1);
    const cutLine = cut(line, ranges, col);
    let f = byRel.get(rel);
    if (!f) { f = { rel, matches: [] }; byRel.set(rel, f); files.push(f); }
    f.matches.push({ line: Number(out.slice(a + 1, b)), col: col - cutLine.shift, text: cutLine.text, ranges: cutLine.ranges });
    total++;
  }
  return { files, total, truncated };
}

/** Runs the search in one repo: grepArgs + git + parseGrep. Resolves to { files, total, truncated, error }. `run` is the git function (injected so tests can fake it). git grep exits 1 when nothing matched: that is an empty result, not an error. */
export async function searchRepo(run, root, opts, { on = null, max = 2000 } = {}) {
  const none = { files: [], total: 0, truncated: false, error: null };
  let args;
  try { args = grepArgs(opts); } catch (e) { return { ...none, error: e.message }; }
  if (!args) return none;
  let r;
  try { r = await run(args, { cwd: root, on, timeout: 60000 }); }
  catch (e) { return { ...none, error: String(e?.message ?? e) }; }
  if (r.code === 1 && !r.stdout) return none;
  if (r.code !== 0 && !r.stdout) {
    return { ...none, error: (r.stderr || "").trim().split("\n")[0].replace(/^(fatal|error): /, "") || `git grep failed (${r.code})` };
  }
  const res = parseGrep(r.stdout, opts, max);
  return { ...res, truncated: res.truncated || r.code !== 0, error: null };
}

// ---- replace -------------------------------------------------------------------------------------------

/** `$$`, `$&`, `$1`..`$99` and `$<name>` in a regex-mode replacement, for match `m` of `str`. */
function expand(rep, m, str) {
  return rep.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (all, t) => {
    if (t === "$") return "$";
    if (t === "&") return m[0];
    if (t === "`") return str.slice(0, m.index);
    if (t === "'") return str.slice(m.index + m[0].length);
    if (t[0] === "<") return m.groups && t.slice(1, -1) in m.groups ? m.groups[t.slice(1, -1)] ?? "" : all;
    const n = Number(t);
    if (n >= 1 && n < m.length) return m[n] ?? "";
    if (t.length === 2 && Number(t[0]) >= 1 && Number(t[0]) < m.length) return (m[Number(t[0])] ?? "") + t[1];
    return all;
  });
}

function replaceWith(re, line, opts, replacement) {
  let out = "", at = 0, count = 0;
  re.lastIndex = 0;
  for (let m; (m = re.exec(line)); ) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += line.slice(at, m.index) + (opts.regex ? expand(replacement, m, line) : replacement);
    at = m.index + m[0].length; count++;
  }
  return { text: out + line.slice(at), count };
}

/** For Replace: the text of `line` with every match replaced: `$1`, `$&`, `$$` work in regex mode, and the replacement is plain text otherwise (no case preserving). Returns the new line. */
export function replaceInLine(lineText, opts, replacement) {
  const re = matcher(opts);
  return re ? replaceWith(re, lineText, opts, replacement).text : lineText;
}

/** A plan for "Replace All": given parseGrep's files and each file's full current text (an object or Map by rel), the new text per file and how many replacements: [{ rel, text, count }]. Only the lines parseGrep reported are searched again, in the full text (the grep result's text may be cut), and the file's line endings and final newline stay as they were. Files with no replacement are left out. */
export function replacePlan(files, texts, opts, replacement) {
  const re = matcher(opts), plan = [];
  if (!re) return plan;
  for (const { rel, matches } of files) {
    const text = texts instanceof Map ? texts.get(rel) : texts[rel];
    if (typeof text !== "string") continue;
    const lines = text.split("\n"), todo = new Set(matches.map((m) => m.line));
    let count = 0;
    for (const n of todo) {
      const raw = lines[n - 1];
      if (raw === undefined) continue;
      const cr = raw.endsWith("\r"), r = replaceWith(re, cr ? raw.slice(0, -1) : raw, opts, replacement);
      if (r.count) { lines[n - 1] = r.text + (cr ? "\r" : ""); count += r.count; }
    }
    if (count) plan.push({ rel, text: lines.join("\n"), count });
  }
  return plan;
}
