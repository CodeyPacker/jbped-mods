// Bracket matching for the built-in editor. Pure: no imports.

const OPEN_TO_CLOSE = { "(": ")", "[": "]", "{": "}" };
const CLOSE_TO_OPEN = { ")": "(", "]": "[", "}": "{" };

/**
 * The bracket pair at the cursor, or null: { open: { line, col }, close: { line, col } } (0-based).
 * `lines`: the file's lines. `pos`: { line, col }; the cursor sits BEFORE the character at col.
 * The bracket just after the cursor wins, else the one just before it. The partner is found by
 * scanning forward (from an opener) or backward (from a closer), counting nesting of the same kind
 * only. `skip(line, col)` true hides a character while scanning (string literals, comments).
 * The scan covers at most `maxLines` lines, counting the cursor's line. Unmatched gives null.
 */
export function matchBracket(lines, pos, { skip = null, maxLines = 2000 } = {}) {
  const at = (line, col) => lines[line]?.[col];
  const after = at(pos.line, pos.col);
  const before = pos.col > 0 ? at(pos.line, pos.col - 1) : undefined;
  let start = null;
  if (after !== undefined && (after in OPEN_TO_CLOSE || after in CLOSE_TO_OPEN)) {
    start = { line: pos.line, col: pos.col };
  } else if (before !== undefined && (before in OPEN_TO_CLOSE || before in CLOSE_TO_OPEN)) {
    start = { line: pos.line, col: pos.col - 1 };
  }
  if (!start) return null;

  const ch = at(start.line, start.col);
  const forward = ch in OPEN_TO_CLOSE;
  const open = forward ? ch : CLOSE_TO_OPEN[ch];
  const close = forward ? OPEN_TO_CLOSE[ch] : ch;
  const lastLine = forward ? start.line + maxLines - 1 : start.line - maxLines + 1;
  const step = forward ? 1 : -1;

  let depth = 1;
  let line = start.line;
  let col = start.col + step;
  while (forward ? line <= lastLine && line < lines.length : line >= lastLine && line >= 0) {
    const text = lines[line];
    while (col >= 0 && col < text.length) {
      const c = text[col];
      if (!(skip && skip(line, col))) {
        if (c === (forward ? open : close)) depth++;
        else if (c === (forward ? close : open)) depth--;
        if (depth === 0) {
          const partner = { line, col };
          return forward
            ? { open: start, close: partner }
            : { open: partner, close: start };
        }
      }
      col += step;
    }
    line += step;
    col = forward ? 0 : (lines[line]?.length ?? 0) - 1;
  }
  return null;
}

// Highlighter token types whose brackets don't count: strings and comments.
const QUIET = new Set(["string", "char", "regex", "comment", "prolog", "doctype", "cdata"]);

/**
 * A `skip(line, col)` for matchBracket from the highlighter's per-line spans ([{ text, type }] per
 * line, highlight.js). A line's ranges are worked out once, when the scan first reaches it. A line
 * whose spans don't add up to its text (`lines` given, tokens not yet redone after an edit) hides nothing.
 */
export function tokenSkip(tokens, lines = null) {
  const cache = new Map();
  const rangesOf = (line) => {
    let r = cache.get(line);
    if (r) return r;
    r = [];
    let at = 0;
    for (const s of tokens?.[line] ?? []) {
      const end = at + s.text.length;
      if (QUIET.has(s.type)) r.push([at, end]);
      at = end;
    }
    if (lines && at !== (lines[line] ?? "").replace(/\r?\n$/, "").length) r = [];
    cache.set(line, r);
    return r;
  };
  return (line, col) => rangesOf(line).some(([a, b]) => col >= a && col < b);
}
