// The Pull Request overlay's file rail (#24) and its review threads under their lines (#25). Pure: no Herdr imports.

// Tests, docs and generated files: the rail's second group. The patterns are Tourist's.
const TEST = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[^/]+$|Tests?\.cs$|_test\.(go|py|rs)$|(^|\/)test_[^/]+\.py$/i;
const DOCS = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i;
const GENERATED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|packages\.lock\.json)$|\.lock$|\.min\.(js|css)$|\.snap$|\.(g|designer)\.cs$|(^|\/)(dist|build|generated|__generated__|vendor)\//i;

export function isSideFile(path) {
  const p = String(path ?? "");
  return TEST.test(p) || DOCS.test(p) || GENERATED.test(p);
}

// { code, side }: code files, then tests, docs and generated files, each in the detail's order.
export function groupFiles(files) {
  const code = [], side = [];
  for (const f of files ?? []) (isSideFile(f.path) ? side : code).push(f);
  return { code, side };
}

// The viewed marks' file name for one Pull Request: its repo and number, path-safe.
export function viewedKey(pr) {
  const number = String(pr?.id ?? "").split(/[#!]/).pop();
  return `${pr?.repo ?? ""}-pr-${number}`.replace(/[^A-Za-z0-9._-]+/g, "_");
}

// Azure's paths start with "/", git's and GitHub's don't: threads and viewed marks compare paths without it.
export const barePath = (p) => String(p ?? "").replace(/^\/+/, "");
const bare = barePath;

// The saved marks ({ head, files }), keyed by bare path, when they were made on this head, else none: a new push unmarks every file.
export function applyViewed(saved, head) {
  if (!saved || typeof saved !== "object" || saved.head !== head) return {};
  const files = saved.files && typeof saved.files === "object" && !Array.isArray(saved.files) ? saved.files : {};
  return Object.fromEntries(Object.entries(files).filter(([, v]) => v === true).map(([k]) => [bare(k), true]));
}


// The threads that sit under one diff row: same file, same line, and the old side for a "-" row, the new side
// for the others. Hunk headers and "\ No newline" rows have no number and match nothing.
export function threadsOn(threads, path, row) {
  if (row?.number === undefined) return [];
  const side = row.kind === "-" ? "old" : "new", p = bare(path);
  return (threads ?? []).filter((th) => th.line != null && th.line === row.number && th.side === side && bare(th.path) === p);
}

// The threads no shown diff row takes: no line (outdated, or on the file), a file not in the list, or a line on no
// row of that file's diff. rowsOf(file) gives the file's diff rows.
export function unplacedThreads(threads, files, rowsOf) {
  const byPath = new Map((files ?? []).map((f) => [bare(f.path), f]));
  return (threads ?? []).filter((th) => {
    const f = th.line == null ? null : byPath.get(bare(th.path));
    return !f || !rowsOf(f).some((r) => threadsOn([th], f.path, r).length);
  });
}
