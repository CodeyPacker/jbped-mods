// G6: the branch control in the Changes view: list a repo's local branches, switch to one, make
// a new one from HEAD. Pure: git output in, git arguments out. A branch name is checked here
// first (it can't read as an option, a range or a reflog spec), then by git itself
// (`check-ref-format --branch`), and always goes to git as one argument, after `--` where git
// takes it. Switching never forces, never discards, never merges local changes (-m), never stashes.

/** The most branches listed. */
export const MAX_BRANCHES = 200;
/** The longest name taken. */
export const MAX_NAME = 200;

/**
 * Why `name` can't be a branch name, or null. Wingman's own rules, stricter than git's: no leading
 * "-" (an option), no whitespace or control characters, none of ~ ^ : ? * [ \ (revision syntax,
 * globs), no "..", "@{", "//", no "." or "/" at either end of a part, no ".lock" part, not "@" or "HEAD".
 */
export function nameProblem(name) {
  const n = String(name ?? "");
  if (!n.trim()) return "Type a branch name";
  if (n.length > MAX_NAME) return `A branch name has at most ${MAX_NAME} characters`;
  if (n.startsWith("-")) return "A branch name can't start with -";
  if (/[\x00-\x20\x7F-\x9F]/.test(n) || /\s/.test(n)) return "A branch name can't hold spaces or control characters";
  if (/[~^:?*[\\]/.test(n)) return "A branch name can't hold ~ ^ : ? * [ or \\";
  if (n.includes("..") || n.includes("@{") || n.includes("//")) return "A branch name can't hold .., @{ or //";
  if (n === "@" || n === "HEAD") return `"${n}" can't be a branch name`;
  for (const part of n.split("/")) {
    if (!part) return "A branch name can't start or end with /";
    if (part.startsWith(".") || part.endsWith(".")) return "A part of a branch name can't start or end with a dot";
    if (part.endsWith(".lock")) return "A part of a branch name can't end with .lock";
  }
  return null;
}

/** git arguments checking a name the way git does (exit 0: valid). Only for names nameProblem passed. */
export const checkArgs = (name) => ["check-ref-format", "--branch", name];

/** git arguments listing local branches, most recent commit first: "<refname>\0<unix time>" per line. */
export const LIST = ["for-each-ref", "--sort=-committerdate", `--count=${MAX_BRANCHES + 1}`, "--format=%(refname)%00%(committerdate:unix)", "refs/heads/"];

/**
 * LIST's output as [{ name, at, current }]: the current branch first, then the most recent, at
 * most MAX_BRANCHES (the current one always among them). `more`: whether some were left out.
 */
export function parseBranches(out, current) {
  const all = [];
  for (const line of String(out ?? "").split("\n")) {
    const [ref, at] = line.split("\0");
    if (!ref?.startsWith("refs/heads/")) continue;
    const name = ref.slice(11);
    if (name) all.push({ name, at: Number(at) || 0, current: name === current });
  }
  const cur = all.filter((b) => b.current), rest = all.filter((b) => !b.current);
  const list = [...cur, ...rest].slice(0, MAX_BRANCHES);
  return { list, more: all.length > MAX_BRANCHES };
}

/** git arguments switching to an existing local branch (no guessing a remote one, no force, no -m). */
export function switchArgs(name) {
  const why = nameProblem(name);
  if (why) throw new Error(why);
  return ["switch", "--no-guess", "--", name];
}

/** git arguments making branch `name` at HEAD and switching to it (the working tree stays as it is). */
export function createArgs(name) {
  const why = nameProblem(name);
  if (why) throw new Error(why);
  return ["switch", "--no-track", "-c", name, "HEAD"];
}

/** The files of repo `root` among the keys ("<root>|<rel>") with unsaved edits, as repo paths. */
export function unsavedIn(root, keys) {
  return [...new Set(keys)].filter((k) => k.startsWith(`${root}|`)).map((k) => k.slice(root.length + 1)).sort();
}

/** Switching refused for unsaved edits: the message, naming at most 5 files. */
export function unsavedMessage(rels) {
  const shown = rels.slice(0, 5).join(", ") + (rels.length > 5 ? ` and ${rels.length - 5} more` : "");
  return `Unsaved edits in Edit: ${shown}. Save or discard them before switching branches`;
}

/** "3 days ago", "5 min ago", for a branch row (unix seconds; `now` in ms). */
export function ago(at, now = Date.now()) {
  if (!at) return "";
  const s = Math.max(0, Math.round(now / 1000 - at));
  if (s < 60) return "just now";
  const units = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "min"]];
  for (const [n, w] of units) if (s >= n) { const k = Math.floor(s / n); return `${k} ${w}${k === 1 || w === "min" ? "" : "s"} ago`; }
  return "";
}
