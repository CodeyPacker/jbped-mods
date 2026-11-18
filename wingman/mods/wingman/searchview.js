// The Search view (Ctrl+Shift+F) in the Edit tab's left column: what main.js draws and writes,
// kept pure so it can be tested. Finding runs through search.js; this module turns its results
// into list rows, the summary line and a match row's pieces, and turns a Replace All plan into
// the same edits a typed change makes (edit.js), so a file under review keeps its review right.
import { replaceInLine } from "./search.js";
import { edit, body, linesOf } from "./edit.js";

/** At most this many matches are listed, over all repos together. */
export const MAX_RESULTS = 2000;

/** 12345 -> "12,345". */
export const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** "1 file", "2,000 files". */
export const many = (n, one) => `${fmt(n)} ${n === 1 ? one : one + "s"}`;
const count = many;

/** The results as list rows: each file, then its matches unless the file is collapsed. Keys are unique. */
export function resultRows(files, collapsed = new Set()) {
  const rows = [];
  for (const f of files) {
    rows.push({ kind: "file", key: `f|${f.key}`, file: f });
    if (!collapsed.has(f.key)) f.matches.forEach((m, i) => rows.push({ kind: "match", key: `m|${f.key}|${i}`, file: f, m, i }));
  }
  return rows;
}

/** Occurrences (highlighted ranges) in a list of result files. */
export const occurrences = (files) => files.reduce((n, f) => n + f.matches.reduce((k, m) => k + Math.max(1, m.ranges.length), 0), 0);

/**
 * The summary line under the search box: { text, error }. `repos`: the space's git repos,
 * `plain`: its plain folders (not searched).
 */
export function summaryOf({ running = false, results = null, repos = 0, plain = 0 }) {
  if (!repos) return { text: plain ? "Search covers git repos" : "", error: false };
  if (running) return { text: "Searching…", error: false };
  if (!results) return { text: "", error: false };
  if (results.error && !results.total) return { text: results.error, error: true };
  if (!results.total) return { text: "No results", error: false };
  if (results.truncated) return { text: `Showing the first ${count(results.total, "result")}`, error: false };
  return { text: `${count(results.total, "result")} in ${count(results.files.length, "file")}`, error: false };
}

/**
 * A match row's text as pieces { text, kind }: "plain", "hit" (a match), or with a replace preview
 * "old" (the match, struck through) and "new" (its replacement). Leading whitespace goes, and a
 * match far into the line is shown after "…" and a few characters before it, as VS Code does.
 */
export function matchPieces(text, ranges, preview = null, lead = 24) {
  let at = /^\s*/.exec(text)[0].length;
  const out = [];
  const first = ranges[0]?.[0] ?? at;
  if (first - at > lead) { at = first - Math.floor(lead / 2); out.push({ text: "…", kind: "plain" }); }
  for (const [a, b] of ranges) {
    if (b <= at) continue;
    const from = Math.max(a, at);
    if (from > at) out.push({ text: text.slice(at, from), kind: "plain" });
    const old = text.slice(from, b);
    if (!preview) out.push({ text: old, kind: "hit" });
    else {
      let next = preview.replace;
      try { next = replaceInLine(old, preview.opts, preview.replace); } catch { /* the plain replacement */ }
      out.push({ text: old, kind: "old" });
      if (next) out.push({ text: next, kind: "new" });
    }
    at = b;
  }
  if (at < text.length) out.push({ text: text.slice(at), kind: "plain" });
  return out;
}

/** The lines that differ between two texts of the same line count: [{ line, text }] (0-based, without terminators), or null when the count differs. */
export function lineEdits(oldText, newText) {
  const a = oldText.split("\n"), b = newText.split("\n");
  if (a.length !== b.length) return null;
  const out = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push({ line: i, text: b[i].replace(/\r$/, "") });
  return out;
}

/**
 * Replace All for one file: `f` is its state as on disk ({ Btext, Ctext, B, C, hunks, plain }), and
 * `newText` the file after replacing (search.js replacePlan). Each changed line becomes a typed
 * edit (edit.js), so the review rules for a user's own edit apply: on unchanged lines the baseline
 * takes the same edit, inside an agent's added lines only the file does. Returns { state, writes }
 * with compare-and-swap writes ({ target, before, after }) for the store, or null when the line
 * count would change.
 */
export function replaceState(f, newText) {
  const edits = lineEdits(f.Ctext ?? "", newText);
  if (!edits) return null;
  let s = f;
  for (const e of edits) {
    const end = { line: e.line, col: body(linesOf(s)[e.line]).length };
    s = edit(s, { line: e.line, col: 0 }, end, e.text).state;
  }
  const writes = [];
  if (s.Ctext !== f.Ctext) writes.push({ target: "current", before: f.Ctext, after: s.Ctext });
  if (!f.plain && s.Btext !== f.Btext) writes.push({ target: "baseline", before: f.Btext, after: s.Btext });
  return { state: s, writes };
}
