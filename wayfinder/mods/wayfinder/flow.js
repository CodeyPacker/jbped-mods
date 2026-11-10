// The single Wayfinder flow (ADR 0001): picks the Provider for an Account and calls the contract.
// It never branches on which Provider it's talking to.
import { PROVIDERS } from "./providers/index.js";
import { can, keepsRepo } from "./providers/contract.js";

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
