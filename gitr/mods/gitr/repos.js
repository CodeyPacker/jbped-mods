// A copy of wranglr/mods/wranglr/repos.js (branch wranglr). Keep it identical.
// Which Repo a directory is in, on one Machine. Identity is the normalised remote URL, so ssh and
// https clones, linked worktrees and copies on other Machines are the same Repo.
import { exec, window } from "herdr";

const baseName = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";

/** A Repo's identity from its remote URL, else the basename of its main root. Pure. */
export function identityOf(remoteUrl, mainRoot) {
  const u = String(remoteUrl ?? "").trim();
  if (!u) return baseName(mainRoot);
  let host = null, path;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)(.*)$/i.exec(u);
  const scp = /^(?:[^@/]+@)?([^:/\\]{2,}):(.*)$/.exec(u);
  const bare = /^[^@/]+@([^/:]+)(\/.*)$/.exec(u); // Org@dev.azure.com/Org/Proj/_git/Repo
  if (scheme) { host = scheme[1].replace(/^.*@/, "").replace(/:\d*$/, ""); path = scheme[2]; }
  else if (scp) { host = scp[1]; path = scp[2]; }
  else if (bare) { host = bare[1]; path = bare[2]; }
  else path = u.replace(/\\/g, "/"); // A local path remote.
  path = path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (host === null) return path;
  host = host.toLowerCase();
  path = path.replace(/^\/+/, "");
  // Azure DevOps: ssh.dev.azure.com/v3/Org/Proj/Repo and dev.azure.com/Org/Proj/_git/Repo.
  if (host === "ssh.dev.azure.com") { host = "dev.azure.com"; path = path.replace(/^v3\//, ""); }
  path = path.replace(/(^|\/)_git\//, "$1");
  return `${host}/${path}`;
}

// a/b/../c -> a/c, keeping a leading slash or drive.
function normalise(p) {
  const s = p.replace(/\\/g, "/"), lead = /^(?:[A-Za-z]:)?\//.exec(s)?.[0] ?? "", out = [];
  for (const part of s.slice(lead.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop(); else out.push(part);
  }
  return lead + out.join("/");
}
const isAbsolute = (p) => /^(?:[A-Za-z]:)?[\\/]/.test(p);

/** git on that Machine. On Windows here, a WSL path (starting with /) runs WSL's git through wsl.exe. */
export function git(args, { cwd, machine = null, timeout } = {}) {
  const t = timeout ? { timeout } : {};
  if (machine) return exec("git", args, { ...(cwd ? { cwd } : {}), on: machine, ...t });
  if (cwd && cwd.startsWith("/") && window().platform === "windows") return exec("wsl.exe", ["--cd", cwd, "-e", "git", ...args], t);
  return exec("git", args, { ...(cwd ? { cwd } : {}), ...t });
}

/** The Repo `dir` is in on `machine`, or null (no repo, git failed, or the Machine is unreachable). */
export async function resolveRepo(dir, machine = null) {
  try {
    const r = await git(["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd: dir, machine });
    if (r.code !== 0) return null;
    const [root, common] = r.stdout.split(/\r?\n/).map((l) => l.trim());
    if (!root || !common) return null;
    // A relative common dir is relative to the directory git ran in.
    const commonDir = normalise(isAbsolute(common) ? common : `${dir}/${common}`);
    const main = baseName(commonDir) === ".git" ? commonDir.slice(0, -"/.git".length) : root;
    // Every remote URL in config order: origin wins, else the first.
    const u = await git(["config", "--get-regexp", "^remote\\..*\\.url$"], { cwd: dir, machine });
    const urls = u.code === 0 ? u.stdout.split(/\r?\n/).map((l) => /^remote\.(.+)\.url\s+(.*)$/.exec(l.trim())).filter(Boolean) : [];
    const url = (urls.find((m) => m[1] === "origin") ?? urls[0])?.[2] ?? null;
    const identity = identityOf(url, main);
    return { identity, name: baseName(identity), root, main };
  } catch {
    return null;
  }
}

const LIMIT = 4, RETRY_MS = 60000;

/** A cache of resolveRepo by Machine and directory. At most 4 resolves run at once; nulls retry after 60 s. */
export function makeResolver({ now = Date.now } = {}) {
  const cache = new Map(); // key -> { value, at } | { running: Promise }
  const queue = [];
  let active = 0, idle = [];
  const key = (dir, machine) => `${machine ?? ""}\0${dir}`;
  const pump = () => {
    while (active < LIMIT && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => { active--; pump(); });
    }
    if (active === 0 && queue.length === 0) { const w = idle; idle = []; w.forEach((f) => f()); }
  };
  return {
    get(dir, machine) {
      const e = cache.get(key(dir, machine));
      return e && "value" in e ? e.value : e?.last;
    },
    want(dir, machine) {
      const k = key(dir, machine), e = cache.get(k);
      if (e?.running) return e.running;
      if (e && "value" in e && (e.value !== null || now() - e.at < RETRY_MS)) return Promise.resolve(e.value);
      let done;
      const running = new Promise((res) => { done = res; });
      // While a retry runs, get() still answers the last value.
      cache.set(k, { running, last: e && "value" in e ? e.value : undefined });
      queue.push(async () => {
        const value = await resolveRepo(dir, machine);
        cache.set(k, { value, at: now() });
        done(value);
      });
      pump();
      return running;
    },
    /** Resolves when no resolve is running or queued. */
    settled() {
      return active === 0 && queue.length === 0 ? Promise.resolve() : new Promise((res) => idle.push(res));
    },
  };
}
