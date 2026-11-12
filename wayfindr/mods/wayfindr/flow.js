// The single Wayfindr flow (ADR 0001): picks the Provider for an Account and calls the contract.
// It never branches on which Provider it's talking to.
import { PROVIDERS } from "./providers/index.js";
import { can, keepsRepo, moveTarget } from "./providers/contract.js";
import { EXISTS_SH, LAUNCH_SH, REVIEW_SH, SCAN_SH, ORIGIN_SH, parseScript } from "./launch.js";
import { parseClones, remoteRepo } from "./clones.js";
import { identityOf, wranglrPattern, patternPath } from "./wranglr.js";

export function accountFor(profile, boardCfg) {
  return profile.accounts.find((a) => a.id === boardCfg.account) ?? null;
}

export function providerFor(account, registry = PROVIDERS) {
  return registry[account?.provider] ?? null;
}

function resolve(profile, boardCfg, registry) {
  const account = accountFor(profile, boardCfg);
  if (!account) throw new Error(`Board "${boardCfg.id}" names account "${boardCfg.account}", which isn't in this profile`);
  return { account, provider: providerFor(account, registry) };
}

// io: { run, fetch }. Resolves with a Board, or rejects with a message fit to show.
export async function loadBoard(profile, boardCfg, io, registry = PROVIDERS) {
  const { account, provider } = resolve(profile, boardCfg, registry);
  if (!can(provider, "board")) throw new Error(`Boards from ${account.provider} aren't supported yet`);
  return provider.board(account, boardCfg.ref, io);
}

// Every Account's sign-in state, by Account id. Accounts whose Provider can't tell are left out.
// One Account failing never stops the others (D19).
export async function signInStates(profile, io, registry = PROVIDERS) {
  const out = {};
  await Promise.all(profile.accounts.map(async (account) => {
    const provider = providerFor(account, registry);
    if (!can(provider, "signInState")) return;
    const needs = { boards: profile.boards.some((b) => b.account === account.id) };
    try { out[account.id] = await provider.signInState(account, io, needs); } catch (e) {
      out[account.id] = { ok: false, reason: String(e.message ?? e), command: null };
    }
  }));
  return out;
}

// Every Account's Pull Requests, in Profile order: [{ account (id), ...PullRequests } | { account, error }].
// Accounts whose Provider has none are left out, and one failing never stops the others. An Account with
// a repo filter (prRepos) shows only the PRs it keeps.
export async function loadPullRequests(profile, io, registry = PROVIDERS) {
  const accounts = profile.accounts.filter((a) => can(providerFor(a, registry), "pullRequests"));
  return Promise.all(accounts.map(async (account) => {
    try {
      const r = await providerFor(account, registry).pullRequests(account, io);
      const keep = (list) => list.filter((pr) => keepsRepo(account, pr.repo));
      return { account: account.id, ...r, mine: keep(r.mine), needsReview: keep(r.needsReview) };
    } catch (e) {
      return { account: account.id, error: String(e.message ?? e) };
    }
  }));
}

// The detail panel's Ticket for a TicketSummary on that Board.
export async function loadTicket(profile, boardCfg, summary, io, registry = PROVIDERS) {
  const { account, provider } = resolve(profile, boardCfg, registry);
  if (!can(provider, "ticket")) throw new Error(`Ticket details from ${account.provider} aren't supported yet`);
  return provider.ticket(account, summary.ref, io);
}

// Images in a Ticket's text (markdown ![alt](<url>)) and its attached images.
export const IMAGE_MD = /!\[((?:\\.|[^\]\\])*)\]\(<([^>]+)>\)/g;
export function ticketImages(ticket) {
  const texts = [ticket.description, ticket.acceptanceCriteria, ...(ticket.comments ?? []).map((c) => c.body)];
  const urls = texts.flatMap((s) => [...String(s ?? "").matchAll(IMAGE_MD)].map((m) => m[2]));
  return [...new Set([...urls, ...(ticket.images ?? []).map((i) => i.url)])];
}

// Downloads a Ticket's images into `dir`, `limit` at a time. Calls onImage(url, name | null, error)
// as each finishes, after onStart(url). URLs the Provider doesn't own are skipped: they show as links.
export async function loadImages(profile, boardCfg, ticket, dir, io, onImage, { limit = 4, onStart = () => {}, registry = PROVIDERS } = {}) {
  const { account, provider } = resolve(profile, boardCfg, registry);
  if (!can(provider, "images")) return;
  const queue = ticketImages(ticket).map((url) => [url, provider.imageName(account, url)]).filter(([, n]) => n);
  for (const [url] of queue) onStart(url);
  const worker = async () => {
    for (let job; (job = queue.shift());) {
      const [url, name] = job;
      try { await provider.downloadImage(account, url, `${dir}/${name}`, io); onImage(url, name, null); } catch (e) { onImage(url, null, String(e.message ?? e)); }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

// Settings discovery. Each rejects with a message fit to show.
export async function discoverBoards(account, io, registry = PROVIDERS) {
  const provider = providerFor(account, registry);
  if (!can(provider, "boards")) throw new Error(`Finding boards on ${account.provider} isn't supported yet`);
  return provider.boards(account, io);
}

export async function discoverRepos(account, io, registry = PROVIDERS) {
  const provider = providerFor(account, registry);
  if (!can(provider, "repos")) throw new Error(`Listing repos on ${account.provider} isn't supported yet`);
  return provider.repos(account, io);
}

export async function boardStatuses(profile, boardCfg, io, registry = PROVIDERS) {
  const { account, provider } = resolve(profile, boardCfg, registry);
  if (!can(provider, "statuses")) throw new Error(`Listing statuses on ${account.provider} isn't supported yet`);
  return provider.statuses(account, boardCfg.ref, io);
}

// A Profile rename: each Provider the Profile uses moves what it keeps under the old name.
export async function renameProfileData(profile, to, io, registry = PROVIDERS) {
  const providers = new Set(profile.accounts.map((a) => providerFor(a, registry)).filter((p) => typeof p?.renameProfile === "function"));
  for (const p of providers) await p.renameProfile(profile.name, to, io);
}

// Launch and Review worktrees (D18), through the Profile's runner. Each rejects with a message fit to show.

const script = async (io, text, name, args, timeout = 300000) => {
  const r = await io.run("sh", ["-c", text, name, ...args], { timeout });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`);
  return r.stdout;
};

const baseName = (p) => String(p ?? "").replace(/[\/\\]+$/, "").split(/[\/\\]/).pop();

// A Repo's Worktree Placement for the scripts. "wranglr" (the default) is Wranglr's rule for the Repo
// ("at:<host path with {branch}>"), or "herdr" when Wranglr isn't set up (wranglr null). The origin is read
// only when the rule can depend on it: a per-Repo pattern exists or the setting uses {repo}.
export async function placementFor(repo, wranglr, io) {
  const w = repo.worktrees || "wranglr";
  if (w !== "wranglr") return w;
  if (!wranglr) return "herdr";
  let url = "";
  if (Object.keys(wranglr.repos).length || wranglr.worktrees.includes("{repo}")) {
    try { url = (await cloneOrigin(repo.path, io)).url; } catch { url = ""; }
  }
  const identity = url ? identityOf(url, repo.path) : null;
  const name = identity ? identity.split("/").pop() : baseName(repo.path);
  return "at:" + patternPath(wranglrPattern(wranglr, identity), repo.path, name);
}
const triples = async (repos, wranglr, io) => {
  const placed = await Promise.all(repos.map((r) => placementFor(r, wranglr, io)));
  return repos.flatMap((r, i) => [r.path, r.name, placed[i]]);
};

// repos: [{ path, name, worktrees }], worktrees the Repo's Worktree Placement ("wranglr", "herdr", "beside"
// or a host folder; "wranglr" when absent). wranglr: parseWranglr's result, or null when Wranglr isn't set
// up. Returns { folder, names }: the folder name a Launch would use (an earlier Launch's, found by prefix at
// each Repo's place, else `folder`) and the repo names whose worktree exists at its place for it.
export async function existingWorktrees(prefix, folder, repos, io, wranglr = null) {
  const lines = (await script(io, EXISTS_SH, "wayfindr-exists", [prefix, folder, ...(await triples(repos, wranglr, io))], 30000)).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const first = /^folder (.+)$/.exec(lines[0] ?? "");
  return { folder: first ? first[1] : folder, names: lines.filter((l) => !l.startsWith("folder ")) };
}

// repos, wranglr: as for existingWorktrees. Reuses an earlier Launch's folder name (by prefix), else
// `folder`; the branch is that name. Each worktree goes at its Repo's place. Returns { space, path, branch,
// made, reused, notes, worktrees }, worktrees: { [name]: local path }.
export async function makeLaunchWorktrees(prefix, folder, repos, io, wranglr = null) {
  return parseScript(await script(io, LAUNCH_SH, "wayfindr-launch", [prefix, folder, ...(await triples(repos, wranglr, io))]));
}

// repo: { path, name, worktrees }. checkout: the Repo's Checkout mode, "worktree" (a detached worktree at
// the Repo's place for `folder`) or "branch" (the branch in the clone itself; the placement is ignored).
// wranglr: as for existingWorktrees. Returns { space, path, branch, made, reused, notes, worktrees }.
export async function makeReviewWorktree(folder, repo, branch, io, checkout = "worktree", wranglr = null) {
  const placement = await placementFor(repo, wranglr, io);
  return parseScript(await script(io, REVIEW_SH, "wayfindr-review", [folder, repo.path, repo.name, branch, checkout, placement]));
}

// The git clones on this machine: home and each of `roots` (host folders, from scanRoots), four levels
// deep. Returns [{ path, url, repo, kind }], kind "clone" or "worktree" (a linked worktree).
export async function listClones(roots, io) {
  return parseClones(await script(io, SCAN_SH, "wayfindr-scan", roots, 120000));
}

// A picked folder's origin: { url, repo }, url "" when it has none. Rejects when it isn't a git repository.
export async function cloneOrigin(folder, io) {
  const line = (await script(io, ORIGIN_SH, "wayfindr-origin", [folder], 30000)).split(/\r?\n/).find((l) => /^url( |$)/.test(l)) ?? "";
  const url = line.slice(4).trim();
  return { url, repo: remoteRepo(url) };
}

// What a Review needs from the Provider: the branch, its description and linked Tickets' criteria (D16).
export async function loadReviewInfo(profile, accountId, pr, io, registry = PROVIDERS) {
  const account = profile.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`No account "${accountId}" in this profile`);
  const provider = providerFor(account, registry);
  if (!can(provider, "review")) throw new Error(`Reviews on ${account.provider} aren't supported yet`);
  return provider.review(account, pr, io);
}

// One Pull Request's detail (#1): description, reviewers, comments and files with their diffs.
export async function loadPullRequestDetail(profile, accountId, pr, io, registry = PROVIDERS) {
  const account = profile.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`No account "${accountId}" in this profile`);
  const provider = providerFor(account, registry);
  if (!can(provider, "prDetail")) throw new Error(`Pull Request detail on ${account.provider} isn't supported yet`);
  return provider.pullRequest(account, pr, io);
}

// Moves a Ticket to a Column on its Board (#15). columnId: a Column of the Board as shown.
export async function moveTicket(profile, boardCfg, data, ticket, columnId, io, registry = PROVIDERS) {
  const { account, provider } = resolve(profile, boardCfg, registry);
  if (!can(provider, "move")) throw new Error(`Moving cards on ${account.provider} isn't supported yet`);
  return provider.move(account, ticket.ref, moveTarget(data, boardCfg, columnId), ticket, io);
}

// Edits a Ticket's title, or posts a comment on it (#16).
export async function updateTicket(profile, boardCfg, ticket, fields, io, registry = PROVIDERS) {
  const { account, provider } = resolve(profile, boardCfg, registry);
  if (!can(provider, "update")) throw new Error(`Editing cards on ${account.provider} isn't supported yet`);
  return provider.update(account, ticket.ref, fields, io);
}

export async function commentOnTicket(profile, boardCfg, ticket, text, io, registry = PROVIDERS) {
  const { account, provider } = resolve(profile, boardCfg, registry);
  if (!can(provider, "update")) throw new Error(`Comments on ${account.provider} aren't supported yet`);
  return provider.comment(account, ticket.ref, text, io);
}

// Deletes images saved over 30 days ago (`days`; their files' time is when they were saved). Only image
// files directly in that folder. A Windows path is converted for a WSL runner.
export const PRUNE_SH = 'd="$1"; case "$d" in [A-Za-z]:*) d=$(wslpath -u "$d") || exit 0;; esac; [ -d "$d" ] || exit 0; find "$d" -maxdepth 1 -type f \\( -name "*.png" -o -name "*.jpg" -o -name "*.jpeg" -o -name "*.gif" -o -name "*.webp" -o -name "*.bmp" -o -name "*.part" \\) -mtime +"$2" -delete';
export async function pruneImages(dir, io, days = 30) {
  await io.run("sh", ["-c", PRUNE_SH, "wayfindr-prune", dir, String(days)], { timeout: 30000 });
}
