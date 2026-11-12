// Azure DevOps Provider: a team's Kanban board. Translation only (ADR 0001).
// Auth: each Profile has its own az login in ~/.config/wayfindr/azure/<profile> (AZURE_CONFIG_DIR),
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
import { repoFilter, safeMarkdown } from "./contract.js";
import { unifiedDiff } from "./diff.js";
const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b); // case-insensitive in any engine

const RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"; // Azure DevOps
const API_VERSION = "7.1";
const PREVIEW = "7.1-preview"; // connectionData has no GA version
const TEAMS_VERSION = "7.1-preview.3"; // the org-wide team list is preview only
const COMMENTS_VERSION = "7.1-preview.4"; // the comments API is preview only: pinned here (R4)
const COMMENTS = 100, MAX_PRS = 20, MAX_PR_LIST = 100;
const MAX_ITEMS = 2000, BATCH = 200;
const DONE_DAYS = 30; // items in the last Column show only if they changed this recently

// Runs az with the Profile's own config folder. A fixed script: the folder name and args are argv.
const AZ_SH = 'd="$HOME/.config/wayfindr/azure/$1"; shift; AZURE_CONFIG_DIR="$d" AZURE_DEVOPS_EXT_CONFIG_DIR="$d/azuredevops" exec "$@"';
export const azDir = (profile) => String(profile ?? "default").replace(/[^A-Za-z0-9_-]/g, "_");
export const azArgs = (profile, args) => ["-c", AZ_SH, "wayfindr-az", azDir(profile), "az", ...args];
const az = (io, args, timeout = 30000) => io.run("sh", azArgs(io.profile, args), { timeout });

// Downloads an attachment to a file through az (which signs the request), unless the file is there.
// A Windows path (Herdr's home on Windows, the runner in WSL) is converted. A fixed script: url, path
// and resource are argv.
const DL_SH = 'p="$2"; case "$p" in [A-Za-z]:*) p=$(wslpath -u "$p") || exit 1;; esac; [ -s "$p" ] && exit 0; mkdir -p "$(dirname "$p")" && az rest --resource "$3" --url "$1" --output-file "$p.part" && mv "$p.part" "$p"';
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
export const isImageName = (name) => IMAGE_EXT.test(String(name ?? ""));

// Moves a Profile's az login folder to its new name (a Profile rename). Nothing to move, or a folder
// already there, leaves both as they are. A fixed script: the names are argv.
const MV_SH = 'b="$HOME/.config/wayfindr/azure"; if [ -d "$b/$1" ] && [ ! -e "$b/$2" ]; then mv "$b/$1" "$b/$2"; fi';
export const moveLoginArgs = (from, to) => ["-c", MV_SH, "wayfindr-mv", azDir(from), azDir(to)];

export function loginCommand(profile) {
  const d = `~/.config/wayfindr/azure/${azDir(profile)}`;
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

// A PAT fallback (#19) for organizations az can't sign in to: the name of an environment variable the
// runner's login shell sets. The PAT is read each time and only ever goes in a header (ADR 0002).
// Upper case and short, so a pasted token (lower case, or a pk_ prefix, or long) is never taken as a name.
export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,39}$/;

// The token in a login shell's printenv output: its last non-empty line, since a profile may print
// first. A value with spaces or control characters is refused without showing it.
export function tokenFromOutput(stdout, name) {
  const t = String(stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  if (/[\s\u0000-\u001f\u007f]/.test(t)) throw new Error(`${name} holds spaces or control characters, so it isn't a token`);
  return t;
}
const PRINTENV_SH = 'printenv "$1"';
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function base64(text) {
  const bytes = [];
  for (const ch of String(text)) { // UTF-8
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = bytes.slice(i, i + 3), n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

async function patFrom(account, io) {
  if (!ENV_NAME.test(String(account.patEnv))) throw new Error("patEnv must be an environment variable name in upper case, e.g. AZURE_DEVOPS_PAT");
  const r = await io.run("bash", ["-lc", PRINTENV_SH, "wayfindr-env", account.patEnv], { timeout: 15000 });
  if (r.code === 127) throw new Error(`The runner can't start bash: ${firstLine(r)}`);
  const pat = r.code === 0 ? tokenFromOutput(r.stdout, account.patEnv) : "";
  if (!pat) throw new Error(`${account.patEnv} isn't set in the runner's login shell. Export it in ~/.profile (or ~/.bash_profile if you have one).`);
  return pat;
}

// The Authorization header: the PAT when the Account names one, else a fresh az token (R3).
// patEnv rides along so a refusal names the right fix.
async function token(account, io) {
  if (account.patEnv) return { header: `Basic ${base64(`:${await patFrom(account, io)}`)}`, patEnv: account.patEnv };
  return { header: `Bearer ${await azToken(account, io)}`, patEnv: null };
}

const refused = (status, tok, io) => (tok.patEnv
  ? `Azure DevOps refused the PAT in ${tok.patEnv}. Make a new one and export it again.`
  : `Azure DevOps refused the login (${status}). Run: ${loginCommand(io.profile)}`);

// A fetch that throws (not an HTTP status) is reported without its text, which may hold the header.
async function send(io, url, opts) {
  try { return await io.fetch(url, opts); } catch { throw new Error("The request to Azure DevOps failed before it was answered"); }
}

async function azToken(account, io) {
  const r = await az(io, ["account", "get-access-token", "--resource", RESOURCE, "--query", "accessToken", "-o", "tsv"]);
  const t = r.stdout.trim();
  if (r.code === 127) throw new Error(`az isn't reachable through the runner: ${firstLine(r)}`);
  if (r.code !== 0 || !t) throw new Error(`Not signed in to Azure for this Profile. Run: ${loginCommand(io.profile)}`);
  return t;
}

// GET (or POST with a body) a path under the organization. Rejects with a message fit to show.
async function rest(org, tok, io, path, body, version = API_VERSION) {
  const url = `${org}/${path}${path.includes("?") ? "&" : "?"}api-version=${version}`;
  const res = await send(io, url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: tok.header, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 203) throw new Error(refused(res.status, tok, io));
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Azure DevOps answered ${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(data?.message ?? `Azure DevOps answered ${res.status}`);
  return data;
}

// A JSON Patch to a work item (#15, #16). Azure answers with the item, or an error message.
async function patchItem(org, tok, io, id, ops) {
  const res = await send(io, `${org}/_apis/wit/workitems/${id}?api-version=${API_VERSION}`, {
    method: "PATCH",
    headers: { Authorization: tok.header, Accept: "application/json", "Content-Type": "application/json-patch+json" },
    body: JSON.stringify(ops),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 203) throw new Error(refused(res.status, tok, io));
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(data?.message ?? `Azure DevOps answered ${res.status}`);
  return data;
}

// The patch for a Move. A Provider Column sets the state its type maps to, plus the board's own Column
// field (R7: that field is undocumented, so the state comes with it). A Tracked Status sets the state,
// even when a Provider Column has the same name.
export function moveOps(ref, target, type) {
  const state = target.status ?? target.column?.states?.[type];
  if (!state) throw new Error(`The Column "${target.column?.name}" has no state for a ${type || "work item"}`);
  const ops = [{ op: "add", path: "/fields/System.State", value: state }];
  if (target.column && !target.status && ref.columnField) ops.push({ op: "add", path: `/fields/${ref.columnField}`, value: target.column.name });
  return ops;
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
  const columns = board.columns.map((c) => ({ id: c.name, name: c.name, states: c.stateMappings ?? {} }));
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
    else if ((m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#][^\s<>]*)?$/i.exec(url))) {
      // Rebuilt from the parts, so nothing else in the relation's URL reaches a link.
      github.push({ id: `${m[2]}#${m[3]}`, title: "GitHub pull request", url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, state: null, draft: false });
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
      body: c.format === "markdown" ? safeMarkdown(String(c.text ?? "")) : htmlToMarkdown(c.text),
    })),
    moreComments: Math.max(0, (page?.totalCount ?? list.length) - list.length),
  };
}

// A work item's attached image files (not the ones shown inline: those are in the text).
export function attachedImages(relations) {
  return (relations ?? []).filter((r) => r.rel === "AttachedFile" && isImageName(r.attributes?.name))
    .map((r) => ({ url: `${r.url}?fileName=${encodeURIComponent(r.attributes.name)}`, name: r.attributes.name }));
}

// The local file name for an attachment URL in this organization, or null for any other URL. A PAT
// Account gets null too: az signs the download, so its images show as links.
export function imageName(account, url) {
  if (account.patEnv) return null;
  const org = String(account.org ?? "").replace(/\/$/, "");
  const raw = String(url);
  if (!validOrg(org) || !raw.startsWith(`${org}/`)) return null;
  const [path, query = ""] = raw.split("#")[0].split("?");
  // No dot segments, plain or encoded, and after parsing it must still be under the org.
  if (/%2e/i.test(path) || path.split("/").some((s) => s === "." || s === "..")) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  const base = new URL(`${org}/`);
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return null;
  const m = /\/_apis\/wit\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(u.pathname);
  let file = "";
  try { file = decodeURIComponent(/(?:^|&)fileName=([^&]*)/i.exec(query)?.[1] ?? ""); } catch { /* bad escape: no name */ }
  const ext = IMAGE_EXT.exec(file);
  return m && ext ? `${m[1].toLowerCase()}.${ext[1].toLowerCase()}` : null;
}

const branchOf = (ref) => String(ref ?? "").replace(/^refs\/heads\//, "");
export function mapReview(pr, items) {
  if (!pr?.sourceRefName) throw new Error("Azure DevOps didn't return this Pull Request");
  return {
    branch: branchOf(pr.sourceRefName), target: branchOf(pr.targetRefName) || null, description: pr.description ?? "",
    fork: Boolean(pr.forkSource), // set only when the source branch lives in a fork
    criteria: items.map((w) => ({ id: String(w.id), title: w.fields?.["System.Title"] ?? "", text: htmlToMarkdown(w.fields?.["Microsoft.VSTS.Common.AcceptanceCriteria"]) })),
  };
}

// A Pull Request's detail (#1). Azure has no patch API, so both sides of each file are fetched and diffed.
const PR_THREADS = 100, PR_FILES = 50, PR_CHANGES = 100, FILE_FETCHES = 6;
const VOTE = { 10: "approved", 5: "approved", 0: "waiting", "-5": "commented", "-10": "rejected" };

export function fileStatus(changeType) {
  const t = String(changeType ?? "").toLowerCase();
  if (t.includes("rename")) return "renamed";
  if (t.includes("add")) return "added";
  if (t.includes("delete")) return "deleted";
  return "modified";
}

// Threads into comments, oldest first: deleted threads and comments and system comments left out. The first
// PR_THREADS threads (by their first comment) are kept, the rest counted in moreComments. Pure.
export function mapThreads(threads) {
  const kept = (threads ?? []).filter((t) => t && !t.isDeleted)
    .map((t) => ({ t, list: (t.comments ?? []).filter((c) => c && !c.isDeleted && c.commentType !== "system") }))
    .filter((x) => x.list.length)
    .sort((a, b) => String(a.list[0].publishedDate).localeCompare(String(b.list[0].publishedDate)));
  const comments = kept.slice(0, PR_THREADS).flatMap(({ t, list }) => list.map((c) => ({
    author: c.author?.displayName ?? "", createdAt: c.publishedDate ?? null, body: safeMarkdown(String(c.content ?? "")),
    path: t.threadContext?.filePath ?? null, line: t.threadContext?.filePath ? (t.threadContext.rightFileStart?.line ?? null) : null,
  }))).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { comments, moreComments: kept.slice(PR_THREADS).reduce((n, x) => n + x.list.length, 0) };
}

// One Items Get answer: the text, or null when the item is binary or has no text content.
export function itemText(item) {
  if (!item || item.isBinary || item.contentMetadata?.isBinary || (item.gitObjectType && item.gitObjectType !== "blob")) return null;
  return typeof item.content === "string" ? item.content : null;
}

// A change entry and its two sides (undefined: the side doesn't exist; null: binary) into a PrDetail file. Pure.
export function mapChange(entry, oldItem, newItem) {
  const status = fileStatus(entry.changeType), path = entry.item?.path ?? "";
  const oldPath = status === "renamed" ? (entry.originalPath ?? entry.sourceServerItem ?? null) : null;
  const oldText = oldItem === undefined ? "" : itemText(oldItem), newText = newItem === undefined ? "" : itemText(newItem);
  if (oldText == null || newText == null) return { file: { path, oldPath, status, additions: 0, deletions: 0, patch: null, binary: true }, truncated: false };
  const d = unifiedDiff(oldText, newText);
  return { file: { path, oldPath, status, additions: d.additions, deletions: d.deletions, patch: d.patch, binary: false }, truncated: d.truncated };
}

export function mapPrDetail(pr, { org, threads, files, moreFiles, truncated }) {
  if (!pr?.sourceRefName) throw new Error("Azure DevOps didn't return this Pull Request");
  const { comments, moreComments } = mapThreads(threads);
  const s = mapPrSummary(pr, org);
  return {
    key: s.key, id: s.id, title: s.title, url: s.url, repo: s.repo,
    state: PR_STATE[pr.status] ?? "open", draft: Boolean(pr.isDraft), author: s.author,
    branch: branchOf(pr.sourceRefName), target: branchOf(pr.targetRefName) || null,
    createdAt: pr.creationDate ?? null, updatedAt: null, mergedAt: pr.status === "completed" ? (pr.closedDate ?? null) : null,
    description: safeMarkdown(pr.description ?? ""),
    reviewers: (pr.reviewers ?? []).map((r) => ({ name: r.displayName ?? r.uniqueName ?? "", state: VOTE[r.vote] ?? "waiting" })),
    comments, moreComments, files, moreFiles, truncated,
  };
}

// Runs fn over items, at most `limit` at a time, keeping their order.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
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
    images: attachedImages(w.relations),
  };
}

export const azure = {
  id: "azure",
  capabilities: ["boards", "board", "ticket", "images", "move", "update", "pullRequests", "prDetail", "review", "repos", "statuses", "signInState"],

  // Azure lists PRs one project at a time: two calls per project (the selected repos' projects, else
  // every project). The reviewer filter
  // matches only the user, not reviews asked of a team the user is on.
  async pullRequests(account, io) {
    const org = orgUrl(account), tok = await token(account, io);
    const me = (await rest(org, tok, io, "_apis/connectionData", null, PREVIEW)).authenticatedUser?.id;
    if (!me) throw new Error("Azure DevOps didn't say who is signed in");
    const list = (project, filter) => rest(org, tok, io,
      `${seg(project)}/_apis/git/pullrequests?searchCriteria.status=active&searchCriteria.${filter}=${seg(me)}&$top=${MAX_PR_LIST}`)
      .then((d) => (d.value ?? []).map((pr) => mapPrSummary(pr, org)));
    // Selected repos: only their projects. Otherwise every project in the organization.
    const f = repoFilter(account);
    const projects = f.mode === "selected"
      ? [...new Set(f.selected.map((r) => r.slice(0, r.lastIndexOf("/"))))]
      : ((await rest(org, tok, io, "_apis/projects?$top=500")).value ?? []).map((p) => p.name);
    const [mine, review] = await Promise.all(["creatorId", "reviewerId"].map((f) => Promise.all(projects.map((p) => list(p, f)))));
    return { me, mine: mine.flat(), needsReview: review.flat().filter((pr) => pr.author.id !== me), more: { mine: 0, needsReview: 0 } };
  },

  imageName,

  // Saves an attachment image (an imageName URL) to `path`. A file already there is kept.
  async downloadImage(account, url, path, io) {
    if (!imageName(account, url)) throw new Error("Not an attachment of this organization"); // also refuses a PAT Account
    const full = `${url}${url.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
    // AZ_SH sets the Profile's az folder, then runs DL_SH (not az itself) with it.
    const r = await io.run("sh", ["-c", AZ_SH, "wayfindr-az", azDir(io.profile), "sh", "-c", DL_SH, "wayfindr-dl", full, path, RESOURCE], { timeout: 60000 });
    if (r.code !== 0) throw new Error(firstLine(r) || `az answered ${r.code}`);
  },

  async update(account, ref, fields, io) {
    const id = Number(ref.id), title = String(fields.title ?? "").trim();
    if (!Number.isInteger(id) || id <= 0) throw new Error("This card has no work item to change");
    if (!title) throw new Error("A title can't be empty");
    const org = orgUrl(account), tok = await token(account, io);
    await patchItem(org, tok, io, id, [{ op: "add", path: "/fields/System.Title", value: title }]);
  },

  // Posted as markdown, which Azure keeps and shows as such.
  async comment(account, ref, text, io) {
    const id = Number(ref.id), body = String(text ?? "").trim();
    if (!Number.isInteger(id) || id <= 0 || typeof ref.project !== "string") throw new Error("This card has no work item to comment on");
    if (!body) throw new Error("Write a comment first");
    const org = orgUrl(account), tok = await token(account, io);
    await rest(org, tok, io, `${seg(ref.project)}/_apis/wit/workItems/${id}/comments?format=markdown`, { text: body }, COMMENTS_VERSION);
  },

  async move(account, ref, target, ticket, io) {
    const id = Number(ref.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("This card has no work item to move");
    const org = orgUrl(account), tok = await token(account, io);
    await patchItem(org, tok, io, id, moveOps(ref, target, ticket.type));
  },

  // A PrDetail (#1). pr: a PrSummary from pullRequests(). The PR, its threads, its last iteration's changes,
  // then both sides of the first PR_FILES files (the target's last merge commit and the source's), diffed here.
  async pullRequest(account, pr, io) {
    const [repoId, n] = String(pr.key).split("!");
    if (!repoId || !/^\d+$/.test(n ?? "")) throw new Error("This row has no Pull Request to show");
    const project = pr.repo.slice(0, pr.repo.lastIndexOf("/"));
    const org = orgUrl(account), tok = await token(account, io);
    const base = `${seg(project)}/_apis/git/repositories/${seg(repoId)}`, prPath = `${base}/pullRequests/${n}`;
    const [d, threads, iterations] = await Promise.all([
      rest(org, tok, io, prPath), rest(org, tok, io, `${prPath}/threads`), rest(org, tok, io, `${prPath}/iterations`),
    ]);
    const lastIt = (iterations.value ?? []).at(-1), last = lastIt?.id;
    const entries = last == null ? [] : ((await rest(org, tok, io, `${prPath}/iterations/${last}/changes?$top=${PR_CHANGES}`)).changeEntries ?? [])
      .filter((e) => e?.item?.path && !e.item.isFolder && e.item.gitObjectType !== "tree");
    const commit = (c) => (/^[0-9a-f]{40}$/i.test(String(c?.commitId ?? "")) ? c.commitId : null);
    // The old side is the merge base (the iteration's commonRefCommit), as Azure's own diff view shows:
    // the target branch's tip would show its later commits reversed. Older iterations lack it.
    const oldCommit = commit(lastIt?.commonRefCommit) ?? commit(d.lastMergeTargetCommit), newCommit = commit(d.lastMergeSourceCommit);
    const item = (path, version) => (version
      ? rest(org, tok, io, `${base}/items?path=${seg(path)}&versionDescriptor.versionType=commit&versionDescriptor.version=${version}&includeContent=true`)
      : Promise.resolve(null));
    let truncated = false;
    const files = await pool(entries.slice(0, PR_FILES), FILE_FETCHES, async (e) => {
      const status = fileStatus(e.changeType), oldPath = status === "renamed" ? (e.originalPath ?? e.sourceServerItem ?? e.item.path) : e.item.path;
      try {
        const [oldItem, newItem] = await Promise.all([
          status === "added" ? undefined : item(oldPath, oldCommit),
          status === "deleted" ? undefined : item(e.item.path, newCommit),
        ]);
        const r = mapChange(e, oldItem, newItem);
        truncated ||= r.truncated;
        return r.file;
      } catch { // one unreadable file doesn't hide the rest: it shows without a patch
        return { path: e.item.path, oldPath: status === "renamed" ? oldPath : null, status, additions: 0, deletions: 0, patch: null, binary: false };
      }
    });
    return mapPrDetail(d, { org, threads: threads.value, files, moreFiles: Math.max(0, entries.length - PR_FILES), truncated });
  },

  // A Review's data (D16): the branches, the description, and the acceptance criteria of every linked
  // work item. pr: a PrSummary from pullRequests() (key "<repo id>!<number>", repo "<project>/<repo>").
  async review(account, pr, io) {
    const [repoId, n] = String(pr.key).split("!");
    if (!repoId || !/^\d+$/.test(n ?? "")) throw new Error("This row has no Pull Request to review");
    const project = pr.repo.slice(0, pr.repo.lastIndexOf("/"));
    const org = orgUrl(account), tok = await token(account, io);
    const [d, links] = await Promise.all([
      rest(org, tok, io, `_apis/git/pullrequests/${n}`),
      rest(org, tok, io, `${seg(project)}/_apis/git/repositories/${seg(repoId)}/pullRequests/${n}/workitems`).catch(() => ({ value: [] })),
    ]);
    const ids = (links.value ?? []).map((w) => Number(w.id)).filter((x) => x > 0).slice(0, MAX_PRS);
    const items = ids.length
      ? (await rest(org, tok, io, `_apis/wit/workitems?ids=${ids.join(",")}&fields=System.Title,Microsoft.VSTS.Common.AcceptanceCriteria`)).value ?? []
      : [];
    const r = mapReview(d, items);
    if (r.fork) throw new Error("This Pull Request comes from a fork. Reviews check out branches from the repo itself.");
    return r;
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

  // Called when a Profile is renamed: its az login folder follows.
  async renameProfile(from, to, io) {
    const r = await io.run("sh", moveLoginArgs(from, to), { timeout: 20000 });
    if (r.code !== 0) throw new Error(`Couldn't move the az login: ${firstLine(r)}`);
  },

  async signInState(account, io) {
    if (account.patEnv) { // a cheap call, so a refused PAT shows here and not as a Board error
      try { await rest(orgUrl(account), await token(account, io), io, "_apis/connectionData", null, PREVIEW); return { ok: true }; } catch (e) { return { ok: false, reason: String(e.message ?? e), command: null }; }
    }
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
    return lists.flat().sort((a, b) => byName(a.title, b.title));
  },

  // Every repo in the organization as "project/repo", for following (PR filter).
  async repos(account, io) {
    const org = orgUrl(account), tok = await token(account, io);
    const d = await rest(org, tok, io, "_apis/git/repositories");
    return (d.value ?? []).filter((r) => !r.isDisabled).map((r) => `${r.project?.name ?? ""}/${r.name}`).sort(byName);
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
