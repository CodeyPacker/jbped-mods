// The single Wayfinder flow (ADR 0001): picks the Provider for an Account and calls the contract.
// It never branches on which Provider it's talking to.
import { PROVIDERS } from "./providers/index.js";
import { can } from "./providers/contract.js";

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
// Accounts whose Provider has none are left out, and one failing never stops the others.
export async function loadPullRequests(profile, io, registry = PROVIDERS) {
  const accounts = profile.accounts.filter((a) => can(providerFor(a, registry), "pullRequests"));
  return Promise.all(accounts.map(async (account) => {
    try { return { account: account.id, ...(await providerFor(account, registry).pullRequests(account, io)) }; } catch (e) {
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
