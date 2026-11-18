// Inline edit (ctrl-k): an instruction about a few lines goes to a one-shot local model command
// (default `claude -p`, no tools), and its answer replaces those lines as a pending review change.
// Pure: no Herdr imports. main.js runs the command (exec) and applies the answer.
//
// The prompt reaches the command as one argv element (or a temp file), never through a shell
// line: the template is split into words once, and {prompt} / {promptFile} are filled in a single
// pass, so nothing in the instruction or the code is read as a placeholder, a quote or syntax.

/** Characters an instruction keeps. */
export const MAX_INSTRUCTION = 2000;
/** Lines of context sent before and after the target lines. */
export const CONTEXT_LINES = 5;
/** The most target lines one inline edit takes. */
export const MAX_LINES = 400;
/** The prompt goes as one argument: Windows caps a whole command line near 32K characters. */
export const MAX_PROMPT = 28000;
/** How long the command may run, in ms. */
export const TIMEOUT_MS = 120000;

/**
 * The default runner: Claude Code's headless mode, text out, nothing it can act with.
 * --tools "": no built-in tools (no Edit, Write, Bash, Read). --permission-mode dontAsk: anything
 * that would ask is denied. --strict-mcp-config without --mcp-config: no MCP servers (their tools,
 * their start-up time). --disable-slash-commands: no skills. --settings disableAllHooks: the user's
 * hooks don't fire for this call. --no-session-persistence: no transcript is kept.
 */
export const DEFAULT_COMMAND = 'claude -p --output-format text --tools "" --permission-mode dontAsk --strict-mcp-config --disable-slash-commands --no-session-persistence --settings {"disableAllHooks":true} {prompt}';

/** An instruction as typed: control characters dropped (a newline or tab becomes a space), trimmed, capped. */
export function cleanInstruction(s) {
  const t = String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F-\x9F]/g, "").trim();
  return t.length > MAX_INSTRUCTION ? t.slice(0, MAX_INSTRUCTION).trimEnd() : t;
}

const body = (l) => (l ?? "").replace(/\r?\n$/, "");

/** The text's lines with their terminators ("a\r\n", "b"); an empty text is one empty line. */
export function linesWithEol(text) {
  if (!text) return [""];
  const out = text.match(/[^\n]*\n|[^\n]+$/g);
  return out ?? [""];
}

/** The text's line ending: CRLF when its first terminated line uses it. */
export function eolOf(text) {
  const m = /\r?\n/.exec(text ?? "");
  return m ? m[0] : "\n";
}

/**
 * The target of an inline edit in `text`: lines a..b (0-based, inclusive), clamped to the file.
 * `old` keeps them as they are (without terminators), to tell later whether they changed.
 */
export function target(text, a, b) {
  const lines = linesWithEol(text), last = lines.length - 1;
  if (a > b) [a, b] = [b, a];
  a = Math.max(0, Math.min(a, last)); b = Math.max(a, Math.min(b, last));
  return { a, b, old: lines.slice(a, b + 1).map(body) };
}

/** Why a target can't be edited inline, or null. */
export function targetProblem(t) {
  const n = t.b - t.a + 1;
  if (n > MAX_LINES) return `Inline edit takes at most ${MAX_LINES} lines; ${n} are selected`;
  return null;
}

/**
 * Where the target's lines are in `text` now: at the same place, else the one place they occur
 * (lines added or removed above them meanwhile), else null (they changed, or they're no longer
 * a single place). Returns the target with a and b moved.
 */
export function relocate(text, t) {
  const lines = linesWithEol(text).map(body), n = t.old.length;
  const at = (i) => t.old.every((l, k) => lines[i + k] === l);
  if (t.a + n <= lines.length && at(t.a)) return { ...t };
  let found = -1;
  for (let i = 0; i + n <= lines.length; i++) {
    if (!at(i)) continue;
    if (found >= 0) return null; // twice: can't tell which
    found = i;
  }
  return found < 0 ? null : { ...t, a: found, b: found + n - 1 };
}

const fence = "~~~~~~~~";

/**
 * The prompt for one inline edit: where the lines are, a few lines around them, the lines
 * themselves, and the instruction. Each block sits between marker lines that code doesn't hold.
 */
export function buildPrompt({ path, language, text, a, b, instruction, context = CONTEXT_LINES }) {
  const lines = linesWithEol(text).map(body);
  const before = lines.slice(Math.max(0, a - context), a), after = lines.slice(b + 1, b + 1 + context);
  const block = (name, ls) => [`${fence} ${name} ${fence}`, ...ls, `${fence} end of ${name} ${fence}`];
  const span = a === b ? `line ${a + 1}` : `lines ${a + 1}-${b + 1}`;
  return [
    "You are an inline code editor. Rewrite the selected lines of a file as the instruction asks.",
    "",
    `File: ${path}`,
    `Language: ${language || "plain text"}`,
    `Selected: ${span} of ${lines.length}`,
    "",
    ...(before.length ? block("context before (do not repeat)", before) : [`(the selection starts the file)`]),
    ...block("selected lines", lines.slice(a, b + 1)),
    ...(after.length ? block("context after (do not repeat)", after) : [`(the selection ends the file)`]),
    "",
    `Instruction: ${instruction}`,
    "",
    "Reply with only the new text for the selected lines, exactly as it should appear in the file,",
    "keeping the file's indentation. No code fences, no explanation, no line numbers, no markers.",
    "Don't repeat the context lines.",
  ].join("\n");
}

/**
 * The command's output as replacement lines: CRLF read as LF, blank lines at either end dropped,
 * and one code fence around the whole answer removed. null when nothing is left.
 */
export function cleanAnswer(out) {
  let lines = String(out ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blank = (l) => !l.trim();
  const trim = () => { while (lines.length && blank(lines[0])) lines.shift(); while (lines.length && blank(lines[lines.length - 1])) lines.pop(); };
  trim();
  if (lines.length >= 2 && /^\s*(```|~~~)[\w.+#-]*\s*$/.test(lines[0]) && /^\s*(```|~~~)\s*$/.test(lines[lines.length - 1])) {
    lines = lines.slice(1, -1);
    trim();
  }
  lines = lines.map((l) => l.replace(/\s+$/, ""));
  return lines.length ? lines : null;
}

/**
 * `text` with lines a..b replaced by `answer` (lines without terminators; [] removes them). The
 * file's line ending is kept, and so is whether its last line ends with one.
 */
export function replaceLines(text, a, b, answer) {
  const lines = linesWithEol(text), eol = eolOf(text);
  const endTerm = lines[b].slice(body(lines[b]).length);
  const head = lines.slice(0, a).join(""), tail = lines.slice(b + 1).join("");
  if (!answer.length) {
    // Removing the file's last lines: the line before them keeps its terminator only if they had one.
    if (!tail && head && !endTerm) return head.replace(/\r?\n$/, "");
    return head + tail;
  }
  const mid = answer.map((l, i) => l + (i < answer.length - 1 ? eol : endTerm)).join("");
  return head + mid + tail;
}

/** A command template split into words: "quotes" keep spaces, "" is an empty argument. */
export function words(template) {
  return [...String(template ?? "").matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/**
 * The argv for a template: {prompt} becomes the prompt and {promptFile} the temp file's path, in
 * one pass over each template word (what's put in is never looked at again). A template naming
 * neither gets the prompt as its last argument.
 */
export function expand(template, { prompt, promptFile = null }) {
  const ws = words(template);
  if (!ws.length) throw new Error("Set the inline edit command in Settings");
  const uses = ws.some((w) => w.includes("{prompt}") || w.includes("{promptFile}"));
  const argv = ws.map((w) => w.replace(/\{prompt\}|\{promptFile\}/g, (m) => {
    if (m === "{prompt}") return prompt;
    if (promptFile == null) throw new Error("{promptFile} isn't available here");
    return promptFile;
  }));
  return uses ? argv : [...argv, prompt];
}

/** Whether a template sends the prompt through a temp file. */
export const usesFile = (template) => words(template).some((w) => w.includes("{promptFile}"));

// Where the command runs: toolpath.js plan, with toolrun.js toolWhere (shared with Format on save and Problems).

/** Where a command ran, for a message: toolrun.js toolWhere's `where` -> "Windows", "WSL", the machine, or null (this computer). */
export function whereLabel(where) {
  if (!where) return null;
  if (where.how === "native") return "Windows";
  if (where.how === "wsl") return "WSL";
  if (where.how === "remote") return where.on ?? null;
  return null;
}

/** A sign-in failure in a command's output (Claude Code's, or a similar tool's). */
const SIGNED_OUT = /failed to authenticate|oauth (session|token)[^\n]*(expired|invalid|revoked)|not logged in|please run \/login|invalid api key/i;

/**
 * A one-line message for a failed run ({ code, stdout, stderr } or a thrown error), or null when it
 * worked. `where` (whereLabel): where it ran, named when the tool isn't signed in there, since
 * Windows' claude.exe and WSL's claude have separate sign-ins.
 */
export function failure(r, { name = "claude", elapsed = 0, timeout = TIMEOUT_MS, where = null } = {}) {
  if (r && !(r instanceof Error) && !r.error && r.code !== 0 && SIGNED_OUT.test(`${r.stderr ?? ""}\n${r.stdout ?? ""}`))
    return `${name}${where ? ` (${where})` : ""} isn't signed in: run \`${name} auth login\`${where ? ` in ${where}` : ""}, then try again (${firstLine(r.stderr || r.stdout)})`;
  if (r instanceof Error || (r && r.error)) {
    const m = String(r.message ?? r.error ?? r);
    if (/time(d)? ?out/i.test(m) || elapsed >= timeout - 500) return `${name} timed out after ${Math.round(timeout / 1000)} s`;
    if (/not found|cannot find|no such file|cannot start/i.test(m)) return `${name} not found: install it, or change the inline edit command in Settings`;
    return `${name} failed: ${firstLine(m)}`;
  }
  if (elapsed >= timeout - 500 && r.code !== 0) return `${name} timed out after ${Math.round(timeout / 1000)} s`;
  if (r.code === 127) return `${name} not found: install it, or change the inline edit command in Settings`;
  if (r.code !== 0) return `${name} exited with ${r.code}${firstLine(r.stderr || r.stdout) ? `: ${firstLine(r.stderr || r.stdout)}` : ""}`;
  return null;
}

/** The last non-empty line of a text, capped: the useful end of an error. */
function firstLine(s) {
  const l = String(s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).filter((x) => !/^Warning:/i.test(x)).pop() ?? "";
  return l.length > 160 ? l.slice(0, 160) + "…" : l;
}
