// A unified line diff, for Providers that return both sides of a file but no patch (Azure). Pure, no imports.
// LCS over the lines left after the common prefix and suffix, so the table stays within maxLines².
// Hunks match `git diff`'s "@@ -a,b +c,d @@" lines (without git's function context after them).

// Lines with their terminator, so "x" at the end differs from "x\n" as it does in git.
function lines(text) {
  const s = String(text ?? "");
  return s ? s.match(/[^\n]*\n|[^\n]+$/g) : [];
}

// Edit script: [{ op: " " | "-" | "+", line }], deletions before insertions in each change.
function script(a, b) {
  let pre = 0, sa = a.length, sb = b.length;
  while (pre < sa && pre < sb && a[pre] === b[pre]) pre++;
  while (sa > pre && sb > pre && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
  const n = sa - pre, m = sb - pre, w = m + 1;
  // L[i][j]: LCS length of a[pre+i..sa) and b[pre+j..sb).
  const L = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = a[pre + i] === b[pre + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const out = a.slice(0, pre).map((line) => ({ op: " ", line }));
  let dels = [], adds = [];
  const flush = () => { out.push(...dels, ...adds); dels = []; adds = []; };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[pre + i] === b[pre + j]) { flush(); out.push({ op: " ", line: a[pre + i] }); i++; j++; }
    else if (j >= m || (i < n && L[(i + 1) * w + j] >= L[i * w + j + 1])) dels.push({ op: "-", line: a[pre + i++] });
    else adds.push({ op: "+", line: b[pre + j++] });
  }
  flush();
  for (let k = sa; k < a.length; k++) out.push({ op: " ", line: a[k] });
  return out;
}

const range = (start, count) => `${count === 0 ? start - 1 : start}${count === 1 ? "" : `,${count}`}`;

export function unifiedDiff(oldText, newText, { context = 3, maxLines = 3000 } = {}) {
  const a = lines(oldText), b = lines(newText);
  if (a.length > maxLines || b.length > maxLines) return { patch: null, additions: b.length, deletions: a.length, truncated: true };
  const ops = script(a, b);
  // Each op's 1-based line numbers on both sides.
  let o = 1, nw = 1;
  for (const x of ops) { x.o = o; x.n = nw; if (x.op !== "+") o++; if (x.op !== "-") nw++; }
  const changes = ops.map((x, k) => (x.op === " " ? -1 : k)).filter((k) => k >= 0);
  const out = [];
  let additions = 0, deletions = 0;
  for (let c = 0; c < changes.length;) {
    let last = c;
    while (last + 1 < changes.length && changes[last + 1] - changes[last] - 1 <= 2 * context) last++;
    const from = Math.max(0, changes[c] - context), to = Math.min(ops.length, changes[last] + context + 1);
    const hunk = ops.slice(from, to);
    const oc = hunk.filter((x) => x.op !== "+").length, nc = hunk.filter((x) => x.op !== "-").length;
    out.push(`@@ -${range(hunk[0].o, oc)} +${range(hunk[0].n, nc)} @@`);
    for (const x of hunk) {
      if (x.op === "+") additions++;
      if (x.op === "-") deletions++;
      out.push(x.op + x.line.replace(/\n$/, ""));
      if (!x.line.endsWith("\n")) out.push("\\ No newline at end of file");
    }
    c = last + 1;
  }
  return { patch: out.join("\n"), additions, deletions, truncated: false };
}
