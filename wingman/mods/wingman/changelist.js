// The Changes view's file list and what it keeps loaded. Pure: rows and numbers in, rows and
// decisions out. The list is a virtual list (rows of known heights, one click handler for the
// list), and a row's texts load only while it's picked or next to the picked one.

/** A file row's and a repo header's height in the list (px). One height: the list then takes a single number, as the mod's other lists do. */
export const FILE_H = 26, REPO_H = 26;
/** A press left of this x in an uncommitted file's row is on its checkbox (the row's left padding, then the 14 px box). */
export const CHECK_X = 32;
/** Loaded texts the Changes view keeps in all (characters, both sides of every loaded row). */
export const CHANGES_CHARS = 4e6;

/**
 * The list's rows: every uncommitted file, then "Committed on this branch" per repo, a header
 * each ({ kind: "repo", id, st, count, ai, open }) followed by its files while it's open (`open`:
 * the repo ids expanded). `idOf(st)` names a repo. Keys are unique across the list.
 */
export function listRows(files, committed, open, idOf) {
  const rows = files.map((f) => ({ kind: "file", key: f.key, f }));
  const groups = new Map();
  for (const f of committed) {
    const id = idOf(f.store);
    if (!groups.has(id)) groups.set(id, { st: f.store, files: [] });
    groups.get(id).files.push(f);
  }
  for (const [id, g] of groups) {
    const on = open.has(id);
    rows.push({ kind: "repo", key: `#committed|${id}`, id, st: g.st, count: g.files.length, ai: g.files.filter((f) => f.ai).length, open: on });
    if (on) for (const f of g.files) rows.push({ kind: "file", key: f.key, f });
  }
  return rows;
}

/** The rows' heights as v_virtual_list takes them: one number while every row has the same, else one per row. */
export function rowSizes(rows) {
  const sizes = rows.map((r) => (r.kind === "repo" ? REPO_H : FILE_H));
  return sizes.every((h) => h === sizes[0]) ? sizes[0] ?? FILE_H : sizes;
}

/** What a click on `row` at x (in the list, null when unknown) does: "toggle" a repo header, "check" a checkbox, else "pick". */
export function clickTarget(row, x) {
  if (row.kind === "repo") return "toggle";
  return !row.f.committed && x != null && x >= 0 && x < CHECK_X ? "check" : "pick";
}

/** The committed rows that show (their repo is open), for picking and keyboard steps. */
export const shownCommitted = (committed, open, idOf) => committed.filter((f) => open.has(idOf(f.store)));

/**
 * The uncommitted files next to the picked one (`by` on each side), to load ahead of a keyboard
 * step. A file the cap unloaded (`evicted`) isn't: loading it again would unload it again, every tick.
 */
export function neighbours(files, sel, by = 1) {
  const i = files.findIndex((f) => f.key === sel);
  if (i < 0) return [];
  const out = [];
  for (let d = 1; d <= by; d++) for (const j of [i + d, i - d]) if (files[j] && !files[j].evicted) out.push(files[j]);
  return out;
}

/**
 * Which loaded rows to unload to keep their texts under `cap` characters: least recently used
 * first ({ key, chars, usedAt }), `keep` (the picked row) last, and only when it alone is over the
 * cap. Returns the keys to unload, in order.
 */
export function toUnload(loaded, cap, keep = null) {
  let total = loaded.reduce((n, r) => n + r.chars, 0);
  const out = [], kept = loaded.find((r) => r.key === keep);
  for (const r of [...loaded].sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0))) {
    if (total <= cap) break;
    if (r.key === keep) continue;
    total -= r.chars; out.push(r.key);
  }
  if (kept && total > cap) out.push(kept.key);
  return out;
}

/** A `git cat-file -s` result as a size in bytes, or null when the commit doesn't have the file. */
export function parseBlobSize(r) {
  if (!r || r.code !== 0) return null;
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The placeholder for a file whose sides (sizes, null: absent) are too big to show, or null when they fit. */
export function sizeError(sizes, max) {
  return sizes.some((n) => n != null && n > max) ? `too large to show (over ${Math.round(max / 1048576)} MiB)` : null;
}

/** The placeholder for a committed row that git's numstat calls binary ("-" counts), or null. */
export const binaryError = (counts) => (counts?.binary ? "binary file" : null);
