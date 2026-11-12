// ClickUp Provider (#18): a List as a Board, its statuses as Columns. Translation only (ADR 0001).
// Auth: ClickUp has no CLI, so this reopens D3 the same way the Azure PAT fallback (#19) does: the
// Account names an environment variable (default CLICKUP_API_TOKEN) that the runner's login shell sets.
// The token is read on each refresh and only ever goes in a header. Wayfindr never stores it (ADR 0002).
import { ENV_NAME, tokenFromOutput } from "./azure.js";
import { safeMarkdown } from "./contract.js";
const API = "https://api.clickup.com/api/v2";
const DEFAULT_ENV = "CLICKUP_API_TOKEN";
const MAX_PAGES = 20; // 100 tasks a page
const DONE_DAYS = 30; // closed and done tasks show only if they closed this recently
const COMMENT_PAGE = 25; // ClickUp sends the newest 25
const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const tokenEnv = (account) => account.tokenEnv ?? DEFAULT_ENV;

async function token(account, io) {
  const name = tokenEnv(account);
  if (!ENV_NAME.test(String(name))) throw new Error("tokenEnv must be an environment variable name in upper case, e.g. CLICKUP_API_TOKEN");
  const r = await io.run("bash", ["-lc", 'printenv "$1"', "wayfindr-env", name], { timeout: 15000 });
  if (r.code === 127) throw new Error(`The runner can't start bash: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  const t = r.code === 0 ? tokenFromOutput(r.stdout, name) : "";
  if (!t) throw new Error(`${name} isn't set in the runner's login shell. Make a token in ClickUp (Settings, Apps) and export it in ~/.profile (or ~/.bash_profile if you have one).`);
  return t;
}

const seg = (id) => {
  if (!ID.test(String(id ?? ""))) throw new Error(`"${id}" isn't a ClickUp id`);
  return String(id);
};

async function call(tok, io, path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await io.fetch(`${API}/${path}`, {
      method,
      headers: { Authorization: tok, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { // its text may hold the header, so none of it is shown
    throw new Error("The request to ClickUp failed before it was answered");
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (res.status === 401) throw new Error("ClickUp refused the token. Check the variable holds a current personal token.");
  if (!res.ok) throw new Error(data?.err ?? `ClickUp answered ${res.status}`);
  return data;
}

// Not "status:", which a Tracked Statuses Column uses.
const colId = (status) => `cu:${String(status).toLowerCase()}`;
const prio = (p) => (p?.id != null && /^[1-4]$/.test(String(p.id)) ? `P${p.id}` : null);
const people = (list) => (list ?? []).map((u) => ({ id: String(u.id), name: u.username || u.email || String(u.id) }));

// A List's statuses in board order.
export function mapColumns(list) {
  return [...(list?.statuses ?? [])].sort((a, b) => Number(a.orderindex) - Number(b.orderindex))
    .map((s) => ({ id: colId(s.status), name: s.status, closed: s.type === "closed" || s.type === "done" }));
}

export function mapTasks(tasks, now = Date.now()) {
  const cutoff = now - DONE_DAYS * 86400000;
  const closed = (t) => t.status?.type === "closed" || t.status?.type === "done";
  return (tasks ?? []).filter((t) => !(closed(t) && Number(t.date_closed ?? t.date_updated ?? 0) < cutoff))
    .map((t) => ({
      ref: { id: t.id },
      key: t.id, id: t.custom_id || t.id, title: t.name ?? "", type: t.parent ? "Subtask" : "Task", url: t.url ?? null,
      columnId: colId(t.status?.status ?? ""), status: t.status?.status ?? null,
      assignees: people(t.assignees), priority: prio(t.priority),
    }));
}

export function mapTicket(t, comments, ref) {
  const list = (comments?.comments ?? []).slice().sort((a, b) => Number(a.date) - Number(b.date));
  return {
    ref, key: t.id, id: t.custom_id || t.id, title: t.name ?? "", type: t.parent ? "Subtask" : "Task", url: t.url ?? null,
    column: t.status?.status ?? null, assignees: people(t.assignees), priority: prio(t.priority),
    tags: (t.tags ?? []).map((x) => x.name).filter(Boolean),
    parent: t.parent ? { id: t.parent, title: "", url: null } : null,
    description: safeMarkdown(t.markdown_description || t.text_content || t.description || ""), descriptionLabel: "Description",
    acceptanceCriteria: null,
    comments: list.map((c) => ({ author: c.user?.username ?? "", createdAt: c.date ? new Date(Number(c.date)).toISOString() : null, url: t.url ?? null, body: safeMarkdown(c.comment_text ?? "") })),
    // A full page means there may be older ones. ClickUp doesn't say how many.
    moreComments: list.length >= COMMENT_PAGE ? 1 : 0, pullRequests: [], images: [],
  };
}

export const clickup = {
  id: "clickup",
  capabilities: ["boards", "board", "ticket", "move", "update", "statuses", "signInState"],

  async signInState(account, io) {
    try { await call(await token(account, io), io, "user"); return { ok: true }; } catch (e) {
      return { ok: false, reason: String(e.message ?? e), command: null };
    }
  },

  // Every List in every Space the token can see, in folders or not.
  async boards(account, io) {
    const tok = await token(account, io);
    const teams = (await call(tok, io, "team")).teams ?? [];
    const out = [];
    await Promise.all(teams.map(async (team) => {
      const spaces = (await call(tok, io, `team/${seg(team.id)}/space?archived=false`)).spaces ?? [];
      await Promise.all(spaces.map(async (sp) => {
        const [loose, folders] = await Promise.all([
          call(tok, io, `space/${seg(sp.id)}/list?archived=false`).then((d) => d.lists ?? []).catch(() => []),
          call(tok, io, `space/${seg(sp.id)}/folder?archived=false`).then((d) => d.folders ?? []).catch(() => []),
        ]);
        for (const l of loose) out.push({ title: `${sp.name} · ${l.name}`, url: `https://app.clickup.com/${team.id}/v/li/${l.id}`, ref: { list: String(l.id), team: String(team.id) } });
        for (const f of folders) for (const l of f.lists ?? []) out.push({ title: `${sp.name} · ${f.name} · ${l.name}`, url: `https://app.clickup.com/${team.id}/v/li/${l.id}`, ref: { list: String(l.id), team: String(team.id) } });
      }));
    }));
    return out.sort((a, b) => byName(a.title, b.title));
  },

  async board(account, ref, io) {
    const tok = await token(account, io), id = seg(ref.list);
    const [list, user] = await Promise.all([call(tok, io, `list/${id}`), call(tok, io, "user")]);
    let tasks = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await call(tok, io, `list/${id}/task?page=${page}&include_closed=true&subtasks=true`);
      tasks = tasks.concat(d.tasks ?? []);
      if (d.last_page !== false || !(d.tasks ?? []).length) break;
    }
    return {
      title: list.name ?? "List", url: ref.team ? `https://app.clickup.com/${ref.team}/v/li/${id}` : null,
      me: user.user?.id != null ? String(user.user.id) : null,
      columns: mapColumns(list), tickets: mapTasks(tasks),
    };
  },

  async ticket(account, ref, io) {
    const tok = await token(account, io), id = seg(ref.id);
    const [t, c] = await Promise.all([
      call(tok, io, `task/${id}?include_markdown_description=true`),
      call(tok, io, `task/${id}/comment`).catch(() => ({ comments: [] })),
    ]);
    return mapTicket(t, c, ref);
  },

  // For Tracked Statuses (D21): the List's statuses in order.
  async statuses(account, ref, io) {
    const tok = await token(account, io);
    return mapColumns(await call(tok, io, `list/${seg(ref.list)}`)).map((c) => c.name);
  },

  async move(account, ref, target, _ticket, io) {
    const status = target.status ?? target.column?.name;
    if (!status) throw new Error("No status to move to");
    await call(await token(account, io), io, `task/${seg(ref.id)}`, { method: "PUT", body: { status } });
  },

  async update(account, ref, fields, io) {
    const name = String(fields.title ?? "").trim();
    if (!name) throw new Error("A title can't be empty");
    await call(await token(account, io), io, `task/${seg(ref.id)}`, { method: "PUT", body: { name } });
  },

  async comment(account, ref, text, io) {
    const body = String(text ?? "").trim();
    if (!body) throw new Error("Write a comment first");
    await call(await token(account, io), io, `task/${seg(ref.id)}/comment`, { method: "POST", body: { comment_text: body, notify_all: false } });
  },
};
