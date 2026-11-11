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
 * The git commands that put a file back as HEAD has it: a tracked file is restored (index and
 * working tree); one HEAD doesn't have is unstaged and deleted.
 */
export function discardCommands(rel, inHead) {
  return inHead
    ? [["restore", "--source=HEAD", "--staged", "--worktree", "--", rel]]
    : [["rm", "--cached", "-f", "-q", "--ignore-unmatch", "--", rel], ["clean", "-f", "-q", "--", rel]];
}

/**
 * The git commands that commit exactly `paths` with `message`: stage them (new and deleted files
 * too), then commit only them, leaving anything else that was staged as it was.
 */
export function commitCommands(paths, message) {
  if (!paths.length) throw new Error("No files checked");
  if (!message.trim()) throw new Error("Write a commit message");
  return [["add", "-A", "--", ...paths], ["commit", "-m", message.trim(), "--", ...paths]];
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
