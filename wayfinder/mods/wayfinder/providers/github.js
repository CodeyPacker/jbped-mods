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
      assignees: (c.assignees?.nodes ?? []).map((a) => ({ id: a.login, name: a.name || a.login })),
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
  capabilities: ["boards", "board"],

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
    return { title: project.title, url: project.url, me, columns: mapColumns(project.field, tickets), tickets };
  },
};
