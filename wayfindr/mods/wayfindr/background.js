// Background checks (#1). Pure: which Pull Requests newly ask for the user's review and which Tickets
// were newly assigned to the user, between two loads, and the toasts for them.
import { isMine } from "./providers/contract.js";

const ok = (list) => new Map((list ?? []).filter((a) => a && !a.error).map((a) => [a.account, a]));
const keys = (a) => new Set([...(a?.needsReview ?? []), ...(a?.mine ?? [])].map((pr) => pr.key));

// prevPrs/nextPrs: loadPullRequests() answers, prevPrs null when there is no baseline.
// prevBoards/nextBoards: { [boardId]: BoardData | null }.
export function newItems({ prevPrs, nextPrs, prevBoards, nextBoards }) {
  const reviews = [];
  if (prevPrs != null) {
    const before = ok(prevPrs), errored = new Set(prevPrs.filter((a) => a?.error).map((a) => a.account));
    for (const a of nextPrs ?? []) {
      // An Account that wasn't there before has no baseline: adding one must not announce every PR.
      if (!a || a.error || errored.has(a.account) || !before.has(a.account)) continue;
      const seen = keys(before.get(a.account));
      for (const pr of a.needsReview ?? []) if (!seen.has(pr.key)) reviews.push({ account: a.account, pr });
    }
  }

  const assigned = [];
  for (const [boardId, next] of Object.entries(nextBoards ?? {})) {
    const prev = prevBoards?.[boardId];
    if (!next || !prev) continue;
    const mineBefore = new Set(prev.tickets.filter((t) => isMine(t, prev.me)).map((t) => t.key));
    for (const ticket of next.tickets) {
      if (isMine(ticket, next.me) && !mineBefore.has(ticket.key)) assigned.push({ boardId, ticket });
    }
  }
  return { reviews, assigned };
}

export function oneLine(text, max = 80) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// [{ title, body, view, boardId }]: up to maxEach of each kind, then one toast counting the rest.
export function toastsFor(items, { maxEach = 5 } = {}) {
  const out = [];
  const reviews = items?.reviews ?? [], assigned = items?.assigned ?? [];
  for (const { pr } of reviews.slice(0, maxEach)) {
    out.push({ title: "Review requested", body: `${pr.repo} ${pr.id}: ${oneLine(pr.title)}`, view: "prs", boardId: null });
  }
  if (reviews.length > maxEach) {
    out.push({ title: "Review requested", body: `${reviews.length - maxEach} more Pull Requests ask for your review`, view: "prs", boardId: null });
  }
  for (const { boardId, ticket } of assigned.slice(0, maxEach)) {
    out.push({ title: "Assigned to you", body: `${ticket.id} ${oneLine(ticket.title)}`, view: "board", boardId });
  }
  if (assigned.length > maxEach) {
    const rest = assigned.slice(maxEach), boards = new Set(rest.map((x) => x.boardId));
    out.push({ title: "Assigned to you", body: `${rest.length} more Tickets were assigned to you`, view: "board", boardId: boards.size === 1 ? rest[0].boardId : null });
  }
  return out;
}
