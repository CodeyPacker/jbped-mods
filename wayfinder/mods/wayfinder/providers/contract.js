// The Provider contract (ADR 0001). Every Provider exports an object of this shape and only
// translates its service's data into the standard shapes below. Pure: no Herdr imports.
//
//   {
//     id: "github" | "azure",
//     capabilities: string[],                       // which of CAPABILITIES it supports
//     boards(account, io)  -> BoardRef[]            // what it can show, for discovery
//     board(account, ref, io) -> Board
//     ticket(account, ref, io) -> Ticket            // "ticket"
//     pullRequests(account, io) -> { mine, needsReview } // "pullRequests"
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
//   assignees  [{ id, name }]
//   priority   string | null
// }
// Ticket       the detail panel's data (D11): a TicketSummary's fields, minus columnId, plus
//   column     the Column's name, or null
//   tags       string[]
//   parent     { id, title, url } | null
//   description         markdown ("" when none)
//   acceptanceCriteria  markdown | null (null when the Provider has no such field)
//   comments   [{ author, body (markdown), createdAt (ISO), url }], oldest first
//   moreComments  how many older comments weren't fetched
//   pullRequests  [{ id, title, url, state: "open" | "closed" | "merged", draft }]

export const CAPABILITIES = ["boards", "board", "ticket", "pullRequests", "signInState", "move", "update"];

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
