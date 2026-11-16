// G6: Discard one change (or the selected lines of changes) in the Changes view: those lines go
// back to what HEAD has. Pure: texts in, texts and review writes out. main.js checks for unsaved
// edits, asks first and writes compare-and-swap.
//
// A file under review: the discard is the user's own edit, written the way a save is. Where it
// covers lines Review shows as unchanged, the review baseline takes the same lines, so Review never
// shows the discard as the agent's change; where it covers the agent's lines, only the file changes
// (as typing there would), and Review shows what's left of the agent's change.
import { splitLines, rejectAt, partialAt } from "./model.js";

/** Why a Changes row's changes can't be discarded one at a time, or null. */
export function cantDiscard(f) {
  if (!f || f.lazy) return "The file isn't loaded yet";
  if (f.committed) return "Committed changes can't be discarded here";
  if (f.error) return `${f.rel}: ${f.error}`;
  if (typeof f.Ctext !== "string") return "The file is deleted: use Discard file to bring it back";
  if (f.created || f.inHead === false) return "HEAD doesn't have this file: use Discard file to delete it";
  if (!f.hunks?.length) return "No changes in this file";
  return null;
}

/** The working tree's line ending when every terminated line uses CRLF, else null. */
function crlfOnly(lines) {
  const ended = lines.filter((l) => l.endsWith("\n"));
  return ended.length && ended.every((l) => l.endsWith("\r\n")) ? "\r\n" : null;
}

/**
 * HEAD's text as the working tree writes it: when the working file is all CRLF and HEAD's blob has
 * none (git's autocrlf checkout), HEAD's lines get CRLF, as a checkout would give them.
 */
export function headAsCheckedOut(Btext, Ctext) {
  if (!Btext || Btext.includes("\r\n") || !crlfOnly(splitLines(Ctext ?? ""))) return Btext;
  return Btext.replace(/\n/g, "\r\n");
}

/**
 * The file's text with change `i` (or, with `pick`, only the picked lines: { old: Set of HEAD
 * line indexes, new: Set of current line indexes }) put back as HEAD has it. `f`: a loaded Changes
 * row ({ B, C, Btext, Ctext, hunks }), B being HEAD. Returns the new text.
 */
export function discardText(f, i, pick = null) {
  const Btext = headAsCheckedOut(f.Btext, f.Ctext), B = Btext === f.Btext ? f.B : splitLines(Btext);
  const s = { B, C: f.C, Btext, Ctext: f.Ctext, hunks: f.hunks, oldTok: null, newTok: null };
  if (pick) return partialAt(s, "reject", pick).state.Ctext;
  if (!f.hunks[i]) throw new Error("That change is gone: look again");
  return rejectAt(s, i).state.Ctext;
}

/**
 * Where two versions of a file differ, as one line range: lines [l1, l2) of `before` became
 * `lines` (the after-version's lines in their place). null when they're the same.
 */
export function lineSplice(before, after) {
  const X = splitLines(before ?? ""), Y = splitLines(after ?? "");
  let p = 0, s = 0;
  while (p < X.length && p < Y.length && X[p] === Y[p]) p++;
  while (s < X.length - p && s < Y.length - p && X[X.length - 1 - s] === Y[Y.length - 1 - s]) s++;
  if (p === X.length && p === Y.length) return null;
  return { l1: p, l2: X.length - s, lines: Y.slice(p, Y.length - s) };
}

/**
 * Where lines [l1, l2) of the current file sit in the review baseline when no change of the review
 * (`hunks`: baseline -> current) touches them, else null. An empty range (lines put in at l1) is
 * untouched unless it falls inside a change's added lines.
 */
export function baselineAt(hunks, l1, l2) {
  const touches = (h) => (l2 > l1
    ? (h.nc > 0 ? h.n < l2 && h.n + h.nc > l1 : h.n > l1 && h.n < l2)
    : h.nc > 0 && h.n < l1 && h.n + h.nc > l1);
  if (hunks.some(touches)) return null;
  const before = hunks.filter((h) => (h.nc > 0 ? h.n + h.nc <= l1 : h.n <= l1));
  return l1 - before.reduce((d, h) => d + h.nc - h.oc, 0);
}

/**
 * The review writes for a discard in a file under review: `rf` is the review's file (store.load:
 * B baseline, C current, hunks), `after` the file's new text. Returns [{ target, before, after }]:
 * the file, and the baseline too when the discarded lines are unchanged in Review (checked line by
 * line; otherwise the file alone changes). Throws when the review's file isn't the text discarded from.
 */
export function reviewWrites(rf, before, after) {
  if (rf.Ctext !== before) throw new Error(`${rf.rel ?? "The file"} changed since it was shown: look again`);
  const writes = [{ target: "current", before, after }], sp = lineSplice(before, after);
  if (!sp) return [];
  const b1 = baselineAt(rf.hunks ?? [], sp.l1, sp.l2);
  if (b1 == null) return writes;
  const B = rf.B ?? splitLines(rf.Btext ?? ""), C = splitLines(before), n = sp.l2 - sp.l1;
  for (let k = 0; k < n; k++) if (B[b1 + k] !== C[sp.l1 + k]) return writes; // not where the hunks say: the file alone
  const nextB = [...B.slice(0, b1), ...sp.lines, ...B.slice(b1 + n)].join("");
  if (nextB !== rf.Btext) writes.push({ target: "baseline", before: rf.Btext, after: nextB });
  return writes;
}

/** What a discard covers, for the confirm: "change 2 of 3 (lines 10-12)" or "3 selected lines". */
export function discardWhat(f, i, pick = null) {
  if (pick) {
    const n = pick.old.size + pick.new.size;
    return `${n} selected changed line${n === 1 ? "" : "s"}`;
  }
  const h = f.hunks[i];
  const at = !h.nc ? `removed at line ${h.n + 1}` : h.nc === 1 ? `line ${h.n + 1}` : `lines ${h.n + 1}-${h.n + h.nc}`;
  return `change ${i + 1} of ${f.hunks.length} (${at})`;
}

/** The confirm line. */
export function discardQuestion(f, i, pick = null) {
  return `Discard ${discardWhat(f, i, pick)} in ${f.rel}? Those lines go back to what HEAD has. Ctrl+Z here puts them back.`;
}
