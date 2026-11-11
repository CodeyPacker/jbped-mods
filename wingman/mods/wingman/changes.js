// G1/G2: the Changes view, every uncommitted change in the space's repos (working tree against
// HEAD), with Discard and a commit box. Pure: git output in, git arguments out.

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie).
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const STATUS = [...READ, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"];
export const MAX_FILES = 500;

/** `git status --porcelain=v1 -z --no-renames` output as [{ rel, xy }], at most MAX_FILES. */
export function parseStatus(out) {
  return out.split("\0").filter((e) => e.length > 3).slice(0, MAX_FILES).map((e) => ({ xy: e.slice(0, 2), rel: e.slice(3) }));
}

/**
 * Another machine's status, one call: porcelain v2 with --branch also names HEAD (# branch.oid),
 * which locally is a second call. Same files and letters as STATUS.
 */
export const STATUS_V2 = [...READ, "status", "--porcelain=v2", "-z", "--branch", "--no-renames", "--untracked-files=all"];

/** STATUS_V2's output as { head (null before the first commit), list: [{ rel, xy }] }, xy as v1 writes it. */
export function parseStatusV2(out) {
  const f = out.split("\0"), list = [];
  let head = null;
  for (let i = 0; i < f.length; i++) {
    const e = f[i];
    if (e.startsWith("# branch.oid ")) { const v = e.slice(13).trim(); head = /^[0-9a-f]+$/.test(v) ? v : null; continue; }
    // Fields before the path: "1 XY sub mH mI mW hH hI", "2 ... Xscore" (its old path is the next entry), "u ... h1 h2 h3".
    const skip = { "1": 8, "2": 9, u: 10 }[e[0]];
    if (e[0] === "?" && e[1] === " ") list.push({ xy: "??", rel: e.slice(2) });
    else if (skip && e[1] === " ") {
      let at = 0;
      for (let k = 0; k < skip && at >= 0; k++) { at = e.indexOf(" ", at); if (at >= 0) at++; }
      if (at > 0) list.push({ xy: e.slice(2, 4).replace(/\./g, " "), rel: e.slice(at) });
      if (e[0] === "2") i++;
    }
  }
  return { head, list: list.slice(0, MAX_FILES) };
}

/** The listed files that are on disk (any deletion in the status leaves a file out), for `git hash-object`. */
export const onDisk = (list) => list.filter((x) => !x.xy.includes("D")).map((x) => x.rel);

/** One letter for a status: A added or untracked, D deleted, ! merge conflict, M otherwise. */
export function statusLetter(xy) {
  if (xy === "??" || xy.includes("A")) return "A";
  if (xy.includes("U") || xy === "DD" || xy === "AA") return "!";
  if (xy.includes("D")) return "D";
  return "M";
}

/** What Review says about a file: "3 to review", "reviewed", or null when Review hasn't seen it. */
export function reviewTag(key, review) {
  if (!review || !(key in review)) return null;
  return review[key] > 0 ? `${review[key]} to review` : "reviewed";
}

/**
 * git's global option that reads every path as itself, never as a pattern: without it "app/[slug]/x"
 * also matches "app/s/x", "*" matches every file and a leading ":" is pathspec magic. It goes before
 * the subcommand, and covers paths read from --pathspec-from-file too.
 */
export const LITERAL = "--literal-pathspecs";

/**
 * The git commands that put a file back as HEAD has it: a tracked file is restored (index and
 * working tree); one HEAD doesn't have is unstaged and deleted.
 */
export function discardCommands(rel, inHead) {
  return inHead
    ? [[LITERAL, "restore", "--source=HEAD", "--staged", "--worktree", "--", rel]]
    : [[LITERAL, "rm", "--cached", "-f", "-q", "--ignore-unmatch", "--", rel], [LITERAL, "clean", "-f", "-q", "--", rel]];
}

/** A path in C quotes, as git reads a pathspec file's line: any name (quotes, newlines, spaces at either end) reads back exactly. */
const cquote = (p) => `"${p.replace(/[\\"\x00-\x1f\x7f]/g, (c) => (c === "\\" || c === '"' ? `\\${c}` : `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}`))}"`;

/** The text of a pathspec file naming `paths` (git's --pathspec-from-file, one quoted path per line). */
export const pathspecText = (paths) => paths.map(cquote).join("\n") + "\n";

/**
 * The git commands that commit exactly `paths` with `message`: stage them (new and deleted files
 * too), then commit only them, leaving anything else that was staged as it was. The paths come
 * from `specFile` (pathspecText's text), not the command line, which has room for only so many.
 */
export function commitCommands(paths, message, specFile) {
  if (!paths.length) throw new Error("No files checked");
  if (!message.trim()) throw new Error("Write a commit message");
  const from = ["--pathspec-from-file", specFile];
  return [[LITERAL, "add", "-A", ...from], [LITERAL, "commit", "-m", message.trim(), ...from]];
}

/** git arguments for line counts of uncommitted changes against HEAD. */
export const NUMSTAT = [...READ, "diff", "HEAD", "--numstat", "-z", "--no-renames"];
/** The same in a repo with no commits yet: staged, then unstaged (run both, pass both outputs to parseNumstat). */
export const NUMSTAT_NO_HEAD = [[...READ, "diff", "--cached", "--numstat", "-z", "--no-renames"], [...READ, "diff", "--numstat", "-z", "--no-renames"]];

/** `git diff --numstat -z` outputs (one or more) as Map<rel, { add, del, binary }>; counts for the same file add up. A binary file ("-\t-\tpath") has add 0, del 0, binary true. */
export function parseNumstat(...outs) {
  const map = new Map();
  for (const out of outs) {
    for (const e of out.split("\0")) {
      if (!e) continue;
      const a = e.indexOf("\t"), b = e.indexOf("\t", a + 1);
      const rel = e.slice(b + 1);
      const binary = e.slice(0, a) === "-";
      const cur = map.get(rel) ?? { add: 0, del: 0, binary: false };
      if (!binary) {
        cur.add += Number(e.slice(0, a));
        cur.del += Number(e.slice(a + 1, b));
      }
      cur.binary = cur.binary || binary;
      map.set(rel, cur);
    }
  }
  return map;
}

/** Lines in a text, for a new untracked file's `add`: "a\nb\n" -> 2, "a\nb" -> 2, "" -> 0. */
export function countLines(text) {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
