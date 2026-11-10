// The Provider contract (ADR 0001). Every Provider exports an object of this shape and only
// translates its service's data into the standard shapes below. Pure: no Herdr imports.
//
//   {
//     id: "github" | "azure",
//     capabilities: string[],                       // which of CAPABILITIES it supports
//     boards(account, io)  -> BoardRef[]            // what it can show, for discovery: { title, url, ref, teamDefault? }
//     board(account, ref, io) -> Board
//     ticket(account, ref, io) -> Ticket            // "ticket"
//     pullRequests(account, io) -> { mine, needsReview } // "pullRequests"
//     repos(account, io) -> string[]                // "repos": what can be followed, "owner/name" or "project/repo"
//     statuses(account, ref, io) -> string[]        // "statuses": a Board's states, for Tracked Statuses
//     signInState(account, io, needs) -> { ok: true } | { ok: false, reason, command } // "signInState"
//                  needs: { boards } (what the Profile uses the Account for, so scopes can be checked)
//                  command: the exact shell command that fixes it, or null when there's none to run
//   }
//
// `io` is what the flow hands a Provider: { run(cmd, args, opts), fetch(url, opts) }.
//
// Board        { title, url, me, columns: Column[], tickets: TicketSummary[] }
//   me         the Account's own user id on the Provider ("Mine" compares assignee ids with it)
// Column       { id, name }   id is the Provider's own (a Status option id, a state name)
// TicketSummary {
//   ref        opaque to the flow: whatever the Provider needs to fetch the Ticket again
//   key        stable id across refreshes
//   id         what people call it: "#12", "web#12", "4521"
//   title, type, url
//   columnId   the Column it's in (Column.id)
//   status     the Provider's state name (Azure State, GitHub Status), or null
//   assignees  [{ id, name }]
//   priority   string | null
// }
// Ticket       the detail panel's data (D11): a TicketSummary's fields, minus columnId, plus
//   column     the Column's name, or null
//   tags       string[]
//   parent     { id, title, url } | null
//   description         markdown ("" when none)
//   descriptionLabel    optional heading for it ("Description" by default; Azure Bugs say "Repro steps")
//   acceptanceCriteria  markdown | null (null when the Provider has no such field)
//   comments   [{ author, body (markdown), createdAt (ISO), url }], oldest first
//   moreComments  how many older comments weren't fetched
//   pullRequests  [{ id, title, url (null when unknown), state: "open" | "closed" | "merged" | null, draft }]
//
// PullRequests  pullRequests()'s answer (D6): { me, mine: PrSummary[], needsReview: PrSummary[], more: { mine, needsReview } }
//   mine       open and draft PRs the Account authored; needsReview: open PRs that ask it for a review
//   more       how many more matched than were fetched
// PrSummary    { key, id ("repo#12"), title, url, repo ("owner/name"), draft, author: { id, name }, updatedAt, createdAt? }
//   updatedAt  ISO, or null when the Provider has none (Azure): then createdAt (ISO) dates it

export const CAPABILITIES = ["boards", "board", "ticket", "pullRequests", "repos", "statuses", "signInState", "move", "update"];

export const NO_COLUMN = "__none__";

export function can(provider, capability) {
  return Boolean(provider?.capabilities?.includes(capability));
}

export function initials(name) {
  const parts = String(name ?? "").replace(/[^A-Za-z0-9 _.-]/g, "").split(/[\s_.-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function isMine(ticket, me) {
  return me != null && ticket.assignees.some((a) => a.id === me);
}

// Tickets grouped by Column, in Column order. Tickets whose Column isn't listed are dropped.
export function byColumn(board, { mine = false } = {}) {
  const groups = new Map(board.columns.map((c) => [c.id, []]));
  for (const t of board.tickets) {
    if (mine && !isMine(t, board.me)) continue;
    groups.get(t.columnId)?.push(t);
  }
  return board.columns.map((c) => ({ column: c, tickets: groups.get(c.id) }));
}

// An Account's PR repo filter (prRepos): "all" (the default), "selected" (only those) or "ignored" (all
// but those). Each mode keeps its own list, so switching modes loses nothing.
export const REPO_MODES = ["all", "selected", "ignored"];
export function repoFilter(account) {
  const f = account?.prRepos ?? {};
  const mode = REPO_MODES.includes(f.mode) ? f.mode : "all";
  return { mode, selected: f.selected ?? [], ignored: f.ignored ?? [] };
}
export function keepsRepo(account, repo) {
  const f = repoFilter(account);
  if (f.mode === "selected") return f.selected.includes(repo);
  if (f.mode === "ignored") return !f.ignored.includes(repo);
  return true;
}

// PRs grouped by repo, repos by name, each repo's PRs newest first.
export function byRepo(prs) {
  const groups = new Map();
  const when = (pr) => String(pr.updatedAt ?? pr.createdAt ?? "");
  for (const pr of [...prs].sort((a, b) => when(b).localeCompare(when(a)))) {
    if (!groups.has(pr.repo)) groups.set(pr.repo, []);
    groups.get(pr.repo).push(pr);
  }
  return [...groups].sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b)).map(([repo, list]) => ({ repo, prs: list }));
}

// The Board with one Column per Tracked Status (D21), in the given order. States match without regard
// to case. Tickets in other states drop out, so two states sharing one web-board column split in two.
export function trackColumns(board, statuses) {
  const columns = [], seen = new Set();
  for (const s of statuses ?? []) {
    const id = `status:${s.toLowerCase()}`;
    if (!seen.has(id)) { seen.add(id); columns.push({ id, name: s }); }
  }
  const tickets = [];
  for (const t of board.tickets) {
    const id = t.status == null ? null : `status:${String(t.status).toLowerCase()}`;
    if (seen.has(id)) tickets.push({ ...t, columnId: id });
  }
  return { ...board, columns, tickets };
}
