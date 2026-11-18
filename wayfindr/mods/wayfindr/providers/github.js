// GitHub Provider: GitHub Projects (v2) boards. Translation only (ADR 0001).
// Auth: `gh auth token --user <login>` through the Profile's runner, then GraphQL over fetch, so
// the token never appears on a command line and `gh auth switch` is never used (ADR 0002).
import { NO_COLUMN, safeMarkdown, checksState, checkUrl } from "./contract.js";
const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b); // case-insensitive in any engine

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
  id title url
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
    description: safeMarkdown(c.body ?? ""),
    acceptanceCriteria: null,
    comments: comments.map((m) => ({ author: m.author?.login ?? "ghost", body: safeMarkdown(m.body ?? ""), createdAt: m.createdAt, url: m.url })),
    moreComments: Math.max(0, (c.comments?.totalCount ?? 0) - comments.length),
    pullRequests: kind === "Issue" ? linkedPullRequests(c) : [],
  };
}

// Both PR sections in one request: search allows 30 requests a minute.
// The list takes only the rollup's state (#26): the checks themselves come with the detail.
const PR_LIST_FIELDS = `... on PullRequest { id number title url isDraft updatedAt headRefOid author { login ... on User { name } } repository { nameWithOwner }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;
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
    head: typeof n.headRefOid === "string" && n.headRefOid ? n.headRefOid : null,
    checks: ROLLUP_STATE[rollupOf(n)?.state] ?? "none",
  }));
}

// Checks (#26). The head commit's status check rollup: CheckRuns (Actions, apps) and StatusContexts.
const ROLLUP_STATE = { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "pending", EXPECTED: "pending" };
const RUN_STATE = {
  SUCCESS: "pass", NEUTRAL: "pass",
  FAILURE: "fail", TIMED_OUT: "fail", ACTION_REQUIRED: "fail", STARTUP_FAILURE: "fail", CANCELLED: "fail",
  SKIPPED: "skipped", STALE: "skipped",
};
const rollupOf = (node) => node?.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
export const CHECKS_FIELDS = `commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { totalCount nodes { __typename
      ... on CheckRun { name conclusion status detailsUrl checkSuite { app { name } workflowRun { workflow { name } } } }
      ... on StatusContext { context state targetUrl description } } } } } } }`;

// A rollup into { state, list }. Pure.
export function mapChecks(rollup) {
  const list = [];
  for (const c of rollup?.contexts?.nodes ?? []) {
    if (!c) continue;
    if (c.__typename === "StatusContext") {
      list.push({ name: c.context ?? "", group: null, state: ROLLUP_STATE[c.state] ?? "pending", url: checkUrl(c.targetUrl), description: c.description || null });
    } else if (c.__typename === "CheckRun") {
      const group = c.checkSuite?.workflowRun?.workflow?.name || c.checkSuite?.app?.name || null;
      const state = c.conclusion == null ? "pending" : (RUN_STATE[c.conclusion] ?? "fail");
      list.push({ name: c.name ?? "", group, state, url: checkUrl(c.detailsUrl), description: null });
    }
  }
  return { state: checksState(list), list };
}

// Repos the login can reach (own, collaborator, org member), for following (PR filter).
// A Review's data (D16): the branches, the description, and the issues it closes as criteria. GitHub
// issues have no acceptance criteria field, so each issue's body stands in.
export const MOVE_MUTATION = `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

// Title edits by content type, and comments (#16). Drafts can't take comments.
export const TITLE_MUTATIONS = {
  Issue: `mutation($id: ID!, $title: String!) { updateIssue(input: { id: $id, title: $title }) { issue { id } } }`,
  PullRequest: `mutation($id: ID!, $title: String!) { updatePullRequest(input: { pullRequestId: $id, title: $title }) { pullRequest { id } } }`,
  DraftIssue: `mutation($id: ID!, $title: String!) { updateProjectV2DraftIssue(input: { draftIssueId: $id, title: $title }) { draftIssue { id } } }`,
};
export const COMMENT_MUTATION = `mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { subject { id } } }`;

export const REVIEW_QUERY = `query($id: ID!) {
  node(id: $id) { ... on PullRequest { headRefName baseRefName body isCrossRepository
    closingIssuesReferences(first: 20) { nodes { number title body } } } }
}`;

export function mapReview(node) {
  if (!node?.headRefName) throw new Error("GitHub didn't return this Pull Request");
  return {
    branch: node.headRefName, target: node.baseRefName ?? null, description: node.body ?? "", fork: Boolean(node.isCrossRepository),
    criteria: (node.closingIssuesReferences?.nodes ?? []).map((i) => ({ id: `#${i.number}`, title: i.title ?? "", text: i.body ?? "" })),
  };
}

// A Pull Request's detail (#1): everything but the files in one query, the files by REST.
const ISSUE_COMMENTS = 100, THREADS = 50, THREAD_COMMENTS = 20, FILE_PAGES = 3;
const REST = "https://api.github.com";
export const PR_DETAIL_QUERY = `query($id: ID!) {
  viewer { login name }
  node(id: $id) { ... on PullRequest {
    number title url repository { nameWithOwner }
    body state isDraft mergedAt createdAt updatedAt headRefName headRefOid baseRefName changedFiles
    author { login ... on User { name } }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login name } ... on Team { name } } } }
    latestReviews(first: 30) { nodes { author { login } state } }
    comments(first: ${ISSUE_COMMENTS}) { totalCount nodes { author { login } body createdAt } }
    reviewThreads(first: ${THREADS}) { totalCount nodes { id path line isResolved isOutdated diffSide comments(first: ${THREAD_COMMENTS}) { totalCount nodes { databaseId author { login } body createdAt } } } }
    ${CHECKS_FIELDS}
  } }
}`;

const REVIEW_STATE = { APPROVED: "approved", CHANGES_REQUESTED: "changes", COMMENTED: "commented", PENDING: "pending", DISMISSED: "commented" };
const FILE_STATUS = { added: "added", modified: "modified", removed: "deleted", renamed: "renamed", copied: "added", changed: "modified" };

// One REST "List pull request files" entry. GitHub leaves out the patch of binary and very large files.
export function mapPrFile(f) {
  const patch = typeof f.patch === "string" ? f.patch : null;
  return {
    path: f.filename, oldPath: f.previous_filename ?? null, status: FILE_STATUS[f.status] ?? "modified",
    additions: f.additions ?? 0, deletions: f.deletions ?? 0, patch, binary: patch == null,
  };
}

// The detail query's node and the fetched files into a PrDetail. viewer: the query's viewer (the signed-in
// account), for me. Pure.
export function mapPrDetail(node, files, pr, viewer = null) {
  if (!node?.headRefName) throw new Error("GitHub didn't return this Pull Request");
  const repo = node.repository?.nameWithOwner ?? pr.repo;
  const login = (a) => a?.login ?? "ghost";
  const reviewers = (node.latestReviews?.nodes ?? []).filter(Boolean).map((r) => ({ name: login(r.author), state: REVIEW_STATE[r.state] ?? "commented" }));
  for (const q of node.reviewRequests?.nodes ?? []) {
    const name = q?.requestedReviewer?.login ?? q?.requestedReviewer?.name;
    if (name && !reviewers.some((r) => r.name === name)) reviewers.push({ name, state: "waiting" });
  }
  const comment = (c, path = null, line = null) => ({ author: login(c.author), createdAt: c.createdAt ?? null, body: safeMarkdown(c.body ?? ""), path, line });
  const issue = (node.comments?.nodes ?? []).filter(Boolean);
  const threads = (node.reviewThreads?.nodes ?? []).filter(Boolean);
  const comments = [
    ...issue.map((c) => comment(c)),
    ...threads.flatMap((t) => (t.comments?.nodes ?? []).filter(Boolean).map((c) => comment(c, t.path ?? null, t.line ?? null))),
  ].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const moreComments = Math.max(0, (node.comments?.totalCount ?? 0) - issue.length)
    + threads.reduce((n, t) => n + Math.max(0, (t.comments?.totalCount ?? 0) - (t.comments?.nodes ?? []).length), 0)
    + Math.max(0, (node.reviewThreads?.totalCount ?? 0) - threads.length); // unfetched threads count as one comment each
  // Review threads as threads (#25): oldest first by their first comment; an outdated thread is on no line.
  const reviewThreads = threads.map((t) => ({
    id: t.id ?? null, path: String(t.path ?? "").replace(/^\/+/, ""), line: t.isOutdated ? null : (t.line ?? null),
    side: t.diffSide === "LEFT" ? "old" : "new", resolved: typeof t.isResolved === "boolean" ? t.isResolved : null,
    reply: Number.isInteger(t.comments?.nodes?.[0]?.databaseId) ? t.comments.nodes[0].databaseId : null, // the REST id replies go under
    comments: (t.comments?.nodes ?? []).filter(Boolean).map((c) => ({ author: login(c.author), createdAt: c.createdAt ?? null, body: safeMarkdown(c.body ?? "") })),
  })).filter((t) => t.comments.length)
    .sort((a, b) => String(a.comments[0].createdAt).localeCompare(String(b.comments[0].createdAt)));
  return {
    key: pr.key, id: `${repo.split("/")[1]}#${node.number}`, title: node.title ?? "", url: node.url ?? null, repo,
    state: String(node.state).toLowerCase() === "merged" ? "merged" : String(node.state).toLowerCase() === "closed" ? "closed" : "open",
    draft: Boolean(node.isDraft),
    author: { id: login(node.author), name: node.author?.name || login(node.author) },
    me: viewer?.login ? { id: viewer.login, name: viewer.name || viewer.login } : null,
    branch: node.headRefName, target: node.baseRefName ?? null,
    head: node.headRefOid ?? null,
    createdAt: node.createdAt ?? null, updatedAt: node.updatedAt ?? null, mergedAt: node.mergedAt ?? null,
    description: safeMarkdown(node.body ?? ""),
    reviewers, comments, moreComments, threads: reviewThreads,
    files: files.map(mapPrFile),
    moreFiles: Math.max(0, (node.changedFiles ?? files.length) - files.length),
    truncated: false, // GitHub doesn't say when it left a patch out for size
    checks: mapChecks(rollupOf(node)),
  };
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// A GET on the REST API. Rejects with a message fit to show, never with the token.
async function restGet(io, url, t) {
  let res;
  try {
    res = await io.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "herdr-wayfindr" } });
  } catch { throw new Error("The request to GitHub failed before it was answered"); }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`GitHub answered ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(body?.message ? `GitHub answered ${res.status}: ${body.message}` : `GitHub answered ${res.status}`);
  return body;
}

// A POST on the REST API with a JSON body (#27). Rejects with a message fit to show, never with the token.
async function restPost(io, url, t, body) {
  let res;
  try {
    res = await io.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "herdr-wayfindr" },
      body: JSON.stringify(body),
    });
  } catch { throw new Error("The request to GitHub failed before it was answered"); }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const why = [data?.message, ...(Array.isArray(data?.errors) ? data.errors.map((e) => (typeof e === "string" ? e : e?.message)).filter(Boolean) : [])].filter(Boolean).join(": ");
    throw new Error(why ? `GitHub answered ${res.status}: ${why}` : `GitHub answered ${res.status}`);
  }
  return data;
}

// Where a PR's REST resources are: owner/name and the number, from the detail. Checked before they go in a URL.
function prRest(detail) {
  const repo = String(detail?.repo ?? ""), number = String(detail?.id ?? "").split("#").pop();
  if (!REPO_NAME.test(repo) || !/^\d+$/.test(number)) throw new Error("This Pull Request has no repo or number to post to");
  return { repo, number };
}

const EVENT = { comment: "COMMENT", approve: "APPROVE", changes: "REQUEST_CHANGES" };
const SIDE = { new: "RIGHT", old: "LEFT" };

// A review's request body (#27). GitHub needs a body for COMMENT and REQUEST_CHANGES. Pure.
export function reviewBody(detail, review) {
  const event = EVENT[review?.event];
  if (!event) throw new Error(`"${review?.event}" isn't a review verdict`);
  const text = String(review.body ?? "").trim();
  const comments = (review.comments ?? []).map((c) => ({
    path: String(c.path).replace(/^\/+/, ""), line: c.line, side: SIDE[c.side] ?? "RIGHT", body: c.body,
    ...(c.startLine !== undefined && c.startLine !== null ? { start_line: c.startLine, start_side: SIDE[c.startSide] ?? "RIGHT" } : {}),
  }));
  return {
    ...(detail?.head ? { commit_id: detail.head } : {}), event,
    ...(text ? { body: text } : event !== "APPROVE" ? { body: "See the inline comments." } : {}),
    comments,
  };
}

export const REPOS_QUERY = `query($after: String) {
  viewer { repositories(first: ${PAGE}, after: $after, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
    pageInfo { hasNextPage endCursor } nodes { nameWithOwner isArchived } } }
}`;

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
    headers: { Authorization: `bearer ${t}`, "Content-Type": "application/json", "User-Agent": "herdr-wayfindr" },
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

// A write's missing scope, said with the scope it needs (the query-side message names read:project).
async function needsScope(write, scope, what) {
  try { await write; } catch (e) {
    if (/scope|permission|not accessible|INSUFFICIENT/i.test(String(e.message))) throw new Error(`gh needs the ${scope} scope to ${what}. Run: gh auth refresh -h github.com -s ${scope}`);
    throw e;
  }
}

export const github = {
  id: "github",
  capabilities: ["boards", "board", "ticket", "move", "update", "pullRequests", "prDetail", "review", "repos", "signInState", "postReview", "reply"],

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
    for (const t of tickets) Object.assign(t.ref, { statusField: vars.status, priorityField: vars.priority, projectId: project.id, fieldId: project.field.id });
    return { title: project.title, url: project.url, me, columns: mapColumns(project.field, tickets), tickets };
  },

  async repos(account, io) {
    const out = [];
    let after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await graphql(account, io, REPOS_QUERY, { after })).viewer.repositories;
      out.push(...r.nodes.filter((n) => n && !n.isArchived).map((n) => n.nameWithOwner));
      if (!r.pageInfo.hasNextPage) break;
      after = r.pageInfo.endCursor;
    }
    return [...new Set(out)].sort(byName);
  },

  async update(account, ref, fields, io) {
    const title = String(fields.title ?? "").trim(), m = TITLE_MUTATIONS[ref.kind];
    if (!m || !ref.contentId) throw new Error("This card can't be edited here");
    if (!title) throw new Error("A title can't be empty");
    // A draft lives in the project, so editing it needs "project". Issues and PRs need "repo".
    await needsScope(graphql(account, io, m, { id: ref.contentId, title }), ref.kind === "DraftIssue" ? "project" : "repo", "edit titles");
  },

  async comment(account, ref, text, io) {
    const body = String(text ?? "").trim();
    if (ref.kind === "DraftIssue") throw new Error("Draft issues can't take comments. Convert it to an issue first.");
    if (!ref.contentId) throw new Error("This card can't take comments");
    if (!body) throw new Error("Write a comment first");
    await needsScope(graphql(account, io, COMMENT_MUTATION, { id: ref.contentId, body }), "repo", "post comments");
  },

  // Sets the item's Status option (#15). Writing needs the "project" scope.
  async move(account, ref, target, _ticket, io) {
    const option = target.column?.id;
    if (!option || option === NO_COLUMN) throw new Error(`"${target.status ?? target.column?.name}" isn't an option of this project's Status field`);
    if (!ref.projectId || !ref.fieldId || !ref.itemId) throw new Error("Refresh the Board, then move the card again");
    await needsScope(graphql(account, io, MOVE_MUTATION, { project: ref.projectId, item: ref.itemId, field: ref.fieldId, option }), "project", "move cards");
  },

  async review(account, pr, io) {
    const r = mapReview((await graphql(account, io, REVIEW_QUERY, { id: pr.key })).node);
    if (r.fork) throw new Error("This Pull Request comes from a fork. Reviews check out branches from the repo itself.");
    return r;
  },

  // A PrDetail (#1). pr: a PrSummary from pullRequests(). Files: up to 3 pages of 100. opts.patches false:
  // no REST file pages, so no files (GraphQL gives only their count, in moreFiles); the caller has a clone.
  async pullRequest(account, pr, io, { patches = true } = {}) {
    const data = await graphql(account, io, PR_DETAIL_QUERY, { id: pr.key }), node = data.node, viewer = data.viewer ?? null;
    if (!node?.headRefName) throw new Error("GitHub didn't return this Pull Request");
    const repo = node.repository?.nameWithOwner ?? pr.repo;
    if (!REPO_NAME.test(String(repo)) || !Number.isInteger(node.number)) throw new Error("GitHub returned a Pull Request without a repo or number");
    const files = [];
    if (patches === false) return mapPrDetail(node, files, pr, viewer);
    const t = await token(account, io);
    const pages = Math.min(FILE_PAGES, Math.ceil((node.changedFiles ?? PAGE * FILE_PAGES) / PAGE));
    for (let page = 1; page <= pages; page++) {
      const list = await restGet(io, `${REST}/repos/${repo}/pulls/${node.number}/files?per_page=${PAGE}&page=${page}`, t);
      if (!Array.isArray(list)) throw new Error("GitHub didn't return this Pull Request's files");
      files.push(...list);
      if (list.length < PAGE) break;
    }
    return mapPrDetail(node, files, pr, viewer);
  },

  // One review (#27): the verdict, the summary and every line comment in one POST, as the signed-in account.
  async postReview(account, _pr, detail, review, io) {
    const { repo, number } = prRest(detail), body = reviewBody(detail, review);
    const url = `${REST}/repos/${repo}/pulls/${number}/reviews`;
    const t = await token(account, io);
    let r;
    await needsScope((async () => { r = await restPost(io, url, t, body); })(), "repo", "post reviews");
    return { url: typeof r?.html_url === "string" && /^https:\/\//.test(r.html_url) ? r.html_url : detail.url };
  },

  // A reply under a review thread (#27): thread.reply is its first comment's REST id.
  async reply(account, _pr, detail, thread, text, io) {
    const body = String(text ?? "").trim();
    if (!body) throw new Error("Write a reply first");
    if (!Number.isInteger(thread?.reply)) throw new Error("This thread can't take replies here");
    const { repo, number } = prRest(detail), t = await token(account, io);
    const url = `${REST}/repos/${repo}/pulls/${number}/comments/${thread.reply}/replies`;
    await needsScope(restPost(io, url, t, { body }), "repo", "post replies");
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
