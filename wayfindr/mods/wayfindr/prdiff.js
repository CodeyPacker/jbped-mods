// A Pull Request's diff from its local clone (#22) and diff rows for the overlay (#23). Pure: no Herdr imports.

export const MAX_PATCH = 400000; // a file's patch longer than this is cut at its last full line

const STATUS = { A: "added", M: "modified", D: "deleted" };

// git's quoted path ("a\tb", "\303\251") back to text. An unquoted path is returned as is.
export function unquotePath(s) {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const body = s.slice(1, -1), esc = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 };
  let hex = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && /^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) { hex += "%" + parseInt(body.slice(i + 1, i + 4), 8).toString(16).padStart(2, "0"); i += 3; }
    else if (c === "\\" && body[i + 1] in esc) { hex += "%" + esc[body[i + 1]].toString(16).padStart(2, "0"); i += 1; }
    else hex += encodeURIComponent(c);
  }
  try { return decodeURIComponent(hex); } catch { return body; }
}

// The script's stdout: sections opened by "--wayfindr status", "--wayfindr numstat", "--wayfindr patch" and "--wayfindr head".
function sections(stdout) {
  const text = String(stdout ?? "").replace(/\r\n/g, "\n");
  const out = { status: "", numstat: "", patch: "", head: "" };
  const marks = [...text.matchAll(/^--wayfindr (status|numstat|patch|head)$/gm)];
  marks.forEach((m, i) => {
    const from = m.index + m[0].length + 1, to = i + 1 < marks.length ? marks[i + 1].index : text.length;
    out[m[1]] = text.slice(from, to);
  });
  return out;
}

const lines = (s) => s.split("\n").filter((l) => l !== "");

// PRDIFF_SH's stdout into { files, truncated, head }, files in the PrDetail contract's shape. The first three sections
// list the same files in the same order (one git diff each), so they are paired by position. head: the PR branch's
// commit, or null when the output has none.
export function parsePrDiff(stdout) {
  const s = sections(stdout);
  const status = lines(s.status).map((l) => { const tab = l.indexOf("\t"); return { letter: l.slice(0, tab)[0], path: unquotePath(l.slice(tab + 1)) }; });
  const numstat = lines(s.numstat).map((l) => { const [a, d] = l.split("\t"); return { a, d }; });
  const blocks = s.patch.split(/^diff --git /m).slice(1);
  let truncated = false;
  const files = status.map((st, i) => {
    const n = numstat[i] ?? { a: "0", d: "0" };
    const binary = n.a === "-" || n.d === "-";
    let patch = null;
    const block = blocks[i] ?? "";
    const at = block.search(/^@@/m);
    if (!binary && at >= 0) {
      patch = block.slice(at).replace(/\n$/, "");
      if (patch.length > MAX_PATCH) {
        const cut = patch.slice(0, MAX_PATCH), nl = cut.lastIndexOf("\n");
        patch = nl > 0 ? cut.slice(0, nl) : cut;
        truncated = true;
      }
    }
    return {
      path: st.path, oldPath: null, status: STATUS[st.letter] ?? "modified",
      additions: binary ? 0 : Number(n.a) || 0, deletions: binary ? 0 : Number(n.d) || 0, patch, binary,
    };
  });
  const head = /^[0-9a-f]{40}([0-9a-f]{24})?$/i.exec(s.head.trim())?.[0] ?? null;
  return { files, truncated, head };
}

// One row per patch line from the first hunk header: kind "@" a hunk header, "+" added, "-" removed, " "
// unchanged, "" anything else ("\ No newline at end of file"). number: the new-file line for "+" and " ",
// the old-file line for "-". A hunk header resets both counters.
export function diffRows(patch) {
  const all = String(patch ?? "").replace(/\r/g, "").split("\n");
  const first = all.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return [];
  let old = 0, next = 0;
  return all.slice(first).filter((l, i, rest) => !(i === rest.length - 1 && l === "")).map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1) || " ";
    if (kind === "-") return { kind, number: old++, text };
    if (kind === "+") return { kind, number: next++, text };
    if (kind === " ") { old++; return { kind, number: next++, text }; }
    return { kind: "", text: line };
  });
}

// The longest row's length in characters, tabs as four spaces.
export const longestLine = (rows) => rows.reduce((n, r) => Math.max(n, r.text.replace(/\t/g, "    ").length), 0);
