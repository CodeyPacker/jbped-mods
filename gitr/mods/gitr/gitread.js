// Reads one Repo's git state on one Machine into plain data (GitState). parse* are pure.
import { git } from "./repos.js";

const LIMIT = 4;

// Forward slashes, no trailing slash (the root and a drive root keep theirs).
function slashes(p) {
  const s = String(p ?? "").replace(/\\/g, "/");
  return s.length > 1 && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, "") : s;
}

/** The checkouts in `git worktree list --porcelain`, in git's order: the Main checkout is first. Bare entries are left out. */
export function parseWorktrees(text) {
  const out = [];
  for (const block of String(text ?? "").split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const first = lines.find((l) => l.startsWith("worktree "));
    if (!first) continue;
    const c = { path: slashes(first.slice(9)), head: "", branch: null, detached: false, prunable: false, locked: false, bare: false };
    for (const l of lines) {
      if (l.startsWith("HEAD ")) c.head = l.slice(5).trim();
      else if (l.startsWith("branch ")) c.branch = l.slice(7).trim().replace(/^refs\/heads\//, "");
      else if (l === "detached") c.detached = true;
      else if (l === "bare") c.bare = true;
      else if (l === "prunable" || l.startsWith("prunable ")) c.prunable = true;
      else if (l === "locked" || l.startsWith("locked ")) c.locked = true;
    }
    out.push(c);
  }
  return out;
}

/** The format `parseRefs` reads: full refname, sha, short upstream, track, committer date, split by NUL. */
export const REF_FORMAT = "%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:unix)";

/** Local branches and remote branches from `git for-each-ref --format=REF_FORMAT refs/heads refs/remotes`. */
export function parseRefs(text) {
  const branches = [], remotes = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line) continue;
    const [ref, sha = "", upstream = "", track = "", date = ""] = line.split("\0");
    const when = Number(date) || 0;
    if (ref.startsWith("refs/heads/")) {
      const gone = /\[gone\]/.test(track);
      const has = upstream !== "" && !gone;
      const a = /ahead (\d+)/.exec(track), b = /behind (\d+)/.exec(track);
      branches.push({
        name: ref.slice("refs/heads/".length), sha,
        upstream: upstream || null, gone,
        ahead: has ? Number(a?.[1] ?? 0) : null, behind: has ? Number(b?.[1] ?? 0) : null,
        date: when,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      if (name.endsWith("/HEAD") || !name.includes("/")) continue;
      const i = name.indexOf("/");
      remotes.push({ name, remote: name.slice(0, i), branch: name.slice(i + 1), sha, date: when });
    }
  }
  return { branches, remotes };
}

// The message git printed, for an Error.
const said = (r) => (r.stderr || r.stdout || `git exited with code ${r.code}`).trim();

// Runs fn over items, at most `limit` at once, keeping order.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// `origin/main`, or null. Tries origin, else the first remote.
async function defaultBranchOf(main, machine) {
  const head = async (remote) => {
    const r = await git(["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`], { cwd: main, machine });
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  const viaOrigin = await head("origin");
  if (viaOrigin) return viaOrigin;
  const list = await git(["remote"], { cwd: main, machine });
  const first = list.code === 0 ? list.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) : null;
  return first && first !== "origin" ? head(first) : null;
}

// Changed lines of `git status --porcelain` in one checkout: { changes, tracked }, or nulls.
async function statusOf(path, machine) {
  try {
    const r = await git(["--no-optional-locks", "status", "--porcelain"], { cwd: path, machine });
    if (r.code !== 0) return { changes: null, tracked: null };
    const lines = r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    return { changes: lines.length, tracked: lines.filter((l) => !l.startsWith("??")).length };
  } catch {
    return { changes: null, tracked: null };
  }
}

/** The Repo without its change counts (`changes` and `tracked` are null): two fast git calls. Throws with git's message. */
export async function readRefs(main, machine = null) {
  const [wt, refs, def] = await Promise.all([
    git(["worktree", "list", "--porcelain"], { cwd: main, machine }),
    git(["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads", "refs/remotes"], { cwd: main, machine }),
    defaultBranchOf(main, machine),
  ]);
  if (wt.code !== 0) throw new Error(said(wt));
  if (refs.code !== 0) throw new Error(said(refs));
  const { branches, remotes } = parseRefs(refs.stdout);
  const checkouts = parseWorktrees(wt.stdout).filter((c) => !c.bare);
  return {
    main: slashes(main),
    defaultBranch: def,
    checkouts: checkouts.map((c, i) => ({
      path: c.path, main: i === 0, branch: c.branch, head: c.head, detached: c.detached,
      prunable: c.prunable, locked: c.locked, changes: null, tracked: null,
    })),
    branches, remotes,
    at: Date.now(),
  };
}

/** The change counts of each checkout, the Main checkout first. `onEach(path, { changes, tracked })` as each answers.
 *  A status takes seconds on a slow disk, so the caller shows the list first. */
export async function readStatuses(state, machine = null, onEach = () => {}) {
  await pool(state.checkouts.filter((c) => !c.prunable), LIMIT, async (c) => {
    const st = await statusOf(c.path, machine);
    onEach(c.path, st);
    return st;
  });
}

/** The Repo whose Main checkout is `main`, on `machine`, with change counts. Throws with git's message when it cannot be read. */
export async function readRepo(main, machine = null) {
  const state = await readRefs(main, machine);
  const got = new Map();
  await readStatuses(state, machine, (path, st) => got.set(path, st));
  return { ...state, checkouts: state.checkouts.map((c) => ({ ...c, ...(got.get(c.path) ?? {}) })), at: Date.now() };
}
