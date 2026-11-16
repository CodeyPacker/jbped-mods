// G6: Generate commit message. The checked files' diff goes to the inline edit command (the same
// one-shot, no-tools runner as ctrl-k, inlineedit.js) and its answer becomes a draft in the commit
// box. Pure: rows and git output in, the prompt and the cleaned draft out. It never commits.

import { MAX_PROMPT } from "./inlineedit.js";
import { LITERAL } from "./changes.js";

/** The most characters a draft keeps. */
export const MAX_MESSAGE = 2000;
/** Recent commit subjects sent for the style. */
export const SUBJECTS = 10;
/** The file list's share of the prompt at most; the diff gets the rest. */
export const MAX_LIST = 12000;

/** git arguments for the repo's last SUBJECTS commit subjects (fails harmlessly with no commits). */
export const SUBJECT_ARGS = ["log", `-${SUBJECTS}`, "--no-merges", "--format=%s"];

/** git arguments for the diff of `paths` against HEAD (working tree, staged or not), each path read as itself. */
export const diffArgs = (paths) => [LITERAL, "diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "--", ...paths];

/** A line of untrusted text for the prompt: control characters dropped, capped. */
const line = (s, max = 200) => {
  const t = String(s ?? "").replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/** `git log --format=%s` output as at most SUBJECTS clean subjects. */
export const parseSubjects = (out) => String(out ?? "").split(/\r?\n/).map((s) => line(s, 120)).filter(Boolean).slice(0, SUBJECTS);

/** An untracked file's text as a diff of a new file (git's own diff doesn't list untracked files). */
export function newFileDiff(rel, text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [`diff --git a/${rel} b/${rel}`, "new file", "--- /dev/null", `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n") + "\n";
}

/** The file list: one line per file, "M  +12 -3  path". */
export function fileList(files) {
  return files.map((f) => `${f.letter ?? "M"}  ${f.binary ? "binary" : `+${f.add ?? 0} -${f.del ?? 0}`}  ${line(f.rel, 300)}`);
}

const fence = "~~~~~~~~";

/**
 * The prompt: what to write, the style (recent subjects), the files (all of them, up to MAX_LIST
 * characters, then a count), then the diff, cut to fit MAX_PROMPT in all. The list comes before
 * the diff, so a cut loses detail, never files.
 */
export function buildPrompt({ repo, files, diff, subjects = [], max = MAX_PROMPT }) {
  const head = [
    "Write a git commit message for the changes below.",
    "First line: a summary of at most 72 characters, in the imperative mood. If more is needed, a blank line, then a short body wrapped at 72 characters.",
    "Reply with only the message: no code fences, no quotes, no explanation, no trailers.",
    "",
    `Repository: ${line(repo, 100)}`,
    ...(subjects.length ? ["Recent commit subjects here (match their style):", ...subjects.map((s) => `- ${s}`)] : ["(no earlier commits)"]),
    "",
  ];
  const listAll = fileList(files), list = [];
  let size = 0;
  for (const l of listAll) {
    if (size + l.length + 1 > MAX_LIST) break;
    list.push(l); size += l.length + 1;
  }
  if (list.length < listAll.length) list.push(`… and ${listAll.length - list.length} more files`);
  const top = [...head, `Files (${files.length}):`, ...list, "", `${fence} diff ${fence}`].join("\n") + "\n";
  const bottom = `${fence} end of diff ${fence}\n`;
  const text = String(diff ?? "");
  const room = Math.max(0, max - top.length - bottom.length - 80);
  if (text.length <= room) return top + text + (text.endsWith("\n") || !text ? "" : "\n") + bottom;
  const cut = text.slice(0, room), at = cut.lastIndexOf("\n") + 1 || room;
  return top + text.slice(0, at) + bottom + `(the diff was cut here: ${text.length - at} more characters not shown)\n`;
}

/**
 * The command's answer as a draft: CRLF read as LF, a code fence around it removed (also one
 * line of ``` at either end), surrounding quotes dropped, control characters other than newlines
 * and tabs removed, blank lines at the ends trimmed, capped at MAX_MESSAGE. null when nothing is left.
 */
export function cleanMessage(out) {
  let lines = String(out ?? "").replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "").split("\n");
  const trim = () => { while (lines.length && !lines[0].trim()) lines.shift(); while (lines.length && !lines.at(-1).trim()) lines.pop(); };
  trim();
  if (lines.length && /^\s*(```|~~~)[\w.+#-]*\s*$/.test(lines[0])) lines.shift();
  if (lines.length && /^\s*(```|~~~)\s*$/.test(lines.at(-1))) lines.pop();
  trim();
  lines = lines.map((l) => l.replace(/\s+$/, ""));
  let t = lines.join("\n");
  if (/^(["'`])[^]*\1$/.test(t) && t.length > 1) t = t.slice(1, -1).trim();
  if (t.length > MAX_MESSAGE) t = t.slice(0, MAX_MESSAGE).replace(/\s+\S*$/, "").trimEnd();
  return t || null;
}
