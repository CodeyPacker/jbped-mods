// W1 workspaces: the repos one Herdr space reviews. Every workspace read and write goes through
// here, so a future Herdr space with several folders means changing this file only.
//
// A workspace is a VS Code `.code-workspace` file: {"folders": [{"path": "a"}, {"path": "../b",
// "name": "b"}], "settings": {}}. Paths are relative to the file or absolute. Wayfinder's Launch
// writes one into the Ticket folder (the space's folder), one worktree per repo. Wingman reads:
// 1. a `*.code-workspace` in the space folder (the one named after the folder, else the first),
// 2. else the one Wingman made for the space: data/wingman/workspaces/<space>.code-workspace.
// A space's repos are that file's folders, plus the repos its agents started in or edited
// (spaces.json, from the Claude hook), minus the ones removed by hand (hidden.json).
// Wingman's edits change only the "folders" array, keeping every other key, comment and order.
//
// A space on another machine (`sp.machine`): its folder's workspace file is read and edited there
// (fsx, compare-and-swap), and made there when adding makes two repos, like here. Otherwise repos
// added by hand go to Wingman's own file here (data/wingman/workspaces/, holding the machine's
// paths), which is also read. Paths stay the machine's (remotePath, never hostPath), and the
// Claude hook's spaces.json isn't used for it.
import * as fs from "fs/promises";
import { readTextFile, writeTextFile, appHome } from "herdr";
import { git, hostOf } from "./git.js";
import { listDir, readText, writeText } from "./fsx.js";
import { hostPath } from "./capture.js";
import { spaceRepos } from "./journal.js";
import { remotePath } from "./remote.js";

const isWindows = (p) => /^[A-Za-z]:/.test(p);
const slash = (p) => p.replace(/\\/g, "/");
const same = (a, b) => { const x = slash(a).replace(/\/+$/, ""), y = slash(b).replace(/\/+$/, ""); return isWindows(x) || /^\/\//.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y; };
const dataDir = () => `${appHome()}/data/wingman`;
export const EXT = ".code-workspace";

// ---- the file (pure) ----------------------------------------------------------------

/** JSON with comments and trailing commas (VS Code's format) as a value. Throws on bad JSON. */
export function parseJsonc(text) {
  let out = "", i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') { const end = stringEnd(text, i); out += text.slice(i, end); i = end; }
    else if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; }
    else if (ch === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; }
    else { out += ch; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function stringEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) { if (text[j] === "\\") j++; else if (text[j] === '"') return j + 1; }
  return text.length;
}

/** [start, end) of the top-level "folders" array in the file's text, or null. */
function foldersSpan(text) {
  let depth = 0, key = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { const end = stringEnd(text, i); if (depth === 1) key = text.slice(i + 1, end - 1); i = end - 1; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (ch === "{" || ch === "[") {
      if (depth === 1 && ch === "[" && key === "folders") {
        // The matching "]".
        let d = 0;
        for (let j = i; j < text.length; j++) {
          const c = text[j];
          if (c === '"') { j = stringEnd(text, j) - 1; continue; }
          if (c === "/" && text[j + 1] === "/") { while (j < text.length && text[j] !== "\n") j++; continue; }
          if (c === "/" && text[j + 1] === "*") { const end = text.indexOf("*/", j + 2); j = end < 0 ? text.length : end + 1; continue; }
          if (c === "[" || c === "{") d++;
          else if ((c === "]" || c === "}") && --d === 0) return [i, j + 1];
        }
        return null;
      }
      depth++;
    } else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 1) key = null;
  }
  return null;
}

/** The file's indent unit: a tab (VS Code's default) unless its lines are indented with spaces. */
const indentOf = (text) => /\n( +)\S/.exec(text ?? "")?.[1] ?? "\t";

const entry = (o) => `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;

/**
 * The file's text with "folders" set to `entries` ([{ path, name? , ...}]), every other byte kept.
 * `text` null (a new file): {"folders": [...], "settings": {}}.
 */
export function withFolders(text, entries) {
  const ind = indentOf(text);
  const arr = (lead) => entries.length ? `[\n${entries.map((e) => lead + ind + entry(e)).join(",\n")}\n${lead}]` : "[]";
  if (text == null) return `{\n${ind}"folders": ${arr(ind)},\n${ind}"settings": {}\n}\n`;
  const span = foldersSpan(text);
  if (span) {
    const lineStart = text.lastIndexOf("\n", span[0]) + 1, lead = /^\s*/.exec(text.slice(lineStart))[0];
    return text.slice(0, span[0]) + arr(lead) + text.slice(span[1]);
  }
  // No "folders" key: add it first in the object.
  const open = text.indexOf("{");
  if (open < 0) throw new Error("not a workspace file");
  const rest = text.slice(open + 1), empty = /^\s*}/.test(rest);
  return `${text.slice(0, open + 1)}\n${ind}"folders": ${arr(ind)}${empty ? "\n" : ","}${empty ? rest.replace(/^\s*/, "") : rest.replace(/^[ \t]*\n?/, "\n")}`;
}

/** The file to read in a folder's file names: the one named after the folder, else the first by name. */
export function pickFile(names, folderName) {
  const list = names.filter((n) => n.toLowerCase().endsWith(EXT)).sort();
  return list.find((n) => n.slice(0, -EXT.length).toLowerCase() === folderName.toLowerCase()) ?? list[0] ?? null;
}

const isAbs = (p) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p);

/** `rel` joined to `dir`, with "." and ".." resolved. */
export function joinPath(dir, rel) {
  const s = slash(rel);
  if (isAbs(s)) return s;
  const head = /^(\/\/[^/]+\/[^/]+|[A-Za-z]:|)/.exec(slash(dir))[0];
  const parts = slash(dir).slice(head.length).split("/").filter(Boolean);
  for (const p of s.split("/")) { if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(p); }
  return `${head}/${parts.join("/")}`;
}

/** How the file at `fileDir` names `path`: relative when it's inside that folder, else absolute. */
export function relTo(fileDir, path) {
  const d = slash(fileDir).replace(/\/+$/, ""), p = slash(path);
  if (same(p, d)) return ".";
  return same(p.slice(0, d.length), d) && p[d.length] === "/" ? p.slice(d.length + 1) : p;
}

/** The workspace's folders: [{ path (as this machine opens it), name, i (index in the file) }]. */
export function foldersOf(text, fileDir, toHost = (p) => p) {
  const data = parseJsonc(text);
  if (!Array.isArray(data?.folders)) return [];
  return data.folders.map((f, i) => ({ f, i })).filter(({ f }) => typeof f?.path === "string" && f.path.trim())
    .map(({ f, i }) => ({ path: toHost(joinPath(fileDir, f.path.trim())), name: typeof f.name === "string" && f.name.trim() ? f.name.trim() : null, i }));
}

/** The branch every worktree in `branches` is on, or null (none, or they differ). */
export function sharedBranch(branches) {
  const b = branches.filter((x) => x && x !== "HEAD");
  return b.length && b.every((x) => x === b[0]) ? b[0] : null;
}

/** Where a new worktree for `repo` goes: beside the others when they share a parent folder, else null. */
export function worktreeDest(worktrees, repo) {
  const parents = worktrees.map((p) => slash(p).replace(/\/[^/]+\/?$/, ""));
  return parents.length && parents.every((p) => same(p, parents[0])) ? `${parents[0]}/${repo}` : null;
}

// ---- the file on disk ----------------------------------------------------------------

/** How a path the space names (its folder, a terminal's, a workspace folder) is opened: hostPath here, as is on another machine. */
export const pathFor = (sp) => (sp?.machine ? remotePath : hostPath);

/** The space's folder as this machine (or the space's machine) opens it, or null (none, or the home folder). */
export function spaceFolder(sp) {
  if (sp?.machine) { const f = sp.folder ? remotePath(sp.folder) : null; return f && f !== "~" && !isHome(f) ? f : null; }
  const f = sp?.folder ? hostPath(sp.folder)?.replace(/\/+$/, "") : null;
  // The home folder is where a space with no folder of its own starts: it's no workspace's folder.
  const home = slash(appHome()).replace(/\/\.config\/herdr-app\/?$/, "");
  return f && f !== "~" && !same(f, home) ? f : null;
}

/** Whether `p` is a home folder: this machine's, or a Unix or WSL user's (/home/<user>, /Users/<user>, /root). */
export function isHome(p) {
  const s = slash(p ?? "").replace(/\/+$/, ""), home = slash(appHome()).replace(/\/\.config\/herdr-app\/?$/, "");
  if (s && same(s, home)) return true;
  const rest = s.replace(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+/i, "");
  return /^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)$/i.test(rest);
}

const ownFile = (spaceId) => `${dataDir()}/workspaces/${spaceId.replace(/[^\w-]/g, "_")}${EXT}`;

// A listing is a PowerShell run on Windows (about 1 s), so a new workspace file is noticed within 30 s.
// Another machine's folder is keyed by the machine too ("<machine>\0<folder>").
const listCache = new Map(); // folder -> { at, names }
const cacheKey = (dir, on) => (on ? `${on}\0${dir}` : dir);
async function namesIn(dir, on = null) {
  const k = cacheKey(dir, on), c = listCache.get(k);
  if (c && Date.now() - c.at < 30000) return c.names;
  const names = (await listDir(dir, { on }).catch(() => ({ entries: [] }))).entries.map((e) => e.name);
  listCache.set(k, { at: Date.now(), names });
  return names;
}

// Another machine's workspace file is read at most every 30 s too (a read there is about 200 ms).
const textCache = new Map(); // "<machine>\0<file>" -> { at, text }
async function remoteText(file, on) {
  const k = cacheKey(file, on), c = textCache.get(k);
  if (c && Date.now() - c.at < 30000) return c.text;
  const text = await readText(file, { on });
  textCache.set(k, { at: Date.now(), text });
  return text;
}

/** A space on another machine: the workspace file in its folder there, or null. `fresh`: read
 *  now, not from the 30 s cache (before editing it). */
async function machineWorkspace(sp, fresh = false) {
  const folder = spaceFolder(sp);
  if (!folder) return null;
  if (fresh) listCache.delete(cacheKey(folder, sp.machine));
  const name = pickFile(await namesIn(folder, sp.machine), folder.split("/").pop() ?? "");
  if (!name) return null;
  const file = `${folder}/${name}`;
  if (fresh) textCache.delete(cacheKey(file, sp.machine));
  const text = await remoteText(file, sp.machine);
  return text != null ? { file, dir: folder, text, on: sp.machine } : null;
}

/** The space's workspace file Wingman reads and edits: { file, dir, text } or null when it has none.
 *  For a space on another machine, Wingman's own file here (machineWorkspace is the one there). */
export async function findWorkspace(sp) {
  const folder = sp.machine ? null : spaceFolder(sp);
  if (folder) {
    const name = pickFile(await namesIn(folder), folder.split("/").pop() ?? "");
    if (name) { const file = `${folder}/${name}`, text = await readTextFile(file); if (text != null) return { file, dir: folder, text }; }
  }
  const file = ownFile(sp.id), text = await readTextFile(file);
  return text != null ? { file, dir: file.replace(/\/[^/]+$/, ""), text } : null;
}

/** The workspace file's folders, or [] (no file, or it doesn't parse). On another machine: the
 *  machine's file's folders (`keep` false: removing one hides it), then Wingman's own file's. */
export async function workspaceFolders(sp) {
  const read = (ws) => { try { return ws ? foldersOf(ws.text, ws.dir, (p) => pathFor(sp)(p)) : []; } catch { return []; } };
  const own = read(await findWorkspace(sp));
  if (!sp.machine) return own;
  return [...read(await machineWorkspace(sp)).map((f) => ({ ...f, keep: false })), ...own];
}

/** Where a workspace Wingman makes for the space goes: its folder (on its machine), unless that's
 *  inside a repo or home, else Wingman's own file here. `on`: the file's machine. */
async function newFile(sp) {
  const folder = spaceFolder(sp), on = sp.machine ?? null;
  if (folder && (await git(["rev-parse", "--show-toplevel"], { cwd: folder, on }).catch((e) => { if (!on) throw e; return { code: 0 }; })).code !== 0) return { file: `${folder}/${folder.split("/").pop()}${EXT}`, on };
  return { file: ownFile(sp.id), on: null };
}

/** Writes a workspace file (compare-and-swap) where it is, and forgets the cached listing and text. */
async function writeWs(file, text, before, on) {
  if (on) await writeText(file, text, before, { on });
  else await writeTextFile(file, text, before);
  const dir = file.replace(/\/[^/]+$/, "");
  listCache.delete(cacheKey(dir, on)); textCache.delete(cacheKey(file, on));
}

/**
 * Sets the workspace's folders through `change(entries, dir)` (returns the new entries). With no
 * workspace yet, makes one holding `start` first (the repos the space shows now), and only when
 * that leaves two or more repos: one repo is a plain space. On another machine both files it reads
 * change (the one there and Wingman's own), each only when its folders do.
 */
async function editFolders(sp, start, change) {
  const files = [...(sp.machine ? [await machineWorkspace(sp, true)] : []), await findWorkspace(sp)].filter(Boolean);
  for (const ws of files) {
    const data = parseJsonc(ws.text), list = Array.isArray(data.folders) ? data.folders.filter((f) => typeof f?.path === "string") : [];
    const next = change(list, ws.dir);
    if (files.length > 1 && JSON.stringify(next) === JSON.stringify(list)) continue;
    await writeWs(ws.file, withFolders(ws.text, next), ws.text, ws.on ?? null);
  }
  if (files.length) return;
  const { file, on } = await newFile(sp), dir = file.replace(/\/[^/]+$/, "");
  const next = change(start.map((p) => ({ path: relTo(dir, p) })), dir);
  // On another machine, Wingman's own file is the only record of a repo added by hand, so one is enough there.
  if (next.length < (sp.machine && !on ? 1 : 2)) return;
  if (file.startsWith(dataDir())) await fs.mkdir(dir, { recursive: true });
  await writeWs(file, withFolders(null, next), null, on);
}

/** Adds a repo to the space's workspace (making one when this makes two repos). On another machine
 *  with both files, it goes to the machine's file (the own file keeps what it has). */
export async function addFolder(sp, root, shown) {
  await setHidden(sp.id, root, false);
  let done = false;
  await editFolders(sp, shown.filter((p) => !same(p, root)), (list, dir) => {
    if (done || list.some((f) => same(pathFor(sp)(joinPath(dir, f.path)), root))) { done = true; return list; }
    done = true;
    return [...list, { path: relTo(dir, root) }];
  });
}

/** Takes a repo out of the space: out of its workspace file(s), and hidden from what agents found. */
export async function removeFolder(sp, root) {
  if (sp.machine || (await findWorkspace(sp))) await editFolders(sp, [], (list, dir) => list.filter((f) => !same(pathFor(sp)(joinPath(dir, f.path)), root)));
  await setHidden(sp.id, root, true);
}

// ---- repos removed by hand ------------------------------------------------------------

const HIDDEN = () => `${dataDir()}/hidden.json`;

async function hidden() {
  const t = await readTextFile(HIDDEN());
  try { return { text: t, map: t ? JSON.parse(t) : {} }; } catch { return { text: t, map: {} }; }
}

async function setHidden(spaceId, root, on) {
  for (let i = 0; i < 3; i++) {
    const { text, map } = await hidden(), list = map[spaceId] ?? [];
    const has = list.some((p) => same(p, root));
    if (has === on) return;
    map[spaceId] = on ? [...list, root] : list.filter((p) => !same(p, root));
    if (!map[spaceId].length) delete map[spaceId];
    try { await writeTextFile(HIDDEN(), JSON.stringify(map, null, 2) + "\n", text); return; } catch {}
  }
}

/**
 * Folders whose repos the space reviews, in order: `start` (where its agents started), the
 * workspace file's folders, then the repos agents edited. Removed ones are left out, except
 * folders the workspace file still lists.
 */
export async function spaceRoots(sp, start = []) {
  const ws = await workspaceFolders(sp), found = sp.machine ? [] : (await spaceRepos())[sp.id] ?? [], gone = (await hidden()).map[sp.id] ?? [];
  const out = [], names = new Map();
  const add = (p, keep = false) => { if (p && !out.some((x) => same(x, p)) && (keep || !gone.some((g) => same(g, p)))) out.push(p); };
  for (const p of start) add(p);
  for (const f of ws) { add(f.path, f.keep !== false); if (f.name) names.set(slash(f.path), f.name); }
  for (const p of found) add(p);
  return { roots: out, names };
}

// ---- worktrees ----------------------------------------------------------------------

/** What a repo folder is (on machine `on`): { branch, linked (a worktree git added), common (its main clone's .git) }. */
export async function repoInfo(root, on = null) {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, on });
  const d = await git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: root, on });
  if (r.code !== 0 || d.code !== 0) return null;
  const [gitDir, common] = await Promise.all(d.stdout.trim().split(/\r?\n/).map((p) => hostOf(p, root, on)));
  return { branch: r.stdout.trim(), linked: !same(gitDir, common), common };
}

/**
 * Makes a worktree of the main clone `clone` at `dest` on `branch`: the branch when it exists,
 * else a new one from the remote's default branch (fetched first; HEAD when there's no remote).
 */
export async function addWorktree(clone, dest, branch, on = null) {
  const has = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: clone, on })).code === 0;
  let args;
  if (has) args = ["worktree", "add", dest, branch];
  else {
    await git(["fetch", "--quiet", "origin"], { cwd: clone, on, timeout: 30000 }).catch(() => null);
    const def = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], { cwd: clone, on });
    args = ["worktree", "add", "-b", branch, dest, def.code === 0 ? def.stdout.trim() : "HEAD"];
  }
  const r = await git(args, { cwd: clone, on, timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "git worktree add failed");
}

/** Deletes a linked worktree (git refuses when it has uncommitted or untracked files). `on`: on that machine. */
export async function removeWorktree(root, on = null) {
  const info = await repoInfo(root, on);
  if (!info?.linked) throw new Error(`${root} is not a linked worktree`);
  const clone = info.common.replace(/\/\.git$/, "");
  const r = await git(["worktree", "remove", root], { cwd: clone, on, timeout: 60000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "git worktree remove failed");
}

/** The git repos directly inside `parent` (folders holding a .git file or folder), sorted. `on`: on that machine. */
export async function scanRepos(parent, on = null) {
  const dir = on ? remotePath(parent) : slash(parent).replace(/\/+$/, ""), out = [];
  const { entries } = await listDir(dir, { limit: 5000, on }).catch(() => ({ entries: [] }));
  for (const name of entries.filter((e) => e.dir).map((e) => e.name).sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) continue;
    const p = `${dir}/${name}`;
    const read = (f) => (on ? readText(f, { on }) : readTextFile(f));
    if ((await read(`${p}/.git`)) != null || (await read(`${p}/.git/HEAD`)) != null) out.push(p);
  }
  return out;
}
