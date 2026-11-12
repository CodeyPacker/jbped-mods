// Local clones (#1, #14): which Pull Request repo a remote URL clones, the scan script's output, and the
// folders to scan. Pure: no imports, so it runs under node for tests.

const decode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };

// Splits a remote URL into { host, segs } (path segments, percent-decoded, without a trailing ".git"),
// or null. Takes URL forms (https://, ssh://, git://) and scp-like ones (git@host:path).
function split(url) {
  const s = String(url ?? "").trim();
  if (!s) return null;
  let host, path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!["http:", "https:", "ssh:", "git:"].includes(u.protocol)) return null;
    host = u.hostname; path = u.pathname;
  } else {
    const m = /^(?:[^@\s/:]+@)?([^:\s/]+):(.+)$/.exec(s);
    if (!m) return null;
    host = m[1]; path = m[2];
  }
  const segs = path.split("/").filter(Boolean).map(decode);
  if (!segs.length || segs.some((x) => x == null || !x.trim())) return null;
  segs[segs.length - 1] = segs[segs.length - 1].replace(/\.git$/i, "");
  if (!segs[segs.length - 1]) return null;
  return { host: host.toLowerCase(), segs };
}

// The Pull Request repo a remote URL clones: "owner/name" (GitHub) or "project/repo" (Azure DevOps), else
// null. Never throws.
export function remoteRepo(url) {
  const p = split(url);
  if (!p) return null;
  const { host, segs } = p;
  if (host === "github.com") return segs.length === 2 ? `${segs[0]}/${segs[1]}` : null;
  if (host === "dev.azure.com") return segs.length === 4 && segs[2] === "_git" ? `${segs[1]}/${segs[3]}` : null;
  if (host === "ssh.dev.azure.com") return segs.length === 4 && segs[0] === "v3" ? `${segs[2]}/${segs[3]}` : null;
  if (host.endsWith(".visualstudio.com")) {
    // project/_git/repo, or collection/project/_git/repo
    return (segs.length === 3 || segs.length === 4) && segs[segs.length - 2] === "_git" ? `${segs[segs.length - 3]}/${segs[segs.length - 1]}` : null;
  }
  return null;
}

export const sameRepo = (a, b) => typeof a === "string" && typeof b === "string" && a.length > 0 && b.length > 0 && a.toLowerCase() === b.toLowerCase();

// "<path>\t<url>\t<kind>" lines from the scan script: [{ path, url, repo, kind }], one per path. kind is
// "worktree" for a linked worktree, else "clone" (also when the column is missing or unknown).
export function parseClones(stdout) {
  const out = [], seen = new Set();
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const cols = line.split("\t");
    if (cols.length < 2 || cols.length > 3) continue;
    const path = cols[0].trim(), url = cols[1].trim(), kind = cols[2]?.trim() === "worktree" ? "worktree" : "clone";
    if (!path || !url || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, url, repo: remoteRepo(url), kind });
  }
  return out;
}

// A host-native path's parent folder, or null when it has none or the parent is a root (C:\, /, \\server\share).
function parent(p) {
  const s = String(p).trim().replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i < 0) return null;
  const dir = s.slice(0, i).replace(/[\\/]+$/, "");
  if (!dir || /^[A-Za-z]:$/.test(dir)) return null;
  if (/^\\\\/.test(dir) && dir.slice(2).split(/[\\/]+/).filter(Boolean).length <= 2) return null;
  return dir;
}

// The folders to scan besides home: the parent of each of `folders` (spaces and other Repos), once each
// ignoring case, roots dropped, at most 20, in first-seen order.
export function scanRoots({ folders = [] } = {}) {
  const out = [], seen = new Set();
  for (const f of folders) {
    if (typeof f !== "string") continue;
    const d = parent(f);
    if (!d || seen.has(d.toLowerCase())) continue;
    seen.add(d.toLowerCase());
    out.push(d);
    if (out.length >= 20) break;
  }
  return out;
}
