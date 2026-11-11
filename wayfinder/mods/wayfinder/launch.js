// Launch (#13) and Review (#14): templates, worktree paths, prompts and the scripts that make the
// worktrees. Pure: no Herdr imports. Scripts are fixed text: every value is an argv entry (ADR 0002).
import { invocation } from "./command.js";

export const DEFAULT_LAUNCH = {
  agent: "claude",
  prompt: "Orchestrate this Ticket. Read it, plan the work across the repos below, and carry it out in their worktrees.",
};
export const DEFAULT_REVIEW = {
  agent: "claude",
  prompt: "Review this Pull Request. Check it against the acceptance criteria, then for security issues, then for code quality. Report your findings here. Don't post anything to the Pull Request.",
};

const AGENT = /^[A-Za-z0-9._-]+$/;

// A template: { agent, model?, args?, prompt? }. Later layers override earlier ones, field by field.
export function resolveTemplate(base, ...layers) {
  const out = { ...base };
  for (const l of layers) {
    if (!l || typeof l !== "object") continue;
    for (const k of ["agent", "model", "args", "prompt"]) if (l[k] != null) out[k] = l[k];
  }
  return out;
}

// Problems with a template's fields, for parseConfig.
export function templateErrors(t, where) {
  if (t == null) return [];
  if (typeof t !== "object" || Array.isArray(t)) return [`${where}: must be an object`];
  const e = [];
  if (t.agent != null && !(typeof t.agent === "string" && AGENT.test(t.agent))) e.push(`${where}.agent: a program name, e.g. "claude"`);
  if (t.model != null && !(typeof t.model === "string" && /^[A-Za-z0-9._:\[\]-]+$/.test(t.model))) e.push(`${where}.model: a model name, e.g. "opus"`);
  if (t.args != null && !(Array.isArray(t.args) && t.args.every((a) => typeof a === "string"))) e.push(`${where}.args: a list of strings`);
  if (t.prompt != null && typeof t.prompt !== "string") e.push(`${where}.prompt: text`);
  return e;
}

// The agent's argv: the program, --model, then any extra args.
export function agentArgv(t) {
  if (!AGENT.test(String(t.agent ?? ""))) throw new Error(`"${t.agent}" isn't a program name`);
  return [t.agent, ...(t.model ? ["--model", t.model] : []), ...(t.args ?? [])];
}

export function slug(title, max = 40) {
  return String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "ticket";
}

const safeSeg = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "x";

// Folder and branch names (D18), relative to ~/.herdr/worktrees.
export const ticketFolder = (ticket) => `${safeSeg(ticket.id)}-${slug(ticket.title)}`;
export const reviewFolder = (pr) => `review-${safeSeg(pr.id)}`;
export const repoName = (r) => safeSeg(r.id);

// The Ticket as the agent's opening message.
export function launchPrompt(ticket, repos, template) {
  const lines = [template.prompt ?? DEFAULT_LAUNCH.prompt, ""];
  lines.push(`Ticket: ${ticket.id} ${ticket.title}`);
  if (ticket.type) lines.push(`Type: ${ticket.type}`);
  if (ticket.url) lines.push(`URL: ${ticket.url}`);
  lines.push("", "## Description", ticket.description?.trim() || "None.");
  if (ticket.acceptanceCriteria != null) lines.push("", "## Acceptance criteria", ticket.acceptanceCriteria.trim() || "None.");
  lines.push("", "## Repos");
  if (!repos.length) lines.push("None selected. Work in this folder.");
  for (const r of repos) lines.push(`- ${r.id}: ${r.worktree} (branch ${r.branch})`);
  return lines.join("\n");
}

// criteria: [{ id, title, text }] from linked Tickets. None: the PR description stands in (D16).
export function reviewPrompt(pr, info, worktree, template) {
  const lines = [template.prompt ?? DEFAULT_REVIEW.prompt, ""];
  lines.push(`Pull Request: ${pr.id} ${pr.title}`, `Repo: ${pr.repo}`, `Branch: ${info.branch}${info.target ? ` into ${info.target}` : ""}`);
  if (pr.url) lines.push(`URL: ${pr.url}`);
  lines.push(`Worktree: ${worktree}`, "", "## Acceptance criteria");
  const withText = (info.criteria ?? []).filter((c) => c.text?.trim());
  if (withText.length) for (const c of withText) lines.push(`### ${c.id} ${c.title ?? ""}`.trim(), c.text.trim(), "");
  else if (info.description?.trim()) lines.push("No linked Ticket has acceptance criteria. Use the Pull Request description:", "", info.description.trim());
  else lines.push("None: no linked Ticket has acceptance criteria and the Pull Request has no description.");
  return lines.join("\n");
}

// Converts a Windows path (from pickFolder, or Herdr's home) for a WSL runner. Shared by the scripts.
const TO_LOCAL = 'loc() { case "$1" in [A-Za-z]:*) wslpath -u "$1";; *) printf %s "$1";; esac; }';
// Prints the folder for space.new: the Windows form under WSL, else the path itself.
const TO_SPACE = 'out() { if command -v wslpath >/dev/null 2>&1; then wslpath -w "$1"; else printf %s "$1"; fi; }';

// Which worktrees exist already. argv: folder (relative), then repo names. Prints one name per line.
export const EXISTS_SH = 'd="$HOME/.herdr/worktrees/$1"; shift; for r in "$@"; do [ -e "$d/$r/.git" ] && echo "$r"; done; exit 0';

// Makes a Ticket's worktrees (D18). argv: folder, branch, then pairs of repo path and name. A worktree that
// exists is reused. Prints "space <folder>" for space.new, and "made <name>" or "reused <name>" per repo.
export const LAUNCH_SH = `${TO_LOCAL}; ${TO_SPACE}
d="$HOME/.herdr/worktrees/$1"; b="$2"; shift 2; mkdir -p "$d" || exit 1
while [ $# -ge 2 ]; do
  repo=$(loc "$1"); name="$2"; shift 2; dest="$d/$name"
  if [ -e "$dest/.git" ]; then echo "reused $name"; continue; fi
  git -C "$repo" fetch --quiet origin || { echo "git fetch failed in $repo" >&2; exit 1; }
  def=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || def=origin/main
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$b"; then git -C "$repo" worktree add --quiet "$dest" "$b" || exit 1
  else git -C "$repo" worktree add --quiet -b "$b" "$dest" "$def" || exit 1; fi
  echo "made $name"
done
echo "space $(out "$d")"; echo "path $d"`;

// Makes a Review worktree on the PR branch, detached so no local branch is touched (D15, D18).
// argv: folder, repo path, repo name, branch. A worktree that exists is moved to the branch's newest commit.
export const REVIEW_SH = `${TO_LOCAL}; ${TO_SPACE}
d="$HOME/.herdr/worktrees/$1"; repo=$(loc "$2"); name="$3"; b="$4"; dest="$d/$name"
git -C "$repo" fetch --quiet origin "+refs/heads/$b:refs/remotes/origin/$b" || { echo "git fetch of $b failed in $repo" >&2; exit 1; }
if [ -e "$dest/.git" ]; then git -C "$dest" checkout --quiet --detach "origin/$b" || exit 1; echo "reused $name"
else mkdir -p "$d" && git -C "$repo" worktree add --quiet --detach "$dest" "origin/$b" || exit 1; echo "made $name"; fi
echo "space $(out "$dest")"; echo "path $dest"`;

// The space's agent: started by the runner in the folder, through a login shell so the user's PATH
// applies. The folder and agent args are argv, never shell text.
export function spaceArgv(runner, platform, folder, argv) {
  const inv = invocation(runner, platform, "bash", ["-lc", 'cd "$0" && exec "$@"', folder, ...argv]);
  return [inv.command, ...inv.args];
}

// "space <x>", "path <y>", "made <r>", "reused <r>" lines from the scripts.
export function parseScript(stdout) {
  const out = { space: null, path: null, made: [], reused: [] };
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^(space|path|made|reused) (.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "space" || m[1] === "path") out[m[1]] = m[2];
    else out[m[1]].push(m[2]);
  }
  return out;
}

// The space's name: kept so a second Launch finds it (D18).
export const launchSpaceName = (ticket) => `${ticket.id} ${String(ticket.title ?? "").slice(0, 40)}`.trim();
export const reviewSpaceName = (pr) => `Review ${pr.id}`;
