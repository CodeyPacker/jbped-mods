// G6: Fetch, Pull and Push in the Changes view, and the branch's ahead/behind counts.
// Every argument list is built here from constants and checked names; nothing a ref, a remote or
// git's output holds is ever read as an option. What git prints is data: capped, control
// characters dropped, never evaluated.
//
// Safety rules (each one tested in tests/sync.test.mjs):
// - Push only ever sends refs/heads/<branch> to its upstream's own branch on its upstream's own
//   remote, named explicitly (push.default, remote.<name>.push and pushRemote don't apply). No
//   force (not even a leading "+": the refspec starts with "refs/"), no tags, no submodules, no
//   --no-verify (hooks run).
// - Publish is `git push -u origin refs/heads/<b>:refs/heads/<b>`, only when a remote named
//   origin exists and the branch has no upstream.
// - Pull is fast-forward only (no merge commit, no rebase, no autostash). When it can't
//   fast-forward, git refuses and nothing changes.
// - Credentials can't be typed into a mod: git runs with GIT_TERMINAL_PROMPT=0 and no askpass,
//   so a remote that needs a password fails at once with git's own message.
import { inRepo, onWindows, ownerOf } from "./git.js";
import { exec } from "herdr";
import { nameProblem } from "./branches.js";

/** How long a fetch, pull or push may run (ms). */
export const SYNC_MS = 120000;
/** The most characters of git's message shown. */
export const MAX_MSG = 300;

/**
 * The environment every sync call runs with (through `env`, the one way a mod's exec sets one):
 * no terminal prompt, no askpass program (empty means unset to git and ssh), ssh never asks, and
 * Git Credential Manager never opens a window. Stored credentials (a credential helper) still work.
 */
export const SYNC_ENV = ["GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "SSH_ASKPASS=", "SSH_ASKPASS_REQUIRE=never", "GCM_INTERACTIVE=never"];
/** git's own askpass setting, emptied for the call (a configured core.askPass would open a window). */
export const NO_ASKPASS = ["-c", "core.askPass="];

// ---- what the branch tracks (pure) ------------------------------------------------

const FIELDS = ["%(refname)", "%(upstream)", "%(upstream:short)", "%(upstream:track,nobracket)", "%(upstream:remotename)", "%(upstream:remoteref)"];

/** git arguments reading the branch's upstream and ahead/behind from local refs (no network). */
export const infoArgs = (branch) => ["for-each-ref", `--format=${FIELDS.join("%00")}`, `refs/heads/${branch}`];
/** git arguments listing the remotes' names. */
export const REMOTES = ["remote"];

/** "ahead 2, behind 1" / "ahead 2" / "behind 1" / "" / "gone" as { ahead, behind, gone }. */
export function parseTrack(s) {
  const t = String(s ?? "").trim();
  if (t === "gone") return { ahead: 0, behind: 0, gone: true };
  const a = /ahead (\d+)/.exec(t), b = /behind (\d+)/.exec(t);
  return { ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0, gone: false };
}

/** `git remote` output as names (anything that could read as an option or a path is left out). */
export function parseRemotes(out) {
  return String(out ?? "").split(/\r?\n/).map((l) => l.trim()).filter((n) => n && remoteOk(n));
}

/** A remote name Wingman passes to git: a plain name, never an option, a path or a URL. */
export const remoteOk = (n) => typeof n === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(n) && n.length <= 100;

/**
 * The sync state of a repo from its branch (store.branchOf: "main", "@<sha>" detached, null no
 * HEAD), infoArgs' output and the remotes: { branch, detached, upstream, remote, remoteRef, ahead,
 * behind, gone, remotes, local }. `local`: the upstream is a branch of this repo (remote ".").
 */
export function parseInfo(branch, out, remotes = []) {
  const info = { branch: branch ?? null, detached: !branch || branch.startsWith("@"), upstream: null, remote: null, remoteRef: null, ahead: 0, behind: 0, gone: false, remotes, local: false };
  if (info.detached) return info;
  const line = String(out ?? "").split("\n").map((l) => l.split("\0")).find((p) => p[0] === `refs/heads/${branch}`);
  if (!line || !line[1]) return info;
  const [, , short, track, remote, remoteRef] = line;
  Object.assign(info, { upstream: short || line[1], remote: remote || null, remoteRef: remoteRef || null }, parseTrack(track));
  info.local = remote === ".";
  return info;
}

/** "↑2 ↓1", "↑2", "↓1", "" (in step), for the sync row. */
export function counts(info) {
  if (!info?.upstream || info.gone) return "";
  return [info.ahead ? `↑${info.ahead}` : "", info.behind ? `↓${info.behind}` : ""].filter(Boolean).join(" ");
}

// ---- the commands (pure) ----------------------------------------------------------

/** Why Pull or Push can't run on this state, or null. */
export function cantSync(info, what) {
  if (!info) return "Not read yet";
  if (info.detached) return info.branch ? "HEAD is detached: switch to a branch first" : "No commits yet";
  if (nameProblem(info.branch)) return `Wingman doesn't sync a branch named ${JSON.stringify(info.branch)}`;
  if (!info.upstream) return `${info.branch} has no upstream${what === "push" && info.remotes.includes("origin") ? ": Publish it" : ""}`;
  if (info.local) return `${info.branch} tracks a local branch (${info.upstream}): ${what} works with a remote`;
  if (info.gone) return `${info.upstream} is gone from the remote${what === "push" && info.remotes.includes("origin") ? ": Publish the branch again" : ""}`;
  if (!remoteOk(info.remote) || !info.remotes.includes(info.remote)) return `The upstream's remote (${info.remote ?? "none"}) isn't a remote of this repo`;
  if (!/^refs\/heads\/[^:]+$/.test(info.remoteRef ?? "")) return `The upstream (${info.upstream}) isn't a branch of ${info.remote}`;
  if (what === "push" && !info.ahead) return `Nothing to push: ${info.branch} has no commits that ${info.upstream} lacks`;
  return null;
}

/** The remote Fetch reads: the upstream's, else origin, else the only remote; null when none. */
export function fetchRemote(info) {
  if (!info) return null;
  const remotes = info.remotes.filter(remoteOk);
  if (info.remote && !info.local && remotes.includes(info.remote)) return info.remote;
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : null;
}

/** git arguments for Fetch, or throws why not. */
export function fetchArgs(info) {
  const r = fetchRemote(info);
  if (!r) throw new Error(info?.remotes?.length ? "Several remotes and no upstream: nothing to fetch from" : "This repo has no remote");
  return ["fetch", "--", r];
}

/** git arguments for Pull (fast-forward only), or throws why not. `autostash`: false for a git too old for --no-autostash. */
export function pullArgs(info, autostash = true) {
  const why = cantSync(info, "pull");
  if (why) throw new Error(why);
  return ["pull", "--ff-only", "--no-rebase", ...(autostash ? ["--no-autostash"] : []), "--", info.remote, info.remoteRef];
}

/** git arguments for Push to the upstream, or throws why not. */
export function pushArgs(info) {
  const why = cantSync(info, "push");
  if (why) throw new Error(why);
  return ["push", "--no-follow-tags", "--recurse-submodules=no", "--", info.remote, `refs/heads/${info.branch}:${info.remoteRef}`];
}

/** Why Publish can't run, or null: only a branch with no upstream (or a gone one), and only to origin. */
export function cantPublish(info) {
  if (!info) return "Not read yet";
  if (info.detached) return "HEAD is detached: switch to a branch first";
  if (nameProblem(info.branch)) return `Wingman doesn't publish a branch named ${JSON.stringify(info.branch)}`;
  if (info.upstream && !info.gone) return `${info.branch} already tracks ${info.upstream}`;
  if (!info.remotes.includes("origin")) return "This repo has no remote named origin to publish to";
  return null;
}

/** git arguments for Publish (push -u to origin, same name), or throws why not. */
export function publishArgs(info) {
  const why = cantPublish(info);
  if (why) throw new Error(why);
  return ["push", "-u", "--no-follow-tags", "--recurse-submodules=no", "--", "origin", `refs/heads/${info.branch}:refs/heads/${info.branch}`];
}

/** git arguments counting the commits Publish sends: on HEAD and on no branch of origin. */
export const unpublishedArgs = () => ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"];

/** The confirm line for Push or Publish: the remote, the branch and how many commits. */
export function confirmText(kind, info, n = info?.ahead ?? 0) {
  const c = `${n} commit${n === 1 ? "" : "s"}`;
  if (kind === "publish") return `Publish ${info.branch} to origin as origin/${info.branch} (${c}) and track it?`;
  const to = info.remoteRef.replace(/^refs\/heads\//, "");
  return `Push ${c} from ${info.branch} to ${info.remote}/${to}?${info.behind ? ` It's ${info.behind} behind: git will refuse until you pull.` : ""}`;
}

// ---- git's messages (pure) --------------------------------------------------------

/** A text git printed as one safe line: control and bidi characters dropped, capped. */
export function cleanLine(s, max = MAX_MSG) {
  const t = String(s ?? "").replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * The line of git's output that says what went wrong: the last fatal:/error: line, with the file
 * names git lists under it (indented lines, at most 5), else the last line that isn't a hint.
 */
export function errorLine(out) {
  const raw = String(out ?? "").split(/\r?\n|\r/);
  let at = -1;
  for (let i = 0; i < raw.length; i++) if (/^\s*(fatal|error):/i.test(raw[i])) at = i;
  if (at < 0) return cleanLine(raw.map((l) => l.trim()).filter((l) => l && !/^hint:/i.test(l)).at(-1) ?? "");
  const names = [];
  for (let i = at + 1; i < raw.length && /^\s+\S/.test(raw[i]); i++) names.push(raw[i].trim());
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  return cleanLine(raw[at].trim() + (names.length ? ` ${names.slice(0, 5).join(", ")}${more}` : ""));
}

const AUTH = /terminal prompts disabled|could not read (username|password)|authentication failed|permission denied \(publickey|host key verification failed|could not read from remote repository|invalid username or password|access denied|returned error: 40[13]/i;

/** The message for a failed sync step: git's own line, then what to do. */
export function failMessage(what, r) {
  if (r instanceof Error || r?.error) {
    const m = String(r.message ?? r.error ?? r);
    if (/time(d)? ?out|took longer than/i.test(m)) return `git ${what} timed out after ${SYNC_MS / 1000} s: run it once in a terminal to see what it waits for`;
    if (/not found|cannot start|no such file/i.test(m)) return `git ${what} couldn't start: ${cleanLine(m)}`;
    return `git ${what} failed: ${cleanLine(m)}`;
  }
  const out = `${r?.stderr ?? ""}\n${r?.stdout ?? ""}`, line = errorLine(r?.stderr || r?.stdout) || `exit ${r?.code}`;
  if (what === "pull" && /not possible to fast-forward|diverg/i.test(out)) return `Can't fast-forward: your branch and its upstream both have new commits. Nothing was changed (no merge, no rebase). git: ${line}`;
  if (what === "push" && /\[rejected\]|non-fast-forward|fetch first/i.test(out)) return `The remote has commits this branch doesn't: Pull first (nothing was forced). git: ${line}`;
  if (AUTH.test(out)) return `${line}. The remote needs a login Wingman can't type: run it once in a terminal (git ${what})`;
  return line;
}

/** Whether a pull failed only because this git is too old for --no-autostash (retry without). */
export const oldAutostash = (r) => /autostash/i.test(`${r?.stderr ?? ""}`) && /unknown option|only valid with|usage:/i.test(`${r?.stderr ?? ""}`);

// ---- running ------------------------------------------------------------------------

/** Git for Windows' env.exe for a `where git` path: <git>\usr\bin\env.exe (cmd\, bin\ or mingw64\bin\ git.exe). */
export function envCandidates(whereOut) {
  const out = [];
  for (const l of String(whereOut ?? "").split(/\r?\n/).map((x) => x.trim()).filter((x) => /\.exe$/i.test(x))) {
    const parts = l.replace(/\\/g, "/").split("/");
    parts.pop(); // git.exe
    for (let up = 1; up <= 2 && parts.length > up; up++) out.push(`${parts.slice(0, parts.length - up).join("/")}/usr/bin/env.exe`);
  }
  return [...new Set(out)];
}

let envExe; // Windows: the env.exe found (null: none), undefined until looked for

async function windowsEnv() {
  if (envExe !== undefined) return envExe;
  const w = await exec("where", ["git"]).catch(() => null);
  envExe = null;
  for (const c of envCandidates(w?.code === 0 ? w.stdout : "")) {
    const r = await exec(c, ["--version"], { timeout: 10000 }).catch(() => null);
    if (r?.code === 0) { envExe = c; break; }
  }
  return envExe;
}

/**
 * Runs a sync git command (argv) in store `st`'s repo, where it lives (git.js inRepo), with
 * SYNC_ENV through `env`. Windows' own git runs through Git for Windows' env.exe.
 */
export async function runSync(st, argv, timeout = SYNC_MS) {
  const on = st.on ?? null, git = ["git", ...NO_ASKPASS, ...argv];
  if (!on && onWindows() && (await ownerOf(st.root)) !== "wsl") {
    const env = await windowsEnv();
    if (!env) throw new Error("Sync needs Git for Windows' env.exe (usr\\bin\\env.exe beside git): not found");
    return inRepo(env, [...SYNC_ENV, "git", "-c", "core.filemode=false", ...NO_ASKPASS, ...argv], { cwd: st.root, timeout });
  }
  return inRepo("env", [...SYNC_ENV, ...git], { cwd: st.root, timeout, on });
}

/**
 * Reads a repo's sync state: its branch (from the HEAD file, `branch`), upstream and counts from
 * local refs, and its remotes. Two local git calls, no network. `gitRun(args)` is the store's git.
 */
export async function readInfo(gitRun, branch) {
  const detached = !branch || branch.startsWith("@");
  const [refs, rem] = await Promise.all([detached ? null : gitRun(infoArgs(branch)), gitRun(REMOTES)]);
  if (rem.code !== 0) throw new Error(`git remote: ${errorLine(rem.stderr || rem.stdout)}`);
  if (refs && refs.code !== 0) throw new Error(`git for-each-ref: ${errorLine(refs.stderr || refs.stdout)}`);
  return parseInfo(branch, refs?.stdout ?? "", parseRemotes(rem.stdout));
}
