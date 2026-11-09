// Azure DevOps Provider: a team's Kanban board. Translation only (ADR 0001).
// Auth: each Profile has its own az login in ~/.config/wayfinder/azure/<profile> (AZURE_CONFIG_DIR),
// so two Profiles never share credentials. Each refresh gets a fresh Entra token from
// `az account get-access-token` (R3) and calls the REST API over fetch with --api-version pinned (R4).
// The token never appears on a command line (ADR 0002).
//
// Azure has no "items on this board" endpoint (G4), so the Board is rebuilt (D20): the board's
// columns, the work item types its columns map, the team's area paths, and a WIQL query. Each item's
// Column is the team's own WEF_<guid>_Kanban.Column field. Swimlanes are ignored.

const RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"; // Azure DevOps
const API_VERSION = "7.1";
const PREVIEW = "7.1-preview"; // connectionData has no GA version
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
      ref: { id: w.id, project },
      key: String(w.id), id: String(w.id), title: f["System.Title"] ?? "", type: f["System.WorkItemType"] ?? "", url,
      columnId: (columnField && f[columnField]) || byState(f["System.WorkItemType"], f["System.State"]),
      assignees: a ? [{ id: a.id, name: a.displayName ?? a.uniqueName ?? "" }] : [],
      priority: p != null ? `P${p}` : null,
    };
  });
}

export const azure = {
  id: "azure",
  capabilities: ["boards", "board", "signInState"],

  async signInState(_account, io) {
    const r = await az(io, ["account", "get-access-token", "--resource", RESOURCE, "--query", "expiresOn", "-o", "tsv"]);
    if (r.code === 0) return { ok: true };
    if (r.code === 127) return { ok: false, reason: `az isn't reachable through the runner: ${firstLine(r)}`, command: null };
    const msg = firstLine(r);
    return { ok: false, reason: /expired|AADSTS700082|refresh token/i.test(msg) ? "The az login expired" : "Not signed in to Azure for this Profile", command: loginCommand(io.profile) };
  },

  async boards(account, io) {
    const org = orgUrl(account), tok = await token(account, io), out = [];
    for (const project of account.projects) {
      const teams = (await rest(org, tok, io, `_apis/projects/${seg(project)}/teams?$mine=true`)).value;
      for (const t of teams) {
        const boards = (await rest(org, tok, io, `${seg(project)}/${seg(t.name)}/_apis/work/boards`)).value;
        for (const b of boards) out.push({ title: `${t.name} · ${b.name}`, url: `${org}/${seg(project)}/_boards/board/t/${seg(t.name)}/${seg(b.name)}`, ref: { project, team: t.name, board: b.name } });
      }
    }
    return out;
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
