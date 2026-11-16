// Problems: the project's own checkers (eslint, tsc, dotnet build, or a command set per repo) run
// one-shot, and what they report becomes diagnostics. Pure: no Herdr imports. problemsview.js
// detects, runs and draws; this file decides which checkers apply, parses their output, and keeps
// the lists in shape (caps, line shifts after edits, the prompt for the agent).
//
// Checker output is untrusted data: only the first MAX_OUTPUT characters are read, nothing is
// evaluated, every path must land inside the repo root, and messages are capped with control and
// bidirectional-override characters removed.
import { words } from "./inlineedit.js";
import { sanitize, snippetLine } from "./comments.js";
import { agentView, relativeTo, MAX_PROMPT } from "./commentprompt.js";

export const MAX_DIAGS = 1000; // kept per repo
export const MAX_MESSAGE = 300; // characters of one message
export const MAX_OUTPUT = 2 * 1024 * 1024; // characters of a checker's output that are read
export const FILE_MS = 20000; // a file-scope checker's time limit
export const PROJECT_MS = 180000; // a project-scope checker's time limit
export const MAX_NOTES = 5; // errors without a place in the repo, kept for the failure line
export const PARSER_IDS = ["tsc", "eslint-json", "generic"]; // what the Problems command can name (msbuild is dotnet's own)

// ---- text ------------------------------------------------------------------------

/** Only text and numbers are read from parsed output: anything else (an object, a hostile toString) is "". */
const str = (v) => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

// C0, DEL, C1, line and paragraph separators, and the bidirectional overrides and isolates.
const CONTROL = /[\x00-\x1F\x7F-\x9F\u2028\u2029\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;

/** A message as shown and sent: whitespace runs as one space, control characters removed, capped. */
export function cleanMessage(s, max = MAX_MESSAGE) {
  const t = str(s).replace(/[\r\n\t]+/g, " ").replace(CONTROL, "").replace(/ {2,}/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

const cleanCode = (s) => { const t = cleanMessage(s, 80); return t || undefined; };

/** At most MAX_OUTPUT characters of `s`. */
export const capOutput = (s) => { const t = str(s); return t.length > MAX_OUTPUT ? t.slice(0, MAX_OUTPUT) : t; };

// ---- paths -----------------------------------------------------------------------

const slash = (p) => str(p).replace(/\\/g, "/");
const isAbs = (p) => /^[A-Za-z]:\//.test(p) || p.startsWith("/");
const caseless = (p) => /^[A-Za-z]:\//.test(p) || /^\/mnt\/[a-z]\//i.test(p) || /^\/\/(wsl\.localhost|wsl\$)\//i.test(p);

/** `rel` with "." and ".." resolved; null when it climbs out of its start. */
export function normRel(rel) {
  const out = [];
  for (const s of slash(rel).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") { if (!out.length) return null; out.pop(); continue; }
    out.push(s);
  }
  return out.join("/");
}

/**
 * A path a checker printed, as a path inside the repo, or null (outside it, climbing out with
 * "..", empty, or holding control characters). ctx.roots: the repo root as each side may print it
 * (C:/x and /mnt/c/x); ctx.cwd: the folder the checker ran in, relative to the root.
 */
export function relOf(path, { roots = [], cwd = "" } = {}) {
  let p = slash(path).trim();
  if (!p || /[\x00-\x1F\x7F]/.test(p)) return null;
  if (/^file:\/\//i.test(p)) p = decodeURIComponent(p.replace(/^file:\/\/(\/(?=[A-Za-z]:))?/i, ""));
  let rel;
  if (isAbs(p)) {
    rel = null;
    for (const r0 of roots) {
      const r = slash(r0).replace(/\/+$/, "");
      if (!r) continue;
      const fold = caseless(r) && caseless(p), a = fold ? p.toLowerCase() : p, b = fold ? r.toLowerCase() : r;
      if (a.startsWith(b + "/")) { rel = p.slice(r.length + 1); break; }
    }
    if (rel == null) return null;
  } else rel = cwd ? `${cwd}/${p}` : p;
  const n = normRel(rel);
  return n ? n : null;
}

// ---- diagnostics -----------------------------------------------------------------

const toInt = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null; };

/** A diagnostic from parsed pieces, or null when its path isn't inside the repo. */
function diag(ctx, { path, line, col, endLine, endCol, severity, code, message, source }) {
  const rel = relOf(path, ctx);
  if (rel == null) return null;
  const d = { root: ctx.root ?? "", rel, line: toInt(line) ?? 1, col: toInt(col) ?? 1, severity: severity === "warning" ? "warning" : "error", message: cleanMessage(message) || "(no message)", source };
  const el = toInt(endLine), ec = toInt(endCol), c = cleanCode(code);
  if (el != null) d.endLine = el;
  if (ec != null) d.endCol = ec;
  if (c) d.code = c;
  return d;
}

const linesOf = (text) => capOutput(text).split(/\r?\n/);

/**
 * tsc --pretty false: `path(line,col): error TS1234: message`, with indented lines after it
 * continuing the message. Lines like `error TS5083: Cannot read file …` (no place) are notes.
 */
export function parseTsc(text, ctx = {}) {
  const diags = [], notes = [];
  let last = null;
  for (const l of linesOf(text)) {
    const m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): ?(.*)$/.exec(l);
    if (m) {
      last = diag(ctx, { path: m[1], line: m[2], col: m[3], severity: m[4], code: m[5], message: m[6], source: ctx.source ?? "tsc" });
      if (last) diags.push(last); else if (notes.length < MAX_NOTES) notes.push(cleanMessage(`${m[5]}: ${m[6]}`));
      continue;
    }
    const g = /^(?:error|warning) (TS\d+): ?(.*)$/.exec(l.trim());
    if (g) { last = null; if (notes.length < MAX_NOTES) notes.push(cleanMessage(`${g[1]}: ${g[2]}`)); continue; }
    if (last && /^\s+\S/.test(l)) last.message = cleanMessage(`${last.message} ${l}`);
    else last = null;
  }
  return { diags, notes };
}

/** eslint --format json: [{ filePath, messages: [{ line, column, endLine, endColumn, severity, message, ruleId }] }]. */
export function parseEslintJson(text, ctx = {}) {
  const diags = [], notes = [], t = capOutput(text), at = t.indexOf("[");
  let data;
  try { data = at < 0 ? null : JSON.parse(t.slice(at)); } catch { data = null; }
  if (!Array.isArray(data)) return { diags, notes, unparsed: true };
  for (const file of data) {
    if (!file || typeof file !== "object" || !Array.isArray(file.messages)) continue;
    for (const m of file.messages) {
      if (!m || typeof m !== "object") continue;
      const d = diag(ctx, { path: file.filePath, line: m.line, col: m.column, endLine: m.endLine, endCol: m.endColumn,
        severity: m.severity === 1 ? "warning" : "error", code: typeof m.ruleId === "string" ? m.ruleId : undefined, message: m.message, source: ctx.source ?? "eslint" });
      if (d) diags.push(d); else if (notes.length < MAX_NOTES) notes.push(cleanMessage(m.message));
      if (diags.length >= MAX_DIAGS * 2) return { diags, notes };
    }
  }
  return { diags, notes };
}

/**
 * MSBuild (dotnet build): `path(line,col): error CS1234: message [project]`, also `path(l,c,el,ec)`
 * and `path(line)`. The same line comes twice (as it happens and in the summary): kept once. An
 * error with no place, or one outside the repo (an SDK targets file), is a note.
 */
export function parseMsbuild(text, ctx = {}) {
  const diags = [], notes = [], seen = new Set();
  for (const l of linesOf(text)) {
    const m = /^\s*(.+?)\((\d+)(?:,(\d+)(?:,(\d+),(\d+))?)?\)\s*:\s*(error|warning) ([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]*\])?\s*$/.exec(l);
    if (m) {
      const d = diag(ctx, { path: m[1], line: m[2], col: m[3], endLine: m[4], endCol: m[5], severity: m[6], code: m[7], message: m[8], source: ctx.source ?? "dotnet" });
      if (!d) { if (m[6] === "error" && notes.length < MAX_NOTES) notes.push(cleanMessage(`${m[7]}: ${m[8]}`)); continue; }
      const k = `${d.rel}|${d.line}|${d.col}|${d.severity}|${d.code}|${d.message}`;
      if (!seen.has(k)) { seen.add(k); diags.push(d); }
      continue;
    }
    const g = /^\s*(?:MSBUILD|[^:()]*?)\s*:\s*error ([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]*\])?\s*$/.exec(l);
    if (g && notes.length < MAX_NOTES) { const n = cleanMessage(`${g[1]}: ${g[2]}`); if (!notes.includes(n)) notes.push(n); }
  }
  return { diags, notes };
}

/** `path:line:col: message` or `path:line: message`, with an optional "error:" / "warning:" in front of the message. */
export function parseGeneric(text, ctx = {}) {
  const diags = [], seen = new Set();
  for (const l of linesOf(text)) {
    const m = /^(.+?):(\d+)(?::(\d+))?:\s*(?:(error|warning|warn|note|info)\b\s*:?\s*)?(.*)$/i.exec(l.trim());
    if (!m) continue;
    const sev = (m[4] ?? "error").toLowerCase();
    const d = diag(ctx, { path: m[1], line: m[2], col: m[3], severity: sev === "error" ? "error" : "warning", message: m[5], source: ctx.source ?? "check" });
    if (!d) continue;
    const k = `${d.rel}|${d.line}|${d.col}|${d.message}`;
    if (!seen.has(k)) { seen.add(k); diags.push(d); }
  }
  return { diags, notes: [] };
}

export const PARSERS = { tsc: parseTsc, "eslint-json": parseEslintJson, msbuild: parseMsbuild, generic: parseGeneric };

/** Parses `text` with parser `id` (an unknown id reads as generic). */
export function parse(id, text, ctx) { return (PARSERS[id] ?? parseGeneric)(text, ctx); }

const sevRank = (d) => (d.severity === "error" ? 0 : 1);

/** Errors first, then by file, line and column. */
export const byPlace = (a, b) => sevRank(a) - sevRank(b) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) || a.line - b.line || a.col - b.col;

/** At most `max` diagnostics, errors first: { diags, more } (more: how many were left out). */
export function capDiags(list, max = MAX_DIAGS) {
  const all = [...list].sort(byPlace);
  return { diags: all.slice(0, max), more: Math.max(0, all.length - max) };
}

// ---- which checkers apply --------------------------------------------------------

export const ESLINT_CONFIGS = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts",
  ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml", ".eslintrc"];
// What node_modules/.bin/<name> points to: run with node, which works the same on every system
// (a .bin entry is a link in WSL and Linux, and a .cmd that needs cmd.exe on Windows).
export const BINS = { eslint: "node_modules/eslint/bin/eslint.js", tsc: "node_modules/typescript/bin/tsc", vueTsc: "node_modules/vue-tsc/bin/vue-tsc.js" };
export const ESLINT_FILES = /\.(?:[cm]?[jt]sx?|vue)$/i;
export const TS_FILES = /\.(?:[cm]?tsx?|vue)$/i;
export const CS_FILES = /\.(?:cs|razor|cshtml|csproj|sln|slnx|props|targets)$/i;
const DOTNET_PROJECT = /\.(?:sln|slnx|csproj)$/i;

const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const dirOf = (rel) => { const i = rel.lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); };

/** The folders from `rel`'s own up to the repo root (""); rel null: the root only. */
export function ancestors(rel) {
  if (rel == null) return [""];
  const out = [];
  for (let d = dirOf(rel); ; d = dirOf(d)) { out.push(d); if (!d) break; }
  return out;
}

/** The paths (relative to the root) whose existence decides the checkers for `rel`. */
export function probes(rel) {
  const out = [];
  for (const d of ancestors(rel)) {
    for (const c of ESLINT_CONFIGS) out.push(join(d, c));
    out.push(join(d, "tsconfig.json"), join(d, BINS.eslint), join(d, BINS.tsc), join(d, BINS.vueTsc));
  }
  return out;
}

/**
 * For a repo on another machine, what exists, in one call there: the paths among "$@" (relative
 * to the folder it runs in, as dot() gives them), then, for each folder after "--", its dotnet
 * project files. A fixed script: the paths are arguments and the shell never parses them.
 */
export const PROBE_SH = `seen=; for p; do
  if [ "$p" = -- ]; then seen=1; continue; fi
  if [ -z "$seen" ]; then [ -e "$p" ] && printf 'f\\t%s\\n' "$p"
  else for f in "$p"/*.sln "$p"/*.slnx "$p"/*.csproj; do [ -e "$f" ] && printf 'd\\t%s\\n' "$f"; done; fi
done; exit 0`;

/** A path relative to the root as PROBE_SH takes it: "./a/b", the root as ".". */
export const dot = (d) => (d ? `./${d}` : ".");

/** PROBE_SH's output: { found: Set of paths that exist, names: Map folder -> its project file names } for the folders asked. */
export function parseProbe(out, dirs = []) {
  const found = new Set(), names = new Map(dirs.map((d) => [d, []]));
  for (const l of str(out).split("\n")) {
    const tab = l.indexOf("\t");
    if (tab < 0) continue;
    const k = l.slice(0, tab), rel = normRel(l.slice(tab + 1));
    if (!rel) continue;
    if (k === "f") found.add(rel);
    else if (k === "d") { const i = rel.lastIndexOf("/"), d = i < 0 ? "" : rel.slice(0, i); names.get(d)?.push(rel.slice(i + 1)); }
  }
  return { found, names };
}

/** Whether folders must be listed for `rel` (dotnet's project files have any name). */
export const wantsListing = (rel) => rel == null || CS_FILES.test(rel);

/** `to` (relative to the root) as seen from folder `from` (relative to the root). */
export function relFrom(from, to) {
  const a = from ? from.split("/") : [], b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/") || ".";
}

/** A path argument that can't be read as an option. */
const arg = (p) => (p.startsWith(".") ? p : `./${p}`);

/** The first folder of `dirs` (nearest first) where `has(dir)`, else null. */
const nearest = (dirs, has) => dirs.find(has) ?? null;

/**
 * The checkers for file `rel` (null: the repo as a whole), from what exists: exists(relPath) for
 * probes(rel), listing(dir) -> names in that folder (for dotnet). custom: the repo's Problems
 * command ({ command, parser }) or null. Each: { id, name, scope, cwd, argv, parser, timeout, unit }.
 * `unit` names a run: one file's eslint, or one project's tsc or build.
 */
export function detect(rel, { exists = () => false, listing = () => [], custom = null } = {}) {
  const out = [], dirs = ancestors(rel);
  const binAbove = (from, bin) => { const at = dirs.slice(dirs.indexOf(from)); const d = nearest(at, (x) => exists(join(x, bin))); return d == null ? null : join(d, bin); };
  if (rel == null || ESLINT_FILES.test(rel)) {
    const cfg = rel == null ? null : nearest(dirs, (d) => ESLINT_CONFIGS.some((c) => exists(join(d, c))));
    const bin = cfg == null ? null : binAbove(cfg, BINS.eslint);
    if (bin) out.push({ id: "eslint", name: "eslint", scope: "file", cwd: cfg, parser: "eslint-json", timeout: FILE_MS, unit: `eslint|${rel}`,
      argv: ["node", relFrom(cfg, bin), "--format", "json", arg(relFrom(cfg, rel))] });
  }
  if (rel == null || TS_FILES.test(rel)) {
    const proj = nearest(dirs, (d) => exists(join(d, "tsconfig.json")));
    if (proj != null) {
      const vue = binAbove(proj, BINS.vueTsc), tsc = vue ?? binAbove(proj, BINS.tsc), name = vue ? "vue-tsc" : "tsc";
      if (tsc) out.push({ id: "tsc", name, scope: "project", cwd: proj, parser: "tsc", timeout: PROJECT_MS, unit: `tsc|${proj}`,
        argv: ["node", relFrom(proj, tsc), "--noEmit", "--pretty", "false", "-p", "tsconfig.json"] });
    }
  }
  if (wantsListing(rel)) {
    let found = null;
    for (const d of dirs) {
      const names = (listing(d) ?? []).filter((n) => DOTNET_PROJECT.test(n) && !/[\x00-\x1F]/.test(n)).sort();
      const sln = names.find((n) => /\.slnx?$/i.test(n)), proj = sln ?? names[0];
      if (proj) { found = { d, proj }; break; }
    }
    if (found) out.push({ id: "dotnet", name: "dotnet", scope: "project", cwd: found.d, parser: "msbuild", timeout: PROJECT_MS, unit: `dotnet|${join(found.d, found.proj)}`,
      argv: ["dotnet", "build", arg(found.proj), "--no-restore", "-nologo", "-v:q", "-tl:off", "-clp:NoSummary"] });
  }
  // The repo's own command takes the place of the built-in checkers of its scope (it's set because
  // they don't fit the repo): with {file}, of eslint; without, of tsc and dotnet.
  const ws = words(custom?.command ?? "");
  if (!ws.length) return out;
  const scope = ws.some((w) => w.includes("{file}")) ? "file" : "project", c = customChecker(custom, rel);
  return [...out.filter((s) => s.scope !== scope), ...(c ? [c] : [])];
}

// Runners whose first argument names the tool: "node node_modules/typescript/bin/tsc" is tsc.
const RUNNERS = /^(node|nodejs|npx|pnpx|bunx|bun|deno|python3?|py|uv|uvx|pipx|dotnet|npm|pnpm|yarn)(\.exe|\.cmd)?$/i;

/** A short name for a command: its program, or for a runner (node, npx, python…) the tool it runs. */
export function toolName(ws) {
  const base = (w) => String(w ?? "").split(/[\\/]/).pop().replace(/\.(exe|cmd|js|mjs|cjs)$/i, "");
  let name = base(ws[0]);
  if (RUNNERS.test(ws[0].split(/[\\/]/).pop())) {
    const next = ws.slice(1).find((w) => !w.startsWith("-") && !/^(run|exec|x|-m)$/.test(w));
    if (next) name = base(next);
  }
  return cleanMessage(name, 40) || "check";
}

/**
 * The repo's own Problems command as a checker: words of the template (as Inline edit splits them),
 * {file} filled with the file's path from the root in one pass. With {file} it runs per file (after
 * a save, on open), else for the repo (on demand). null when unset, or {file} with no file.
 */
export function customChecker(custom, rel) {
  const ws = words(custom?.command ?? "");
  if (!ws.length) return null;
  const perFile = ws.some((w) => w.includes("{file}"));
  if (perFile && rel == null) return null;
  const parser = PARSER_IDS.includes(custom.parser) ? custom.parser : "generic";
  const argv = ws.map((w) => w.replace(/\{file\}/g, () => arg(rel)));
  const name = toolName(ws);
  return { id: "custom", name, scope: perFile ? "file" : "project", cwd: "", parser, timeout: perFile ? FILE_MS : PROJECT_MS, unit: perFile ? `custom|${rel}` : "custom|", argv };
}

// ---- running ---------------------------------------------------------------------

/**
 * One run per key at a time. claim(key, spec): true when the caller should run now; false when a
 * run is on, which then runs exactly once more, with the newest spec, when it ends. finish(key):
 * the spec to run next, or null when the key is free again.
 */
export class RunQueue {
  constructor() { this.busy = new Map(); }
  claim(key, spec = null) {
    const b = this.busy.get(key);
    if (b) { b.again = true; b.spec = spec; return false; }
    this.busy.set(key, { again: false, spec: null });
    return true;
  }
  finish(key) {
    const b = this.busy.get(key);
    if (b?.again) { b.again = false; const s = b.spec; b.spec = null; return s ?? true; }
    this.busy.delete(key);
    return null;
  }
  running(key) { return this.busy.has(key); }
  size() { return this.busy.size; }
}

const lastLine = (s) => {
  const l = String(s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).filter((x) => !/^warning:/i.test(x)).pop() ?? "";
  return cleanMessage(l, 160);
};

/**
 * One line for a run that didn't give a usable answer, or null: it couldn't start, timed out, or
 * exited non-zero without anything parseable. r: { code, stdout, stderr } or an Error.
 */
export function failureLine(name, r, { elapsed = 0, timeout = PROJECT_MS, parsed = 0, notes = [], unparsed = false } = {}) {
  const secs = `${Math.round(timeout / 1000)} s`;
  if (r instanceof Error || (r && r.error)) {
    const m = String(r.message ?? r.error ?? r);
    if (/time(d)? ?out/i.test(m) || elapsed >= timeout - 500) return `${name}: timed out after ${secs}`;
    if (/not found|cannot find|no such file|cannot start|ENOENT/i.test(m)) return `${name}: couldn't start (${lastLine(m) || "not found"})`;
    return `${name}: failed: ${lastLine(m)}`;
  }
  if (r.code !== 0 && elapsed >= timeout - 500) return `${name}: timed out after ${secs}`;
  if (parsed > 0) return null;
  if (notes.length) return `${name}: ${notes[0]}`;
  if (r.code === 127 || /: not found$|No such file or directory$|is not recognized as/m.test(str(r.stderr))) {
    // sh's "exec: node: not found", env's "'node': No such file or directory": name the program.
    const prog = /exec: ([^:\s]+): not found/.exec(str(r.stderr))?.[1] ?? /env: '?([^':\s]+)'?: No such file/.exec(str(r.stderr))?.[1];
    if (prog) return `${name}: ${cleanMessage(prog, 60)} isn't on the PATH where the repo's tools run (a login shell's PATH; WSL for a WSL repo)`;
    return `${name}: not found where the repo's tools run (${lastLine(r.stderr || r.stdout) || `exit ${r.code}`})`;
  }
  if (r.code !== 0) return `${name}: exited with ${r.code}${lastLine(r.stderr || r.stdout) ? `: ${lastLine(r.stderr || r.stdout)}` : ""}`;
  if (unparsed) return `${name}: its output couldn't be read`;
  return null;
}

// ---- following edits ---------------------------------------------------------------

const textLines = (t) => String(t ?? "").split(/\r?\n/);

/**
 * Diagnostics reported against `before`, placed in `after`: lines above the edited part stay,
 * lines below it move by the lines added or removed, and lines inside it are marked stale (dimmed
 * until the next run). Approximate: one edited block (common lines at both ends kept).
 */
export function shiftDiags(diags, before, after) {
  if (before === after || before == null || after == null) return diags;
  const X = textLines(before), Y = textLines(after);
  let p = 0, s = 0;
  while (p < X.length && p < Y.length && X[p] === Y[p]) p++;
  while (s < X.length - p && s < Y.length - p && X[X.length - 1 - s] === Y[Y.length - 1 - s]) s++;
  const oldEnd = X.length - s, newEnd = Y.length - s, delta = newEnd - oldEnd;
  return diags.map((d) => {
    const l = d.line - 1;
    if (l < p) return d;
    if (l >= oldEnd) return { ...d, line: d.line + delta, ...(d.endLine != null ? { endLine: d.endLine + delta } : {}) };
    return { ...d, line: Math.min(l, Math.max(p, newEnd - 1)) + 1, stale: true, endLine: undefined, endCol: undefined };
  });
}

// ---- lists ----------------------------------------------------------------------

/** Diagnostics by line (0-based): Map line -> [diag], errors first. */
export function byLine(diags) {
  const m = new Map();
  for (const d of diags) { const l = d.line - 1; if (!m.has(l)) m.set(l, []); m.get(l).push(d); }
  for (const v of m.values()) v.sort((a, b) => sevRank(a) - sevRank(b) || a.col - b.col);
  return m;
}

/** "error" when any is an error, else "warning" (null for none). */
export const worst = (diags) => (!diags?.length ? null : diags.some((d) => d.severity === "error") ? "error" : "warning");

/** One line for the status strip: the first diagnostic, then "+N more". */
export function stripText(diags) {
  if (!diags?.length) return "";
  const d = diags[0];
  return `${d.source}${d.code ? ` ${d.code}` : ""}: ${d.message}${diags.length > 1 ? `  (+${diags.length - 1} more on this line)` : ""}`;
}

/**
 * The Problems tab's rows: one per file (files with errors first, then by path), then its
 * diagnostics unless the file is folded. files: [{ key, root, rel, diags }].
 */
export function problemRows(files, collapsed = new Set()) {
  const order = files.map((f) => ({ ...f, errors: f.diags.filter((d) => d.severity === "error").length, warnings: f.diags.filter((d) => d.severity !== "error").length }))
    .filter((f) => f.diags.length)
    .sort((a, b) => (b.errors > 0) - (a.errors > 0) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0) || (a.root < b.root ? -1 : 1));
  const rows = [];
  for (const f of order) {
    rows.push({ kind: "file", key: `f|${f.key}`, file: f });
    if (collapsed.has(f.key)) continue;
    [...f.diags].sort((a, b) => sevRank(a) - sevRank(b) || a.line - b.line || a.col - b.col)
      .forEach((d, i) => rows.push({ kind: "diag", key: `d|${f.key}|${i}`, file: f, d }));
  }
  return rows;
}

/**
 * The next (dir 1) or previous (dir -1) problem from `at` ({ key, line, col }, 0-based line and
 * col; null: from the start): in the same file first, then the other files in list order,
 * wrapping. files as for problemRows. Returns { file, d } or null.
 */
export function stepProblem(files, at, dir = 1) {
  const list = problemRows(files).filter((r) => r.kind === "file").map((r) => ({ f: r.file, ds: [...r.file.diags].sort((a, b) => a.line - b.line || a.col - b.col) }));
  if (!list.length) return null;
  const fi = at ? list.findIndex((x) => x.f.key === at.key) : -1;
  if (fi >= 0) {
    const ds = list[fi].ds, pos = (d) => [d.line - 1, d.col - 1], cmp = ([l1, c1], [l2, c2]) => l1 - l2 || c1 - c2, here = [at.line ?? 0, at.col ?? 0];
    const hit = dir > 0 ? ds.find((d) => cmp(pos(d), here) > 0) : [...ds].reverse().find((d) => cmp(pos(d), here) < 0);
    if (hit) return { file: list[fi].f, d: hit };
  }
  const n = list.length, start = fi < 0 ? (dir > 0 ? -1 : n) : fi;
  for (let k = 1; k <= n; k++) {
    const x = list[(((start + dir * k) % n) + n) % n];
    if (x.ds.length) return { file: x.f, d: dir > 0 ? x.ds[0] : x.ds[x.ds.length - 1] };
  }
  return null;
}

/** "3 errors, 1 warning" ("No problems" for none). */
export function countText(diags, more = 0) {
  const e = diags.filter((d) => d.severity === "error").length, w = diags.length - e;
  const pl = (n, s) => `${n} ${s}${n === 1 ? "" : "s"}`;
  if (!diags.length) return "No problems";
  return [e ? pl(e, "error") : null, w ? pl(w, "warning") : null].filter(Boolean).join(", ") + (more ? ` (… ${more} more not shown)` : "");
}

// ---- the prompt -----------------------------------------------------------------

/**
 * One prompt listing `diags` for an agent: each with its place (relative to the agent's folder
 * when inside it, /mnt paths for an agent in WSL), severity, code, source and message, and the
 * source line quoted. lineOf(d) -> the line's text or null. Capped at `max` characters: items that
 * don't fit are counted at the end. repos: Map root -> name.
 */
export function buildProblemsPrompt(diags, { lineOf = () => null, cwd = null, wsl = false, repos = new Map(), max = MAX_PROMPT } = {}) {
  const roots = [...new Set(diags.map((d) => d.root))];
  const name = (r) => sanitize(repos.get(r) ?? (slash(r).split("/").filter(Boolean).pop() ?? r)).replace(/\n/g, " ");
  const head = `Problems reported by the project's own checkers (from Wingman, ${roots.length === 1 ? `repo: ${name(roots[0])}` : `repos: ${roots.map(name).join(", ")}`}):`;
  const tail = "Please fix these problems. Reply with what you changed per item.";
  const parts = [head, ""];
  let size = head.length + tail.length + 64, n = 0;
  const sorted = [...diags].sort(byPlace);
  for (const d of sorted) {
    const full = `${slash(d.root).replace(/\/+$/, "")}/${d.rel}`;
    const where = relativeTo(agentView(full, wsl), cwd ? agentView(cwd, wsl) : null);
    const out = [`${n + 1}. ${sanitize(where).replace(/\n/g, "")}:${d.line}:${d.col} ${d.severity}${d.code ? ` ${cleanMessage(d.code, 80)}` : ""} (${cleanMessage(d.source, 40)})${d.stale ? " (the line was edited since the check)" : ""}`];
    const src = lineOf(d);
    if (src != null && String(src).trim()) out.push(`   > ${snippetLine(src)}`);
    out.push(`   ${cleanMessage(d.message)}`);
    const item = out.join("\n");
    if (size + item.length + 2 > max) break;
    parts.push(item, ""); size += item.length + 2; n++;
  }
  if (n < sorted.length) parts.push(`(${sorted.length - n} more not included: the prompt is capped at ${max} characters.)`, "");
  parts.push(tail);
  return sanitize(parts.join("\n"));
}
