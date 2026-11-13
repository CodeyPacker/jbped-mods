// Review comments as one prompt for an agent, and which agent gets it. Pure: no Herdr imports.
// The prompt is built by string concatenation from sanitized pieces (comments.js sanitize); the
// caller passes it to `hc send` as a single argument, never through a shell.
import { sanitize, snippetLine, MAX_BATCH } from "./comments.js";

/** `hc send` takes the prompt as one argument; Windows caps a whole command line near 32K characters. */
export const MAX_PROMPT = 30000;

/** Whether a terminal's argv runs in WSL (its paths are /mnt/<drive>/...). */
export const isWslArgv = (argv) => /(^|[\\/])wsl(\.exe)?$/i.test(argv?.[0] ?? "");

const slashes = (p) => String(p ?? "").replace(/\\/g, "/");

/** A path as an agent sees it: C:/x or C:\x becomes /mnt/c/x for an agent in WSL. */
export function agentView(path, wsl = false) {
  const p = slashes(path), m = /^([A-Za-z]):\/(.*)$/.exec(p);
  return wsl && m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : p;
}

/** A Windows drive path (C:/...) or a WSL view of one (/mnt/c/...): compared without case. */
const caseless = (p) => /^[A-Za-z]:\//.test(p) || /^\/mnt\/[a-z]\//i.test(p);

/** `path` relative to the folder `cwd` when it is inside it, else `path` (both as the agent sees them). */
export function relativeTo(path, cwd) {
  if (!cwd) return path;
  const dir = slashes(cwd).replace(/\/+$/, "");
  if (!dir) return path;
  const fold = caseless(path) && caseless(dir), a = fold ? path.toLowerCase() : path, b = fold ? dir.toLowerCase() : dir;
  return a.startsWith(b + "/") && path.length > dir.length + 1 ? path.slice(dir.length + 1) : path;
}

/** `path:12` or `path:12-15`, the path relative to the agent's folder when inside it. */
export function location(c, { cwd = null, wsl = false, target = null } = {}) {
  // The path the agent itself used for the file, when it is the agent that made the change.
  const p = c.as && c.by && c.by === target ? slashes(c.as) : agentView(c.path, wsl);
  const path = relativeTo(p, cwd ? agentView(cwd, wsl) : null);
  return `${sanitize(path).replace(/\n/g, "")}:${c.start === c.end ? c.start : `${c.start}-${c.end}`}`;
}

const repoLine = (r) => `repo: ${sanitize(r.name).replace(/\n/g, " ")}${r.branch ? `, branch: ${sanitize(r.branch).replace(/\n/g, " ")}` : ""}`;

/**
 * The prompt for `comments` (at most MAX_BATCH, in the order given, numbered from 1).
 * repos: Map of a comment's root -> { name, branch }; a root it lacks is named by its last folder.
 * One repo: its name and branch in the header line. Several: one header line per repo, its comments
 * under it (numbering carries on). Options as for location().
 */
export function buildPrompt(comments, { repos = new Map(), ...opts } = {}) {
  const list = comments.slice(0, MAX_BATCH), groups = new Map();
  for (const c of list) {
    const root = c.root ?? "";
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(c);
  }
  const info = (root) => repos.get(root) ?? { name: root ? slashes(root).split("/").filter(Boolean).pop() ?? root : "files", branch: null };
  const item = (c, n) => {
    const out = [`${n}. ${location(c, opts)}${c.kind === "rejected" ? " (a change of yours I rejected)" : ""}${c.stale ? " (the code here moved or changed since)" : ""}`];
    for (const s of (c.snippet ?? []).slice(0, 3)) out.push(`   > ${snippetLine(s)}`);
    const [first, ...rest] = sanitize(c.text).split("\n");
    out.push(`   Comment: ${first}`, ...rest.map((l) => `   ${l}`));
    return out.join("\n");
  };
  const parts = [];
  let n = 0;
  if (groups.size <= 1) {
    const [root] = groups.keys();
    parts.push(`Code review comments from Wingman (${repoLine(info(root ?? ""))}):`, "");
    for (const c of list) parts.push(item(c, ++n), "");
  } else {
    parts.push("Code review comments from Wingman:", "");
    for (const [root, cs] of groups) {
      parts.push(`${repoLine(info(root))}:`, "");
      for (const c of cs) parts.push(item(c, ++n), "");
    }
  }
  parts.push("Please address each comment. Reply with what you changed per item.");
  return sanitize(parts.join("\n"));
}

/**
 * Which agent gets the comments. agents: the space's agents ({ address, ... }); live: the addresses
 * of live terminals. The agent that made the commented changes when every comment names the same
 * live one; else the space's only agent; else the user picks among the space's agents.
 * Returns { address } | { pick: agents } | { error }.
 */
export function chooseTarget(comments, agents, live) {
  const by = new Set(comments.map((c) => c.by ?? null));
  const [one] = by;
  if (by.size === 1 && one && live.has(one)) return { address: one };
  if (agents.length === 1) return { address: agents[0].address };
  if (agents.length > 1) return { pick: agents };
  return { error: "No agent in this space to send to" };
}

/** Why the prompt can't be sent as it is, or null. */
export function promptProblem(prompt) {
  return prompt.length > MAX_PROMPT ? `The prompt is ${prompt.length} characters; at most ${MAX_PROMPT} can be sent at once. Delete some comments or shorten them.` : null;
}
