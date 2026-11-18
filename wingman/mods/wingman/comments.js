// Review comments: notes the user leaves on lines of a space's files, sent to an agent as one prompt
// (commentprompt.js). Pure: no Herdr imports. A space's comments live in one JSON file under
// <appHome>/data/wingman/comments/, written compare-and-swap through the `io` a caller passes in.
//
// A comment: { id, space, path, root, rel, key, on, repo, as, start, end (1-based, inclusive),
//   snippet (up to 3 lines of the code it is on), anchor (the lines that locate it again; the
//   snippet unless set), text, created, by (the agent that made the change, or null), kind
//   ("line" | "hunk" | "rejected"), stale (true: its lines moved or changed and weren't found) }.
// The file: { v: 1, comments: [...], undo: null | { comments, why: "sent" | "cleared", at } }.
// `undo` holds the last batch sent or cleared, for one "Undo clear", until a comment is added.

export const MAX_TEXT = 2000; // characters in one comment
export const MAX_BATCH = 50; // comments per space (and per prompt)
export const SNIPPET_LINES = 3;
export const SNIPPET_CHARS = 200; // per snippet line
const TRIES = 5; // compare-and-swap attempts before giving up

/**
 * Text as data: CRLF becomes LF, then every control character except newline and tab is dropped
 * (C0, DEL and C1, ESC included), so nothing stored or sent can carry a terminal escape sequence.
 */
export function sanitize(s) {
  return String(s ?? "").replace(/\r\n/g, "\n").replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
}

/** One snippet line: sanitized, newline-free, trailing space trimmed, capped. */
export function snippetLine(s) {
  const t = sanitize(s).replace(/\n/g, "").trimEnd();
  return t.length > SNIPPET_CHARS ? t.slice(0, SNIPPET_CHARS) + "…" : t;
}

/** Up to SNIPPET_LINES lines of `lines` from `start` (0-based), as snippet lines. */
export function snippetOf(lines, start, count = SNIPPET_LINES) {
  return (lines ?? []).slice(Math.max(0, start), Math.max(0, start) + Math.min(count, SNIPPET_LINES)).map(snippetLine);
}

/** The text of a comment, or an error message: sanitized, trimmed, not empty, at most MAX_TEXT. */
export function checkText(text) {
  const t = sanitize(text).trim();
  if (!t) return { error: "The comment is empty" };
  if (t.length > MAX_TEXT) return { error: `The comment is ${t.length} characters; the limit is ${MAX_TEXT}` };
  return { text: t };
}

/** A new comment from a draft (everything but id, text and created), or { error }. */
export function makeComment(draft, text, now = Date.now(), id = null) {
  const t = checkText(text);
  if (t.error) return t;
  const start = Math.floor(Number(draft?.start)), end = Math.floor(Number(draft?.end ?? draft?.start));
  if (!(start >= 1) || !(end >= start)) return { error: "The comment has no valid line" };
  if (!draft.path || !draft.space) return { error: "The comment has no file" };
  const lines = (a) => (Array.isArray(a) ? a.slice(0, SNIPPET_LINES).map(snippetLine) : []);
  return {
    comment: {
      id: id ?? `c${now.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      space: String(draft.space), path: String(draft.path), root: draft.root ?? null, rel: draft.rel ?? null,
      key: draft.key ?? null, on: draft.on ?? null, repo: draft.repo ?? null, as: draft.as ?? null,
      start, end, snippet: lines(draft.snippet), ...(draft.anchor ? { anchor: lines(draft.anchor) } : {}),
      text: t.text, created: now, by: draft.by ?? null, kind: draft.kind ?? "line", stale: false,
    },
  };
}

export const emptyState = () => ({ v: 1, comments: [], undo: null });

/** A comments file's text as state; anything unreadable is an empty state. */
export function parseState(text) {
  if (!text) return emptyState();
  try {
    const d = JSON.parse(text);
    return { v: 1, comments: Array.isArray(d?.comments) ? d.comments.filter((c) => c && typeof c.id === "string") : [], undo: d?.undo?.comments ? d.undo : null };
  } catch { return emptyState(); }
}

// ---- operations: each returns the next state (the same object when nothing changes) or throws ----

/** Adds a comment. Adding ends the chance to undo the last clear. */
export function addComment(state, c) {
  if (state.comments.length >= MAX_BATCH) throw new Error(`A space holds at most ${MAX_BATCH} comments: send or delete some first`);
  return { ...state, comments: [...state.comments, c], undo: null };
}

export function editComment(state, id, text) {
  const t = checkText(text);
  if (t.error) throw new Error(t.error);
  if (!state.comments.some((c) => c.id === id)) throw new Error("That comment is gone");
  return { ...state, comments: state.comments.map((c) => (c.id === id ? { ...c, text: t.text } : c)) };
}

export function deleteComment(state, id) {
  if (!state.comments.some((c) => c.id === id)) return state;
  return { ...state, comments: state.comments.filter((c) => c.id !== id) };
}

/**
 * Removes comments (all, or the ids given: a sent batch, while comments added since stay) and keeps
 * them for one undo. Nothing to remove leaves the state as it is.
 */
export function clearComments(state, why = "cleared", now = Date.now(), ids = null) {
  const gone = ids ? state.comments.filter((c) => ids.includes(c.id)) : state.comments;
  if (!gone.length) return state;
  const left = state.comments.filter((c) => !gone.includes(c));
  return { ...state, comments: left, undo: { comments: gone, why, at: now } };
}

/** Puts the last sent or cleared batch back (before any comments there are now). */
export function undoClear(state) {
  if (!state.undo?.comments?.length) return state;
  return { ...state, comments: [...state.undo.comments, ...state.comments].slice(0, MAX_BATCH), undo: null };
}

// ---- anchoring ----

const same = (line, want) => snippetLine(line) === want;

/**
 * Where comment `c` is now in the file's `lines` (strings, line endings optional). Its anchor lines
 * still at its start: unchanged. Else the nearest place they match (by distance from the old start)
 * moves it there. Not found anywhere: the old line numbers stay and the comment is stale ("moved or
 * changed"). A comment with no anchor lines never moves.
 */
export function relocate(c, lines) {
  const want = c.anchor ?? c.snippet ?? [];
  if (!want.length) return c;
  const n = want.length, last = lines.length - n, at = c.start - 1;
  const fits = (i) => i >= 0 && i <= last && want.every((w, j) => same(lines[i + j], w));
  const moved = (i) => (i === at && !c.stale ? c : { ...c, start: c.start + (i - at), end: c.end + (i - at), stale: false });
  if (fits(at)) return moved(at);
  for (let d = 1; d <= Math.max(at, last - at); d++) {
    if (fits(at - d)) return moved(at - d);
    if (fits(at + d)) return moved(at + d);
  }
  return c.stale ? c : { ...c, stale: true };
}

/** Splits file text into lines without their endings. */
export const textLines = (text) => (typeof text === "string" ? text.split(/\r?\n/) : []);

/** Re-anchors the comments on file `key` against its text; the same state when none moved. */
export function relocateFile(state, key, text) {
  if (typeof text !== "string" || !state.comments.some((c) => c.key === key)) return state;
  const lines = textLines(text);
  let changed = false;
  const comments = state.comments.map((c) => {
    if (c.key !== key) return c;
    const next = relocate(c, lines);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...state, comments } : state;
}

/** The [first, last] 0-based line spans of the comments on file `key` (markers). */
export function spansOn(comments, key) {
  return comments.filter((c) => c.key === key).map((c) => ({ a: c.start - 1, b: c.end - 1, stale: !!c.stale, id: c.id }));
}

// ---- persistence ----

/** A space id as a file name (ids of spaces on other machines hold a "/"). */
export function fileName(space) {
  return String(space).replace(/[^A-Za-z0-9._-]/g, (ch) => `~${ch.charCodeAt(0).toString(16)}`);
}

export const commentsDir = (dataDir) => `${dataDir}/comments`;
export const commentsPath = (dataDir, space) => `${commentsDir(dataDir)}/${fileName(space)}.json`;

/** io: { read(path) -> text | null, write(path, text, expected) (rejects when the file isn't `expected`), mkdir(dir) }. */
export async function loadComments(io, dataDir, space) {
  return parseState(await io.read(commentsPath(dataDir, space)));
}

/**
 * Applies `op(state) -> state` to a space's file, compare-and-swap: when another copy wrote it
 * between the read and the write, it is read again and `op` applied to what is there now (up to
 * TRIES times). `op` may throw (a refused change); that error is thrown as is. Returns
 * { state, changed }; an `op` that returns the same state writes nothing.
 */
export async function updateComments(io, dataDir, space, op) {
  const path = commentsPath(dataDir, space);
  let last = null;
  for (let i = 0; i < TRIES; i++) {
    const before = await io.read(path), state = parseState(before), next = op(state);
    if (next === state) return { state, changed: false };
    try {
      if (before == null) await io.mkdir?.(commentsDir(dataDir));
      await io.write(path, JSON.stringify(next, null, 1) + "\n", before);
      return { state: next, changed: true };
    } catch (e) { last = e; } // someone else wrote it: read again
  }
  throw new Error(`Comments not saved: ${last?.message ?? last}`);
}
