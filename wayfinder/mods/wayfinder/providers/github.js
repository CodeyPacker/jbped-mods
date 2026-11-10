// GitHub Provider: GitHub Projects (v2) boards. Translation only (ADR 0001).
// Auth: `gh auth token --user <login>` through the Profile's runner, then GraphQL over fetch, so
// the token never appears on a command line and `gh auth switch` is never used (ADR 0002).
import { NO_COLUMN } from "./contract.js";

const API = "https://api.github.com/graphql";
const PAGE = 100, MAX_PAGES = 20;

const ITEM_FIELDS = `
  id type isArchived
  status: fieldValueByName(name: $status) { ... on ProjectV2ItemFieldSingleSelectValue { optionId name } }
  priority: fieldValueByName(name: $priority) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  content {
    __typename
    ... on Issue { id number title url repository { name nameWithOwner } assignees(first: 10) { nodes { login name } } }
    ... on PullRequest { id number title url repository { name nameWithOwner } assignees(first: 10) { nodes { login name } } }
    ... on DraftIssue { id title assignees(first: 10) { nodes { login name } } }
  }`;

const PROJECT = `
  title url
  field(name: $status) { ... on ProjectV2SingleSelectField { id name options { id name } } }
  items(first: ${PAGE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${ITEM_FIELDS} } }`;

export const BOARD_QUERY = `query($owner: String!, $number: Int!, $status: String!, $priority: String!, $after: String) {
  viewer { login }
  repositoryOwner(login: $owner) {
    ... on User { projectV2(number: $number) { ${PROJECT} } }
    ... on Organization { projectV2(number: $number) { ${PROJECT} } }
  }
}`;

export const BOARDS_QUERY = `query {
  viewer {
    login
    projectsV2(first: 50) { nodes { number title url closed owner { ... on User { login } ... on Organization { login } } } }
    organizations(first: 50) { nodes { login projectsV2(first: 50) { nodes { number title url closed } } } }
  }
}`;

const PR_FIELDS = `number title url state isDraft repository { name }`;
const COMMENTS = `comments(last: 100) { totalCount nodes { author { login } body createdAt url } }`;
const COMMON = `number title url body repository { name }
  labels(first: 30) { nodes { name } } assignees(first: 10) { nodes { login name } } ${COMMENTS}`;

export const TICKET_QUERY = `query($item: ID!, $content: ID!, $status: String!, $priority: String!) {
  item: node(id: $item) { ... on ProjectV2Item {
    status: fieldValueByName(name: $status) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    priority: fieldValueByName(name: $priority) { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
  content: node(id: $content) {
    __typename
    ... on Issue { ${COMMON} issueType { name } parent { number title url repository { name } }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
      timelineItems(first: 50, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT]) { nodes { __typename
        ... on ConnectedEvent { subject { ... on PullRequest { ${PR_FIELDS} } } }
        ... on CrossReferencedEvent { source { ... on PullRequest { ${PR_FIELDS} } } } } } }
    ... on PullRequest { ${COMMON} }
    ... on DraftIssue { title body assignees(first: 10) { nodes { login name } } }
  }
}`;

// GitHub user names: letters, digits and single hyphens. Checked before one goes into a shell command.
const GH_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_LOGIN_CMD = "gh auth login -h github.com";
const GH_REFRESH_CMD = "gh auth refresh -s read:project -h github.com";

// `gh auth status -h github.com` (no token in it, only a masked one) into login -> { login, ok, active, scopes }.
// Keys are lower-cased: GitHub logins ignore case. scopes is null when gh doesn't list them. Pure.
export function parseGhStatus(text) {
  const accounts = new Map();
  let cur = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    let m;
    if ((m = /(Logged in to|Failed to log in to) github\.com account (\S+)/.exec(line))) {
      cur = { login: m[2], ok: m[1] === "Logged in to", active: false, scopes: null };
      accounts.set(cur.login.toLowerCase(), cur);
    } else if (cur && (m = /Active account: (true|false)/.exec(line))) cur.active = m[1] === "true";
    else if (cur && (m = /Token scopes: (.*)$/.exec(line))) cur.scopes = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return accounts;
}

// The sign-in state from parsed gh status. gh refreshes only the active account, so an inactive one
// is switched to and back around the refresh. Pure.
export function ghSignInState(login, accounts, { boards = false } = {}) {
  const me = accounts.get(String(login).toLowerCase());
  if (!me) return { ok: false, reason: `${login} isn't signed in to gh`, command: GH_LOGIN_CMD };
  if (!me.ok) return { ok: false, reason: `gh's login for ${login} is expired or revoked`, command: GH_LOGIN_CMD };
  if (boards && me.scopes && !me.scopes.some((s) => s === "read:project" || s === "project")) {
    const active = [...accounts.values()].find((a) => a.active);
    const back = active && GH_LOGIN.test(active.login) ? ` && gh auth switch -h github.com -u ${active.login}` : "";
    const command = me.active ? GH_REFRESH_CMD : `gh auth switch -h github.com -u ${login} && ${GH_REFRESH_CMD}${back}`;
    return { ok: false, reason: `${login} lacks the read:project scope Boards need`, command };
  }
  return { ok: true };
}

const TYPE = { Issue: "Issue", PullRequest: "Pull request", DraftIssue: "Draft" };

// One project page's items into TicketSummaries. Pure.
export function mapItems(nodes) {
  const out = [];
  for (const n of nodes ?? []) {
    if (!n || n.isArchived || !n.content) continue;
    const c = n.content;
    const repo = c.repository?.name;
    out.push({
      ref: { itemId: n.id, contentId: c.id, kind: c.__typename, url: c.url ?? null },
      key: n.id,
      id: c.number != null ? `${repo ? `${repo}` : ""}#${c.number}` : "Draft",
      title: c.title ?? "",
      type: TYPE[c.__typename] ?? c.__typename,
      url: c.url ?? null,
      columnId: n.status?.optionId ?? NO_COLUMN,
      status: n.status?.name ?? null,
      assignees: people(c),
      priority: n.priority?.name ?? null,
    });
  }
  return out;
}

// The Status field's options become Columns, in their order. "No Status" leads when any item lacks one,
// as on github.com. Pure.
export function mapColumns(field, tickets) {
  const columns = (field?.options ?? []).map((o) => ({ id: o.id, name: o.name }));
  if (tickets.some((t) => t.columnId === NO_COLUMN)) columns.unshift({ id: NO_COLUMN, name: "No Status" });
  return columns;
}

const people = (c) => (c?.assignees?.nodes ?? []).map((a) => ({ id: a.login, name: a.name || a.login }));
const numbered = (x) => `${x.repository?.name ?? ""}#${x.number}`;

// Linked Pull Requests: closing references first, then ones the timeline connects or mentions. Pure.
export function linkedPullRequests(c) {
  const seen = new Set(), out = [];
  const add = (pr) => {
    if (!pr?.url || seen.has(pr.url)) return;
    seen.add(pr.url);
    out.push({ id: numbered(pr), title: pr.title, url: pr.url, state: String(pr.state).toLowerCase(), draft: Boolean(pr.isDraft) });
  };
  for (const pr of c?.closedByPullRequestsReferences?.nodes ?? []) add(pr);
  for (const ev of c?.timelineItems?.nodes ?? []) add(ev.subject ?? ev.source);
  return out;
}

// The ticket query's answer into a Ticket. Pure.
export function mapTicket(data, ref) {
  const c = data?.content;
  if (!c) throw new Error("This item is gone, or the account can't see it");
  const kind = c.__typename;
  const comments = c.comments?.nodes ?? [];
  return {
    ref, key: ref.itemId,
    id: c.number != null ? numbered(c) : "Draft",
    title: c.title ?? "",
    type: c.issueType?.name ?? TYPE[kind] ?? kind,
    url: c.url ?? null,
    column: data.item?.status?.name ?? null,
    assignees: people(c),
    tags: (c.labels?.nodes ?? []).map((l) => l.name),
    priority: data.item?.priority?.name ?? null,
    parent: c.parent ? { id: numbered(c.parent), title: c.parent.title, url: c.parent.url } : null,
    description: c.body ?? "",
    acceptanceCriteria: null,
    comments: comments.map((m) => ({ author: m.author?.login ?? "ghost", body: m.body ?? "", createdAt: m.createdAt, url: m.url })),
    moreComments: Math.max(0, (c.comments?.totalCount ?? 0) - comments.length),
    pullRequests: kind === "Issue" ? linkedPullRequests(c) : [],
  };
}

// Both PR sections in one request: search allows 30 requests a minute.
const PR_LIST_FIELDS = `... on PullRequest { id number title url isDraft updatedAt author { login ... on User { name } } repository { nameWithOwner } }`;
export const PRS_QUERY = `query($mine: String!, $review: String!) {
  viewer { login }
  mine: search(type: ISSUE, query: $mine, first: ${PAGE}) { issueCount nodes { ${PR_LIST_FIELDS} } }
  review: search(type: ISSUE, query: $review, first: ${PAGE}) { issueCount nodes { ${PR_LIST_FIELDS} } }
}`;

export const prSearches = (login) => ({
  mine: `is:pr is:open archived:false author:${login} sort:updated-desc`,
  review: `is:pr is:open archived:false review-requested:${login} sort:updated-desc`,
});

export function mapPrs(nodes) {
  return (nodes ?? []).filter((n) => n?.number != null && n.repository).map((n) => ({
    key: n.id, id: `${n.repository.nameWithOwner.split("/")[1]}#${n.number}`, title: n.title ?? "", url: n.url ?? null,
    repo: n.repository.nameWithOwner, draft: Boolean(n.isDraft),
    author: { id: n.author?.login ?? "ghost", name: n.author?.name || n.author?.login || "ghost" },
    updatedAt: n.updatedAt ?? null,
  }));
}

export function projectOf(data) {
  return data?.repositoryOwner?.projectV2 ?? null;
}

async function token(account, io) {
  const r = await io.run("gh", ["auth", "token", "--user", account.login, "--hostname", "github.com"], { timeout: 20000 });
  const t = r.stdout.trim();
  if (r.code !== 0 || !t) throw new Error(`gh has no token for ${account.login}. Run: gh auth login`);
  return t;
}

async function graphql(account, io, query, variables) {
  const t = await token(account, io);
  const res = await io.fetch(API, {
    method: "POST",
    headers: { Authorization: `bearer ${t}`, "Content-Type": "application/json", "User-Agent": "herdr-wayfinder" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`GitHub answered ${res.status}: ${text.slice(0, 200)}`); }
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join("; ");
    if (/read:project|INSUFFICIENT_SCOPES/i.test(msg + JSON.stringify(body.errors))) {
      throw new Error(`${account.login} needs the read:project scope. Run: gh auth refresh -h github.com -s read:project`);
    }
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return body.data;
}

export const github = {
  id: "github",
  capabilities: ["boards", "board", "ticket", "pullRequests", "signInState"],

  async signInState(account, io, needs = {}) {
    if (!GH_LOGIN.test(String(account.login))) return { ok: false, reason: `"${account.login}" isn't a GitHub user name`, command: null };
    const r = await io.run("gh", ["auth", "status", "-h", "github.com"], { timeout: 30000 });
    if (r.code === 127) return { ok: false, reason: `gh isn't reachable through the runner: ${(r.stderr || r.stdout).trim().split("\n")[0]}`, command: null };
    return ghSignInState(account.login, parseGhStatus(`${r.stdout}\n${r.stderr}`), needs);
  },

  async boards(account, io) {
    const d = await graphql(account, io, BOARDS_QUERY, {});
    const own = d.viewer.projectsV2.nodes.map((p) => ({ ...p, owner: p.owner?.login ?? d.viewer.login }));
    const orgs = d.viewer.organizations.nodes.flatMap((o) => o.projectsV2.nodes.map((p) => ({ ...p, owner: o.login })));
    return [...own, ...orgs].filter((p) => !p.closed)
      .map((p) => ({ title: p.title, url: p.url, ref: { owner: p.owner, number: p.number } }));
  },

  async board(account, ref, io) {
    const vars = { owner: ref.owner, number: ref.number, status: ref.statusField ?? "Status", priority: ref.priorityField ?? "Priority", after: null };
    let me = null, project = null, nodes = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await graphql(account, io, BOARD_QUERY, vars);
      me = d.viewer.login;
      const p = projectOf(d);
      if (!p) throw new Error(`No project ${ref.owner}/${ref.number}, or ${account.login} can't see it`);
      project ??= p;
      nodes = nodes.concat(p.items.nodes);
      if (!p.items.pageInfo.hasNextPage) break;
      vars.after = p.items.pageInfo.endCursor;
    }
    if (!project.field) throw new Error(`Project "${project.title}" has no single-select field named "${vars.status}"`);
    const tickets = mapItems(nodes);
    for (const t of tickets) Object.assign(t.ref, { statusField: vars.status, priorityField: vars.priority });
    return { title: project.title, url: project.url, me, columns: mapColumns(project.field, tickets), tickets };
  },

  async pullRequests(account, io) {
    if (!GH_LOGIN.test(String(account.login))) throw new Error(`"${account.login}" isn't a GitHub user name`);
    const d = await graphql(account, io, PRS_QUERY, prSearches(account.login));
    const mine = mapPrs(d.mine?.nodes), needsReview = mapPrs(d.review?.nodes);
    return {
      me: d.viewer.login, mine, needsReview,
      more: { mine: Math.max(0, (d.mine?.issueCount ?? 0) - mine.length), needsReview: Math.max(0, (d.review?.issueCount ?? 0) - needsReview.length) },
    };
  },

  // ref: a TicketSummary's ref from board().
  async ticket(account, ref, io) {
    const d = await graphql(account, io, TICKET_QUERY, {
      item: ref.itemId, content: ref.contentId, status: ref.statusField ?? "Status", priority: ref.priorityField ?? "Priority",
    });
    return mapTicket(d, ref);
  },
};
