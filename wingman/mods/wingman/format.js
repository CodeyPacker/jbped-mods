// Format on save, the pure part: which formatter a file gets (the FORMATTERS table), the temp file's
// name, line endings, and how a formatted text is applied to a reviewed file as ordinary edits.
// No Herdr imports; formatrun.js runs the tools.
import { body, edit } from "./edit.js";
import { segmentHunks } from "./model.js";

export const FORMAT_MS = 10000; // the whole run for one file, in ms
const REGION_CAP = 250000; // cells (500 lines by 500): a bigger changed region is applied as one edit, not diffed line by line

// ---- names --------------------------------------------------------------------------------------

/** The file's extension in lower case when it is plain letters and digits, else "". */
export function extOf(rel) {
  const name = String(rel).split("/").pop();
  const e = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return /^[a-z0-9]{1,8}$/.test(e) ? e : "";
}

let counter = 0;
/** A fresh id for a temp file: lower case letters and digits only, never taken from a file name. */
export const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`.replace(/[^a-z0-9]/g, "");

/** The temp file's name beside the target: `.wingman-fmt-<id>.<ext>`, the extension kept so the tool picks the same language and config. */
export function tempName(id, ext) {
  if (!/^[a-z0-9]+$/.test(id) || !/^[a-z0-9]+$/.test(ext)) throw new Error("unsafe temp file name");
  return `.wingman-fmt-${id}.${ext}`;
}

/** The folders from `dir` up to the repo root (""), nearest first: "a/b" -> ["a/b", "a", ""]. */
export function ancestors(dir) {
  const out = [];
  for (let d = dir || ""; ; d = d.slice(0, d.lastIndexOf("/"))) {
    out.push(d);
    if (!d.includes("/")) { if (d) out.push(""); break; }
  }
  return out;
}

/** `text` with every line ending as `eol`. */
export const withEol = (text, eol) => { const t = text.replace(/\r\n?/g, "\n"); return eol === "\n" ? t : t.replace(/\n/g, eol); };

// ---- the formatter table --------------------------------------------------------------------------
// A formatter: { id, name, exts, find(env) }. env: { root, dir (the file's folder relative to root),
// kind(path) -> "file" | "dir" | null, read(path) -> text | null, windowsNative }. find returns the
// tool to run or null (this repo doesn't have it): { name, cmd, cwd?, write(file) -> argv, info?(file) -> argv,
// ignored?(stdout) -> boolean }. Arguments are always an argv array. To support another formatter,
// add an entry here.

const join = (...p) => p.filter(Boolean).join("/");

const PRETTIER_EXTS = "js jsx mjs cjs ts tsx mts cts json jsonc json5 css scss less html htm vue md markdown mdx yml yaml graphql gql".split(" ");

async function findPrettier(env) {
  const dirs = ancestors(env.dir);
  const hits = await Promise.all(dirs.map((d) => env.kind(join(env.root, d, "node_modules/.bin/prettier"))));
  const i = hits.indexOf("file");
  if (i < 0) return null;
  const modules = join(env.root, dirs[i], "node_modules");
  let cmd = join(modules, ".bin/prettier"), prefix = [];
  // Windows git's repos: .bin holds a .cmd shim exec can't start, so run the package's own script with node.
  if (env.windowsNative) {
    cmd = null;
    for (const entry of ["prettier/bin/prettier.cjs", "prettier/bin-prettier.js", "prettier/bin/prettier.js"]) {
      if ((await env.kind(join(modules, entry))) === "file") { cmd = "node"; prefix = [join(modules, entry)]; break; }
    }
    if (!cmd) return null;
  }
  return {
    name: "Prettier", cmd,
    // Prettier reads .prettierignore from its working folder: the project it was found in, not the file's folder.
    cwd: join(env.root, dirs[i]) || env.root,
    write: (file) => [...prefix, "--write", file],
    // --file-info answers for the real file: ignored by .prettierignore, or no parser for it.
    info: (file) => [...prefix, "--file-info", file],
    ignored: (stdout) => { try { const j = JSON.parse(stdout); return !!j.ignored || !j.inferredParser; } catch { return false; } },
  };
}

const CSHARPIER_CONFIGS = [".csharpierrc", ".csharpierrc.json", ".csharpierrc.yaml", ".csharpierrc.yml"];

async function findCsharpier(env) {
  const dirs = ancestors(env.dir);
  const found = await Promise.all(dirs.map(async (d) => {
    const cfg = (await Promise.all(CSHARPIER_CONFIGS.map((c) => env.kind(join(env.root, d, c))))).includes("file");
    const manifest = await env.read(join(env.root, d, ".config/dotnet-tools.json"));
    let version = null, listed = false;
    try {
      const tools = JSON.parse(manifest ?? "{}").tools ?? {};
      const key = Object.keys(tools).find((k) => /^(dotnet-)?csharpier$/i.test(k));
      listed = !!key; version = key ? tools[key]?.version ?? null : null;
    } catch {}
    return { cfg, listed, version };
  }));
  const hit = found.find((x) => x.cfg || x.listed);
  if (!hit) return null;
  const major = Number.parseInt(String(found.find((x) => x.version)?.version ?? ""), 10);
  // CSharpier 1.0 moved formatting under `format`; the bare form is the 0.x one.
  return { name: "CSharpier", cmd: "dotnet", write: (file) => (Number.isFinite(major) && major < 1 ? ["csharpier", file] : ["csharpier", "format", file]) };
}

export const FORMATTERS = [
  { id: "prettier", name: "Prettier", exts: new Set(PRETTIER_EXTS), find: findPrettier },
  { id: "csharpier", name: "CSharpier", exts: new Set(["cs", "csx"]), find: findCsharpier },
];

/** The formatters that handle a file's extension, in table order. */
export const formattersFor = (rel) => { const e = extOf(rel); return e ? FORMATTERS.filter((f) => f.exts.has(e)) : []; };

// ---- applying a formatted text ----------------------------------------------------------------------

/** The line-level changes from `X` to `Y` (bodies): [{ o, oc, n, nc }], common head and tail trimmed first. */
function lineHunks(X, Y) {
  let a = 0;
  while (a < X.length && a < Y.length && X[a] === Y[a]) a++;
  let b = 0;
  while (b < X.length - a && b < Y.length - a && X[X.length - 1 - b] === Y[Y.length - 1 - b]) b++;
  const x = X.slice(a, X.length - b), y = Y.slice(a, Y.length - b);
  if (!x.length && !y.length) return [];
  if (x.length * y.length > REGION_CAP) return [{ o: a, oc: x.length, n: a, nc: y.length }];
  return segmentHunks(x, y, a, a);
}

/**
 * Applies `text` (a formatter's output) to file state `s` as ordinary edits, last change first, so
 * every one is what typing it would have been (edit.js): lines outside the agent's changes change
 * the baseline too (formatting is never the agent's change), lines inside one stay pending, and the
 * line endings are the file's own. Returns { state, cursor } (the cursor on the same line, shifted
 * by the lines added or removed above it), with `same: true` when `text` is the buffer already, or
 * null when the edits could not reproduce it (the buffer is then left as it is).
 */
export function applyFormat(s, text, tokLines = null, cur = null) {
  const wanted = text.replace(/\r\n?/g, "\n");
  const Y = wanted.split("\n");
  if (Y[Y.length - 1] === "") Y.pop();
  const X = s.C.map(body);
  if (!s.C.length) {
    if (!Y.length) return null;
    const r = edit(s, { line: 0, col: 0 }, { line: 0, col: 0 }, wanted, tokLines);
    return { state: r.state, cursor: cur ? { line: 0, col: 0 } : null };
  }
  // A run of changed lines that has the agent's lines and the user's side by side is applied in
  // pieces (same line count in and out: split where the agent's added lines begin and end), so each
  // piece is the edit it would be if typed alone: outside the agent's change the baseline takes it.
  const agent = (l) => s.hunks.some((h) => l >= h.n && l < h.n + h.nc);
  const hunks = lineHunks(X, Y).flatMap((h) => {
    if (h.oc !== h.nc || h.oc < 2) return [h];
    const out = [];
    for (let k = 0; k < h.oc; k++) {
      const last = out[out.length - 1];
      if (last && agent(h.o + k) === agent(last.o + last.oc - 1)) { last.oc++; last.nc++; } else out.push({ o: h.o + k, oc: 1, n: h.n + k, nc: 1 });
    }
    return out;
  });
  const endsNl = wanted.endsWith("\n"), hasNl = s.C[s.C.length - 1].endsWith("\n");
  if (!hunks.length && (endsNl === hasNl || !endsNl)) return { state: s, cursor: cur, same: true };
  let state = s;
  const len = (l) => body(state.C[l]).length;
  for (const h of [...hunks].reverse()) {
    const repl = Y.slice(h.n, h.n + h.nc).join("\n");
    let a, b, t;
    if (h.oc > 0 && h.nc > 0) { a = { line: h.o, col: 0 }; b = { line: h.o + h.oc - 1, col: len(h.o + h.oc - 1) }; t = repl; }
    else if (h.oc === 0) {
      if (h.o > 0) { a = b = { line: h.o - 1, col: len(h.o - 1) }; t = "\n" + repl; } else { a = b = { line: 0, col: 0 }; t = repl + "\n"; }
    } else if (h.o > 0) { a = { line: h.o - 1, col: len(h.o - 1) }; b = { line: h.o + h.oc - 1, col: len(h.o + h.oc - 1) }; t = ""; }
    else if (h.oc < state.C.length) { a = { line: 0, col: 0 }; b = { line: h.oc, col: 0 }; t = ""; }
    else { a = { line: 0, col: 0 }; b = { line: h.oc - 1, col: len(h.oc - 1) }; t = ""; }
    state = edit(state, a, b, t, tokLines).state;
  }
  // The file ends with a newline now when the formatter says so (a terminator can be added, never taken away).
  if (endsNl && !state.C[state.C.length - 1].endsWith("\n")) {
    const last = state.C.length - 1;
    state = edit(state, { line: last, col: len(last) }, { line: last, col: len(last) }, "\n", tokLines).state;
  }
  if (state.C.map(body).join("\n") !== Y.join("\n")) return null;
  let cursor = null;
  if (cur) {
    let shift = 0, line = cur.line, found = false;
    for (const h of hunks) {
      if (line < h.o) break;
      if (line < h.o + h.oc) {
        // Inside a changed run: the line with the same text (indent aside), else the same place in the run.
        const text = X[line].trim(), same = text ? Y.slice(h.n, h.n + h.nc).findIndex((y) => y.trim() === text) : -1;
        line = Math.max(0, Math.min(h.n + (same >= 0 ? same : Math.min(line - h.o, Math.max(0, h.nc - 1))), state.C.length - 1));
        found = true; break;
      }
      shift += h.nc - h.oc;
    }
    if (!found) line = Math.max(0, Math.min(cur.line + shift, state.C.length - 1));
    cursor = { line, col: Math.min(cur.col, body(state.C[line]).length) };
  }
  return { state, cursor };
}
