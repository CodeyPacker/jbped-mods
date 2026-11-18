// Line comments on a Pull Request (#27), kept on this computer until a review posts them. Pure: no Herdr
// imports. A comment: { id, path, line, side, startLine?, startSide?, text, code }. It sits under its last
// line (line, side); a range also has startLine and startSide. path has no leading "/"; code is the line's text.
import { barePath } from "./prfiles.js";

// Under Herdr's home: one JSON file per Pull Request, named by viewedKey(pr).
export const COMMENTS_DIR = "data/wayfindr/comments";

// "new" for added and unchanged rows (numbered in the PR's file), "old" for removed ones.
export const sideOf = (row) => (row.kind === "-" ? "old" : "new");
const numbered = (r) => r && r.kind !== "@" && r.number !== undefined;

// A saved file's text into the list. Anything unreadable, or an entry without a place or text, is dropped.
export function parseComments(text) {
  let list;
  try { list = JSON.parse(text ?? "[]"); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter((c) => c && typeof c === "object" && typeof c.id === "string" && typeof c.path === "string"
    && Number.isInteger(c.line) && (c.side === "new" || c.side === "old") && typeof c.text === "string" && c.text.trim())
    .map((c) => ({
      id: c.id, path: barePath(c.path), line: c.line, side: c.side,
      ...(Number.isInteger(c.startLine) && (c.startSide === "new" || c.startSide === "old") ? { startLine: c.startLine, startSide: c.startSide } : {}),
      text: c.text, code: typeof c.code === "string" ? c.code : "",
    }));
}

// The comments under one diff row: same file, same last line and side. Unnumbered rows take none.
export function commentsOn(list, path, row) {
  if (!numbered(row)) return [];
  const side = sideOf(row), p = barePath(path);
  return (list ?? []).filter((c) => barePath(c.path) === p && c.line === row.number && c.side === side);
}

// "12" or "12-18": where a comment sits.
export const linesOf = (c) => (c.startLine !== undefined ? `${c.startLine}-${c.line}` : String(c.line));

// The index of the row with this line on this side, or -1.
export const rowOf = (rows, line, side) => rows.findIndex((r) => numbered(r) && r.number === line && sideOf(r) === side);

// The indexes of the rows covered by saved ranges on this file and by the open box's range.
export function coveredRows(rows, list, path, open) {
  const covered = new Set(), p = barePath(path);
  const add = (c) => {
    const end = rowOf(rows, c.line, c.side), start = rowOf(rows, c.startLine ?? c.line, c.startSide ?? c.side);
    if (end < 0 || start < 0) return;
    for (let i = Math.min(start, end); i <= Math.max(start, end); i++) covered.add(i);
  };
  for (const c of list ?? []) if (barePath(c.path) === p && c.startLine !== undefined) add(c);
  if (open && open.reply == null && barePath(open.path) === p && open.startLine !== undefined) add(open);
  return covered;
}

// The rows from `from` to `to` (indexes), cut short at a hunk header: GitHub takes a range inside one hunk
// only. Both ends are numbered rows. Returns [low, high].
export function rangeOf(rows, from, to) {
  const step = to >= from ? 1 : -1;
  let end = from;
  for (let i = from + step; step > 0 ? i <= to : i >= to; i += step) {
    if (rows[i].kind === "@") break;
    if (numbered(rows[i])) end = i;
  }
  return [Math.min(from, end), Math.max(from, end)];
}

// The open box's place for a click on row i: one line. Null for a hunk header or an unnumbered row.
export function openAt(rows, path, i) {
  const r = rows[i];
  return numbered(r) ? { path: barePath(path), line: r.number, side: sideOf(r) } : null;
}

// The open box extended by a shift-click on row i: from its first line to i, cut at a hunk header. The box
// sits under the range's last row. One row left gives a single line.
export function extendOpen(rows, open, i) {
  if (!open || !numbered(rows[i])) return open;
  const from = rowOf(rows, open.startLine ?? open.line, open.startSide ?? open.side);
  if (from < 0) return open;
  const [a, b] = rangeOf(rows, from, i), end = rows[b], start = rows[a];
  const { startLine: _l, startSide: _s, ...rest } = open;
  return { ...rest, line: end.number, side: sideOf(end), ...(a === b ? {} : { startLine: start.number, startSide: sideOf(start) }) };
}

// The list with the open box's text saved: a new comment, or the edited one replaced. Empty text changes nothing.
export function saveComment(list, open, text, code, id) {
  const body = String(text ?? "").trim();
  if (!open || !body) return list ?? [];
  const place = { path: barePath(open.path), line: open.line, side: open.side,
    ...(open.startLine !== undefined ? { startLine: open.startLine, startSide: open.startSide } : {}) };
  if (open.editId != null && (list ?? []).some((c) => c.id === open.editId)) {
    return list.map((c) => (c.id === open.editId ? { id: c.id, ...place, text: body, code: code ?? c.code ?? "" } : c));
  }
  return [...(list ?? []), { id, ...place, text: body, code: code ?? "" }];
}

export const removeComment = (list, id) => (list ?? []).filter((c) => c.id !== id);

// The verdicts, in the order shown. The author gets Comment only (GitHub refuses the others).
export const VERDICTS = [
  { event: "comment", label: "Comment", hint: "Feedback without a verdict." },
  { event: "approve", label: "Approve", hint: "Approve the changes." },
  { event: "changes", label: "Request changes", hint: "Ask for changes before this merges." },
];
export const verdictsFor = (mine) => (mine ? VERDICTS.slice(0, 1) : VERDICTS);
export const verdictLabel = (event) => VERDICTS.find((v) => v.event === event)?.label ?? "Comment";

// A post needs comments, an approval, or a typed summary.
export const canPost = (list, event, body) => (list ?? []).length > 0 || event === "approve" || String(body ?? "").trim() !== "";

// The saved list as the contract's review: { event, body, comments: [{ path, line, side, startLine?, startSide?, body }] }.
export function toReview(list, event, body) {
  return {
    event, body: String(body ?? "").trim(),
    comments: (list ?? []).map((c) => ({
      path: barePath(c.path), line: c.line, side: c.side,
      ...(c.startLine !== undefined ? { startLine: c.startLine, startSide: c.startSide } : {}),
      body: c.text,
    })),
  };
}

// The confirm line's words.
export function confirmText(event, prId, me, n) {
  return `Post ${verdictLabel(event)} to ${prId} as ${me} with ${n} ${n === 1 ? "comment" : "comments"}? Everyone on the PR will see it.`;
}
