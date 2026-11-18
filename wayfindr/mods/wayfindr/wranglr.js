// Wranglr's worktree rule (Worktree Placement "wranglr"): where Wranglr puts a Repo's worktrees, read
// from its wranglr.json. Pure: no imports.

const baseName = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.length > 0;

export const WRANGLR_DEFAULT = ".worktrees/{branch}";

// A Repo's identity from its remote URL, else the basename of its main root. A copy of identityOf in
// Wranglr's mods/wranglr/repos.js: keep the two the same. Percent escapes (%20) are kept as written.
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

// wranglr.json's text as { worktrees, repos: { [identity]: { worktrees } } }: the setting (default
// ".worktrees/{branch}") and each Repo's own pattern. null when there is no text, it isn't JSON, or it
// isn't an object: Wranglr isn't set up. Never throws.
export function parseWranglr(text) {
  if (text == null) return null;
  let raw;
  try { raw = JSON.parse(String(text)); } catch { return null; }
  if (!isObj(raw)) return null;
  const s = isObj(raw.settings) ? raw.settings : {};
  const repos = {};
  if (isObj(raw.repos)) for (const [id, r] of Object.entries(raw.repos)) if (isObj(r) && isText(r.worktrees)) repos[id] = { worktrees: r.worktrees };
  return { worktrees: isText(s.worktrees) ? s.worktrees : WRANGLR_DEFAULT, repos };
}

// The pattern for a Repo: its own, else the setting. identity may be null.
export function wranglrPattern(cfg, identity) {
  return (identity != null ? cfg.repos[identity]?.worktrees : undefined) ?? cfg.worktrees;
}

const isAbsolute = (p) => /^(?:[\/\\]|[A-Za-z]:)/.test(p);

// The host path for a pattern: {repo} replaced by repoName, {branch} left for the script. An absolute
// pattern is used as is; a relative one goes under clonePath with . and .. resolved (never above the drive
// or root). Separators follow the clone path. A pattern without {branch} gets it as a last segment, so two
// worktrees never share a path.
export function patternPath(pattern, clonePath, repoName) {
  const clone = String(clonePath);
  const win = /^[A-Za-z]:/.test(clone) || /^\\\\/.test(clone);
  const sep = win ? "\\" : "/";
  let p = String(pattern).replaceAll("{repo}", repoName);
  const needsBranch = !p.includes("{branch}");
  if (isAbsolute(p)) return needsBranch ? p.replace(/(?<=.)[\/\\]+$/, "") + sep + "{branch}" : p;
  if (needsBranch) p += "/{branch}";
  // The clone's root: a drive, a UNC share, "/" or nothing; the rest are segments.
  const unc = /^[\/\\]{2}[^\/\\]+[\/\\][^\/\\]+/.exec(clone);
  const root = unc ? unc[0] : /^(?:[A-Za-z]:)?[\/\\]?/.exec(clone)[0];
  const out = clone.slice(root.length).split(/[\/\\]+/).filter(Boolean);
  for (const part of p.split(/[\/\\]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (out.length) out.pop(); } else out.push(part);
  }
  const head = unc ? root.replace(/[\/\\]/g, sep) + (out.length ? sep : "") : root.replace(/[\/\\]$/, sep);
  return head + out.join(sep);
}
