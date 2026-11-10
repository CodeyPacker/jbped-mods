// Azure DevOps Provider: a team's Kanban board. Translation only (ADR 0001).
// Auth: each Profile has its own az login in ~/.config/wayfinder/azure/<profile> (AZURE_CONFIG_DIR),
// so two Profiles never share credentials. Each refresh gets a fresh Entra token from
// `az account get-access-token` (R3) and calls the REST API over fetch with --api-version pinned (R4).
// The token never appears on a command line (ADR 0002).
//
// Azure has no "items on this board" endpoint (G4), so the Board is rebuilt (D20): the board's
// columns, the work item types its columns map, the team's area paths, and a WIQL query. Each item's
// Column is the team's own WEF_<guid>_Kanban.Column field. Swimlanes are ignored.
//
// Ticket detail converts the HTML fields to markdown. Bugs show their repro steps as the description.
// Linked Azure PRs are fetched. GitHub PR links show by URL only (R5).
import { htmlToMarkdown } from "./html.js";

const RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"; // Azure DevOps
const API_VERSION = "7.1";
const PREVIEW = "7.1-preview"; // connectionData has no GA version
const TEAMS_VERSION = "7.1-preview.3"; // the org-wide team list is preview only
const COMMENTS_VERSION = "7.1-preview.4"; // the comments API is preview only: pinned here (R4)
const COMMENTS = 100, MAX_PRS = 20, MAX_PR_LIST = 100;
const MAX_ITEMS = 2000, BATCH = 200;
const DONE_DAYS = 30; // items in the last Column show only if they changed this recently

// Runs az with the Profile's own config folder. A fixed script: the folder name and args are argv.
const AZ_SH = 'd="$HOME/.config/wayfinder/azure/$1"; shift; AZURE_CONFIG_DIR="$d" AZURE_DEVOPS_EXT_CONFIG_DIR="$d/azuredevops" exec "$@"';
export const azDir = (profile) => String(profile ?? "default").replace(/[^A-Za-z0-9_-]/g, "_");
export const azArgs = (profile, args) => ["-c", AZ_SH, "wayfinder-az", azDir(profile), "az", ...args];
const az = (io, args, timeout = 30000) => io.run("sh", azArgs(io.profile, args), { timeout });

export function loginCommand(profile) {
  const d = `~/.config/wayfinder/azure/${azDir(profile)}`;
  return `AZURE_CONFIG_DIR=${d} AZURE_DEVOPS_EXT_CONFIG_DIR=${d}/azuredevops az login --allow-no-subscriptions`;
}

// Only Azure DevOps hosts ever get the token.
const ORG = /^https:\/\/(dev\.azure\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*|[A-Za-z0-9][A-Za-z0-9-]*\.visualstudio\.com)\/?$/;
export const validOrg = (org) => ORG.test(String(org ?? ""));
const orgUrl = (account) => {
  if (!validOrg(account.org)) throw new Error(`"${account.org}" isn't an Azure DevOps organization URL`);
  return account.org.replace(/\/$/, "");
};
const seg = (s) => encodeURIComponent(s);

const firstLine = (r) => (r.stderr || r.stdout).trim().split("\n")[0];

async function token(account, io) {
  const r = await az(io, ["account", "get-access-token", "--resource", RESOURCE, "--query", "accessToken", "-o", "tsv"]);
  const t = r.stdout.trim();
  if (r.code === 127) throw new Error(`az isn't reachable through the runner: ${firstLine(r)}`);
  if (r.code !== 0 || !t) throw new Error(`Not signed in to Azure for this Profile. Run: ${loginCommand(io.profile)}`);
  return t;
}

// GET (or POST with a body) a path under the organization. Rejects with a message fit to show.
async function rest(org, tok, io, path, body, version = API_VERSION) {
  const url = `${org}/${path}${path.includes("?") ? "&" : "?"}api-version=${version}`;
  const res = await io.fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 203) throw new Error(`Azure DevOps refused the login (${res.status}). Run: ${loginCommand(io.profile)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Azure DevOps answered ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(data?.message ?? `Azure DevOps answered ${res.status}`);
  return data;
}

// WIQL string literal.
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ref = (name) => {
  if (!/^[A-Za-z0-9_.]+$/.test(name)) throw new Error(`Unexpected field name: ${name}`);
  return `[${name}]`;
};

// The query for the board's items: its work item types, on the team's area paths, done ones recent only.
export function boardWiql({ types, teamField, areas, doneStates, orderField }) {
  const where = [`[System.TeamProject] = @project`, `[System.WorkItemType] IN (${types.map(lit).join(", ")})`];
  if (areas.length) where.push(`(${areas.map((a) => `${ref(teamField)} ${a.includeChildren ? "UNDER" : "="} ${lit(a.value)}`).join(" OR ")})`);
  where.push(`[System.State] <> 'Removed'`);
  if (doneStates.length) where.push(`([System.State] NOT IN (${doneStates.map(lit).join(", ")}) OR [System.ChangedDate] >= @Today - ${DONE_DAYS})`);
  const order = orderField ? `${ref(orderField)} ASC, [System.Id] ASC` : `[System.Id] ASC`;
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY ${order}`;
}

// The board's Columns in order, the types they show, and the states of the last (done) Column.
export function boardShape(board) {
  const columns = board.columns.map((c) => ({ id: c.name, name: c.name }));
  const types = [...new Set(board.columns.flatMap((c) => Object.keys(c.stateMappings ?? {})))];
  const doneStates = [...new Set(board.columns.filter((c) => c.columnType === "outgoing").flatMap((c) => Object.values(c.stateMappings ?? {})))];
  return { columns, types, doneStates, columnField: board.fields?.columnField?.referenceName ?? null };
}

// Work items to TicketSummaries. An item the board hasn't placed yet goes to the Column its state maps to.
export function mapWorkItems(items, board, { org, project }) {
  const { columnField } = boardShape(board);
  const byState = (type, state) => board.columns.find((c) => c.stateMappings?.[type] === state)?.name ?? board.columns[0]?.name;
  return items.map((w) => {
    const f = w.fields, a = f["System.AssignedTo"], p = f["Microsoft.VSTS.Common.Priority"];
    const url = `${org}/${seg(project)}/_workitems/edit/${w.id}`;
    return {
      ref: { id: w.id, project, columnField },
      key: String(w.id), id: String(w.id), title: f["System.Title"] ?? "", type: f["System.WorkItemType"] ?? "", url,
      columnId: (columnField && f[columnField]) || byState(f["System.WorkItemType"], f["System.State"]),
      status: f["System.State"] ?? null,
      assignees: a ? [{ id: a.id, name: a.displayName ?? a.uniqueName ?? "" }] : [],
      priority: p != null ? `P${p}` : null,
    };
  });
}

const webUrl = (org, project, id) => `${org}/${seg(project)}/_workitems/edit/${id}`;
const PR_STATE = { active: "open", completed: "merged", abandoned: "closed" };

// A work item's linked pull requests: Azure ones by id (to fetch), GitHub ones as they are (R5).
export function linkedPrs(relations) {
  const azure = [], github = [];
  for (const r of relations ?? []) {
    const url = String(r.url ?? "");
    let m;
    if ((m = /^vstfs:\/\/\/Git\/PullRequestId\/[^/]+%2F[^/]+%2F(\d+)$/i.exec(url))) azure.push(Number(m[1]));
    else if ((m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i.exec(url))) {
      github.push({ id: `${m[2]}#${m[3]}`, title: "GitHub pull request", url, state: null, draft: false });
    } else if ((m = /^vstfs:\/\/\/GitHub\/PullRequest\/[^/]+%2F(\d+)$/i.exec(url))) {
      github.push({ id: `GitHub #${m[1]}`, title: "GitHub pull request", url: null, state: null, draft: false });
    }
  }
  return { azure: [...new Set(azure)], github };
}

export function mapPr(pr) {
  const repo = pr.repository ?? {};
  return {
    id: `${repo.name ?? ""}!${pr.pullRequestId}`, title: pr.title ?? "",
    url: repo.webUrl ? `${repo.webUrl}/pullrequest/${pr.pullRequestId}` : null,
    state: PR_STATE[pr.status] ?? null, draft: Boolean(pr.isDraft),
  };
}

// A PR list entry (one project's /pullrequests) into a PrSummary. Azure has no updated time, only created.
export function mapPrSummary(pr, org) {
  const repo = pr.repository ?? {}, project = repo.project?.name ?? "";
  const c = pr.createdBy ?? {};
  return {
    key: `${repo.id ?? repo.name}!${pr.pullRequestId}`, id: `${repo.name ?? ""}!${pr.pullRequestId}`, title: pr.title ?? "",
    url: repo.name ? `${org}/${seg(project)}/_git/${seg(repo.name)}/pullrequest/${pr.pullRequestId}` : null,
    repo: `${project}/${repo.name ?? ""}`, draft: Boolean(pr.isDraft),
    author: { id: c.id ?? "", name: c.displayName ?? c.uniqueName ?? "" },
    updatedAt: null, createdAt: pr.creationDate ?? null,
  };
}

// Comments oldest first, from a page fetched newest first.
export function mapComments(page, url) {
  const list = (page?.comments ?? []).slice().sort((a, b) => String(a.createdDate).localeCompare(String(b.createdDate)));
  return {
    comments: list.map((c) => ({
      author: c.createdBy?.displayName ?? "", createdAt: c.createdDate ?? null, url,
      body: c.format === "markdown" ? String(c.text ?? "") : htmlToMarkdown(c.text),
    })),
    moreComments: Math.max(0, (page?.totalCount ?? list.length) - list.length),
  };
}

export function mapTicket(w, { org, project, columnField = null, parent = null, comments = { comments: [], moreComments: 0 }, pullRequests = [] }) {
  const f = w.fields ?? {}, type = f["System.WorkItemType"] ?? "";
  const a = f["System.AssignedTo"], p = f["Microsoft.VSTS.Common.Priority"];
  const repro = type === "Bug" ? htmlToMarkdown(f["Microsoft.VSTS.TCM.ReproSteps"]) : "";
  const ac = "Microsoft.VSTS.Common.AcceptanceCriteria";
  return {
    ref: { id: w.id, project, columnField },
    key: String(w.id), id: String(w.id), title: f["System.Title"] ?? "", type, url: webUrl(org, project, w.id),
    column: (columnField && f[columnField]) || f["System.BoardColumn"] || f["System.State"] || null,
    assignees: a ? [{ id: a.id, name: a.displayName ?? a.uniqueName ?? "" }] : [],
    priority: p != null ? `P${p}` : null,
    tags: String(f["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean),
    parent,
    description: repro || htmlToMarkdown(f["System.Description"]),
    descriptionLabel: repro ? "Repro steps" : "Description",
    acceptanceCriteria: ac in f ? htmlToMarkdown(f[ac]) : null,
    ...comments,
    pullRequests,
  };
}

export const azure = {
  id: "azure",
  capabilities: ["boards", "board", "ticket", "pullRequests", "repos", "statuses", "signInState"],

  // Azure lists PRs one project at a time: two calls per project (the followed repos' projects, else the
  // configured ones). The reviewer filter
  // matches only the user, not reviews asked of a team the user is on.
  async pullRequests(account, io) {
    const org = orgUrl(account), tok = await token(account, io);
    const me = (await rest(org, tok, io, "_apis/connectionData", null, PREVIEW)).authenticatedUser?.id;
    if (!me) throw new Error("Azure DevOps didn't say who is signed in");
    const list = (project, filter) => rest(org, tok, io,
      `${seg(project)}/_apis/git/pullrequests?searchCriteria.status=active&searchCriteria.${filter}=${seg(me)}&$top=${MAX_PR_LIST}`)
      .then((d) => (d.value ?? []).map((pr) => mapPrSummary(pr, org)));
    const followed = account.followedRepos ?? [];
    const projects = followed.length ? [...new Set(followed.map((r) => r.slice(0, r.lastIndexOf("/"))))] : account.projects ?? [];
    const [mine, review] = await Promise.all(["creatorId", "reviewerId"].map((f) => Promise.all(projects.map((p) => list(p, f)))));
    return { me, mine: mine.flat(), needsReview: review.flat().filter((pr) => pr.author.id !== me), more: { mine: 0, needsReview: 0 } };
  },

  // ref: a TicketSummary's ref from board().
  async ticket(account, ref, io) {
    const id = Number(ref.id);
    if (!Number.isInteger(id) || id <= 0 || typeof ref.project !== "string") throw new Error("This card has no work item to open");
    const org = orgUrl(account), tok = await token(account, io), p = seg(ref.project);
    const w = await rest(org, tok, io, `${p}/_apis/wit/workitems/${id}?$expand=relations`);
    const parentId = Number(w.fields?.["System.Parent"]);
    const links = linkedPrs(w.relations);
    const [parent, page, prs] = await Promise.all([
      parentId > 0
        ? rest(org, tok, io, `_apis/wit/workitems/${parentId}?fields=System.Title,System.TeamProject`)
          .then((x) => ({ id: String(parentId), title: x.fields?.["System.Title"] ?? "", url: webUrl(org, x.fields?.["System.TeamProject"] ?? ref.project, parentId) }))
          .catch(() => ({ id: String(parentId), title: "", url: webUrl(org, ref.project, parentId) }))
        : null,
      rest(org, tok, io, `${p}/_apis/wit/workItems/${id}/comments?$top=${COMMENTS}&order=desc`, null, COMMENTS_VERSION),
      Promise.all(links.azure.slice(0, MAX_PRS).map((n) => rest(org, tok, io, `_apis/git/pullrequests/${n}`).then(mapPr)
        .catch(() => ({ id: `!${n}`, title: "", url: null, state: null, draft: false })))),
    ]);
    return mapTicket(w, {
      org, project: ref.project, columnField: ref.columnField ?? null, parent,
      comments: mapComments(page, webUrl(org, ref.project, id)), pullRequests: [...prs, ...links.github],
    });
  },

  async signInState(_account, io) {
    const r = await az(io, ["account", "get-access-token", "--resource", RESOURCE, "--query", "expiresOn", "-o", "tsv"]);
    if (r.code === 0) return { ok: true };
    if (r.code === 127) return { ok: false, reason: `az isn't reachable through the runner: ${firstLine(r)}`, command: null };
    const msg = firstLine(r);
    return { ok: false, reason: /expired|AADSTS700082|refresh token/i.test(msg) ? "The az login expired" : "Not signed in to Azure for this Profile", command: loginCommand(io.profile) };
  },

  // Boards of every team the user is on, across the organization (not only the configured projects).
  async boards(account, io) {
    const org = orgUrl(account), tok = await token(account, io);
    const teams = (await rest(org, tok, io, "_apis/teams?$mine=true&$top=500", null, TEAMS_VERSION)).value ?? [];
    const lists = await Promise.all(teams.map((t) => rest(org, tok, io, `${seg(t.projectName)}/${seg(t.name)}/_apis/work/boards`)
      .then((d) => (d.value ?? []).map((b, i) => ({
        teamDefault: i === 0, // what a Board config without "board" shows
        title: `${t.name} · ${b.name}`, url: `${org}/${seg(t.projectName)}/_boards/board/t/${seg(t.name)}/${seg(b.name)}`,
        ref: { project: t.projectName, team: t.name, board: b.name },
      }))).catch(() => [])));
    return lists.flat().sort((a, b) => a.title.localeCompare(b.title));
  },

  // Every repo in the organization as "project/repo", for following (PR filter).
  async repos(account, io) {
    const org = orgUrl(account), tok = await token(account, io);
    const d = await rest(org, tok, io, "_apis/git/repositories");
    return (d.value ?? []).filter((r) => !r.isDisabled).map((r) => `${r.project?.name ?? ""}/${r.name}`).sort((a, b) => a.localeCompare(b));
  },

  // The states a Board's work item types use, in process order, for Tracked Statuses. "Removed" is never on a Board.
  async statuses(account, ref, io) {
    if (typeof ref.project !== "string" || typeof ref.team !== "string") throw new Error(`An Azure Board's ref needs "project" and "team"`);
    const org = orgUrl(account), tok = await token(account, io), p = seg(ref.project);
    const pt = `${p}/${seg(ref.team)}`;
    const boardId = ref.board ?? (await rest(org, tok, io, `${pt}/_apis/work/boards`)).value?.[0]?.name;
    if (!boardId) throw new Error(`Team "${ref.team}" has no boards`);
    const { types } = boardShape(await rest(org, tok, io, `${pt}/_apis/work/boards/${seg(boardId)}`));
    const lists = await Promise.all(types.map((ty) => rest(org, tok, io, `${p}/_apis/wit/workitemtypes/${seg(ty)}/states`).then((d) => d.value ?? [])));
    return [...new Set(lists.flat().map((s) => s.name))].filter((n) => n && n !== "Removed");
  },

  // ref: { project, team, board? }. board is the board's name or id, by default the team's first.
  async board(account, ref, io) {
    if (typeof ref.project !== "string" || typeof ref.team !== "string") throw new Error(`An Azure Board's ref needs "project" and "team"`);
    const org = orgUrl(account), tok = await token(account, io);
    const pt = `${seg(ref.project)}/${seg(ref.team)}`;
    const [conn, boardId, teamFields, process] = await Promise.all([
      rest(org, tok, io, "_apis/connectionData", null, PREVIEW),
      ref.board ? ref.board : rest(org, tok, io, `${pt}/_apis/work/boards`).then((d) => {
        if (!d.value?.length) throw new Error(`Team "${ref.team}" has no boards`);
        return d.value[0].name;
      }),
      rest(org, tok, io, `${pt}/_apis/work/teamsettings/teamfieldvalues`),
      rest(org, tok, io, `${seg(ref.project)}/_apis/work/processconfiguration`).catch(() => null),
    ]);
    const board = await rest(org, tok, io, `${pt}/_apis/work/boards/${seg(boardId)}`);
    const shape = boardShape(board);
    if (!shape.types.length) throw new Error(`Board "${board.name}" maps no work item types`);

    const query = boardWiql({
      types: shape.types, teamField: teamFields.field?.referenceName ?? "System.AreaPath", areas: teamFields.values ?? [],
      doneStates: shape.doneStates, orderField: process?.typeFields?.Order?.referenceName ?? null,
    });
    const ids = (await rest(org, tok, io, `${pt}/_apis/wit/wiql?$top=${MAX_ITEMS}`, { query })).workItems.map((w) => w.id);
    const fields = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "Microsoft.VSTS.Common.Priority", ...(shape.columnField ? [shape.columnField] : [])];
    const items = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const d = await rest(org, tok, io, `${seg(ref.project)}/_apis/wit/workitemsbatch`, { ids: ids.slice(i, i + BATCH), fields, errorPolicy: "omit" });
      items.push(...d.value.filter(Boolean));
    }
    const rank = new Map(ids.map((id, i) => [id, i]));
    items.sort((a, b) => rank.get(a.id) - rank.get(b.id));

    return {
      title: `${ref.team} · ${board.name}`,
      url: `${org}/${seg(ref.project)}/_boards/board/t/${seg(ref.team)}/${seg(board.name)}`,
      me: conn.authenticatedUser?.id ?? null,
      columns: shape.columns,
      tickets: mapWorkItems(items, board, { org, project: ref.project }),
    };
  },
};
