// The Machine boundary: everything Brunr asks of a computer. Lists and reads a Collection's files,
// checks for the Bruno CLI, runs `bru` and reads and deletes its report, starts Bruno desktop.
// Every exec, readTextFile, watchFolder and fs call of the mod is in this file.
//
// `machine` is a Machine name, or null for this computer. Paths are used as that Machine gives
// them: nothing here translates a path between Machines.
import * as fs from "fs/promises";
import { appHome, exec, home, readTextFile, watchFolder, window as hostWindow } from "herdr";
import { collectionFormat, isCollectionFile } from "./parser.js";
import { planRun } from "./plan.js";
import { readRun } from "./report.js";

const MAX_FILES = 2000;
const MAX_DEPTH = 24;
const READ_CHUNK = 200;
const CHECK_TIMEOUT = 20000;

const slash = (p) => String(p ?? "").replace(/\\/g, "/");
const join = (a, b) => `${slash(a).replace(/\/+$/, "")}/${b}`;
const on = (machine) => ({ on: machine ?? null });
const skipDir = (name) => name === "node_modules" || name.startsWith(".");

/** "windows", "macos" or "linux": this computer's platform. */
export function platform() {
  return hostWindow()?.platform ?? "linux";
}

/**
 * How `bru` is started on a Machine: `[cmd, leadingArgs]`. On Windows `bru` is an npm `.cmd`
 * shim. exec does not look up `.cmd` files by bare name, so it is named with its extension, and
 * the host quotes each argument for cmd.exe, spaces included.
 */
export function bruCommand(machine) {
  return machine == null && platform() === "windows" ? ["bru.cmd", []] : ["bru", []];
}

// Reading
//
// On this computer the folders are read with fs/promises. Herdr grants fs reads only under some
// roots (the home folder), so a folder elsewhere is listed with one exec instead: PowerShell on
// Windows, sh elsewhere. Another Machine is always listed with one sh exec. Files are read with
// readTextFile, which works anywhere.

/** A file's text, or null when it is missing or cannot be read. */
export async function readText(machine, path) {
  try { return await readTextFile(slash(path), on(machine)); } catch { return null; }
}

/** The output of one listing script as NUL-separated fields. Throws when the folder is not there. */
async function listing(machine, kind, path) {
  const useShell = machine != null || platform() !== "windows";
  const r = useShell
    ? await exec("sh", ["-c", SH[kind], "brunr", path], { on: machine ?? null, timeout: CHECK_TIMEOUT })
    : await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", powershell(PS[kind], path)], { timeout: CHECK_TIMEOUT });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `Cannot read ${path}`);
  return r.stdout.split("\0").filter(Boolean);
}

const SH = {
  // Plain file names directly in a folder.
  names: 'cd "$1" || exit 3; for f in * .[!.]* ..?*; do [ -f "$f" ] && printf "%s\\0" "$f"; done; exit 0',
  // "." when the folder is a Collection root, else the names of its child folders that are.
  roots: 'r() { [ -f "$1/opencollection.yml" ] || [ -f "$1/bruno.json" ]; }; test -d "$1" || exit 3; if r "$1"; then printf ".\\0"; exit 0; fi; cd "$1" || exit 3; for d in */; do d=${d%/}; [ -d "$d" ] && r "$d" && printf "%s\\0" "$d"; done; exit 0',
  // Every file under a folder, relative, without dot files, dot folders or node_modules.
  files: 'cd "$1" || exit 3; find . \\( -name node_modules -o -name ".?*" \\) -prune -o -type f -print0',
};

const PS = {
  names: "Get-ChildItem -LiteralPath $p -File -Force -ErrorAction Stop | ForEach-Object { $o.Write($_.Name + [char]0) }",
  roots: "$r = { param($d) (Test-Path -LiteralPath (Join-Path $d 'opencollection.yml') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $d 'bruno.json') -PathType Leaf) }; " +
    "if (-not (Test-Path -LiteralPath $p -PathType Container)) { exit 3 }; if (& $r $p) { $o.Write('.' + [char]0); exit 0 }; " +
    "Get-ChildItem -LiteralPath $p -Directory -Force -ErrorAction Stop | Where-Object { $_.Name -notlike '.*' -and (& $r $_.FullName) } | ForEach-Object { $o.Write($_.Name + [char]0) }",
  files: "if (-not (Test-Path -LiteralPath $p -PathType Container)) { exit 3 }; $script:n = 0; " +
    "function walk($d, $rel, $depth) { if ($depth -gt " + MAX_DEPTH + ") { return }; foreach ($i in Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue) { " +
    "if ($i.Name -like '.*' -or $script:n -ge " + MAX_FILES + ") { continue }; $q = if ($rel) { \"$rel/$($i.Name)\" } else { $i.Name }; " +
    "if ($i.PSIsContainer) { if ($i.Name -ne 'node_modules') { walk $i.FullName $q ($depth + 1) } } else { $script:n++; $o.Write($q + [char]0) } } }; walk $p '' 0",
};

/** A PowerShell command running `body` with `$p` set to `path` and `$o` the UTF-8 output. */
function powershell(body, path) {
  // PowerShell reads curly single quotes as quotes too, so they are doubled like '.
  const quoted = `'${String(path).replace(/['‘’‚‛]/g, "$&$&")}'`;
  return `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $o = [Console]::Out; & { param($p) ${body} } ${quoted}`;
}

/** fs/promises first; a listing exec when fs may not read there. */
async function localOr(fsWay, machine, kind, path) {
  if (machine != null) return listing(machine, kind, path);
  try { return await fsWay(); } catch { return listing(null, kind, path); }
}

/** The names of the plain files directly in a folder on this computer. [] when it cannot be read. */
export async function fileNames(dir) {
  const d = slash(dir);
  try {
    return await localOr(async () => (await fs.readdir(d, { withFileTypes: true })).filter((x) => !x.isDirectory()).map((x) => x.name), null, "names", d);
  } catch { return []; }
}

/**
 * The Collection roots a config path names: the path itself when it is a Collection root, else
 * each direct child folder that is one. Throws when the path cannot be read.
 */
export async function findRoots(machine, path) {
  const root = slash(path).replace(/\/+$/, "");
  const viaFs = async () => {
    const top = await fs.readdir(root, { withFileTypes: true });
    if (collectionFormat(top.map((d) => d.name))) return ["."];
    const out = [];
    for (const d of top) {
      if (!d.isDirectory() || skipDir(d.name)) continue;
      if (collectionFormat(await fs.readdir(join(root, d.name)).catch(() => []))) out.push(d.name);
    }
    return out;
  };
  const names = await localOr(viaFs, machine, "roots", root);
  return names.map((n) => (n === "." ? root : join(root, n)));
}

async function localNames(dir) {
  try { return await fs.readdir(dir); } catch { return []; }
}

/** Every file under a root on this computer through fs, relative, skipping dot folders and node_modules. */
async function listFs(root) {
  const out = [];
  const walk = async (rel, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    const list = await fs.readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    for (const d of list) {
      if (out.length >= MAX_FILES) return;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!skipDir(d.name)) await walk(p, depth + 1); }
      else if (!d.name.startsWith(".")) out.push(p);
    }
  };
  await walk("", 0);
  return out;
}

/** Every file under a Collection root: fs here when it may, else one exec. Dot files (.env) are never listed. */
async function listFiles(machine, root) {
  const all = await localOr(() => listFs(root), machine, "files", root);
  return all.map((p) => slash(p).replace(/^\.\//, "")).slice(0, MAX_FILES);
}

/** Reads many files on another Machine in one exec per chunk: name NUL text NUL, for each. */
async function readRemote(machine, root, paths) {
  const files = {};
  const script = 'cd "$1" || exit 3; shift; for f in "$@"; do printf "%s\\0" "$f"; cat -- "$f" 2>/dev/null; printf "\\0"; done';
  for (let i = 0; i < paths.length; i += READ_CHUNK) {
    const r = await exec("sh", ["-c", script, "brunr", root, ...paths.slice(i, i + READ_CHUNK)], { on: machine, timeout: CHECK_TIMEOUT });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `Cannot read ${root}`);
    const parts = r.stdout.split("\0");
    for (let j = 0; j + 1 < parts.length; j += 2) files[parts[j]] = parts[j + 1];
  }
  return files;
}

/**
 * The files the parser needs from one Collection, as `{ [relPath]: text }`. Only files for which
 * `isCollectionFile` is true are read, so `.env` is never opened. `{}` for a folder that is not a
 * Collection root. Throws when the root cannot be listed.
 */
export async function readCollection(machine, root) {
  const base = slash(root).replace(/\/+$/, "");
  const all = await listFiles(machine, base);
  const format = collectionFormat(all.filter((p) => !p.includes("/")));
  if (!format) return {};
  const wanted = all.filter((p) => isCollectionFile(p, format));
  if (machine != null) return readRemote(machine, base, wanted);
  const texts = await Promise.all(wanted.map((p) => readText(null, join(base, p))));
  const files = {};
  wanted.forEach((p, i) => { if (texts[i] != null) files[p] = texts[i]; });
  return files;
}

/** A pending watch on a folder on this computer: resolves with the changed paths. Has cancel(). */
export function watch(dir) {
  return watchFolder(slash(dir));
}

// The Bruno CLI

/**
 * Whether `bru` and `node` start on a Machine: `{ bru, node, step }`. `bru` and `node` are their
 * versions or null. `step` is what the person has to do, or null when `bru` runs.
 */
export async function checkCli(machine) {
  const version = async (cmd, args) => {
    try {
      const r = await exec(cmd, args, { on: machine ?? null, timeout: CHECK_TIMEOUT });
      return r.code === 0 ? (r.stdout.trim().split(/\r?\n/)[0] || "?") : null;
    } catch { return null; }
  };
  const [cmd, lead] = bruCommand(machine);
  const [bru, node] = await Promise.all([version(cmd, [...lead, "--version"]), version("node", ["--version"])]);
  return { bru, node, step: cliStep(bru, node) };
}

/** The install step for a Machine: Node first when it is missing, else the CLI. Null when `bru` runs. */
export function cliStep(bru, node) {
  if (bru) return null;
  if (!node) return { text: "Install Node.js, then the Bruno CLI: npm i -g @usebruno/cli", copy: "https://nodejs.org/en/download" };
  return { text: "Install the Bruno CLI: npm i -g @usebruno/cli", copy: "npm i -g @usebruno/cli" };
}

let counter = 0;
const unique = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Report files of earlier Runs that could not be deleted yet: `{ machine, path }`. */
const leftovers = [];

/** Where a Run's report goes: a file under the app's data folder here, `/tmp` on another Machine. */
async function reportPath(machine) {
  if (machine != null) return `/tmp/brunr-${unique()}.json`;
  const dir = join(appHome(), "data/brunr");
  await fs.mkdir(dir, { recursive: true });
  return `${dir}/run-${unique()}.json`;
}

async function readReport(machine, path) {
  try {
    if (machine == null) return await fs.readFile(path, "utf8");
    const r = await exec("cat", [path], { on: machine, timeout: CHECK_TIMEOUT });
    return r.code === 0 ? r.stdout : null;
  } catch { return null; }
}

/** Deletes a report. True when it is gone, including when it never existed. */
async function removeReport(machine, path) {
  try {
    if (machine == null) { await fs.unlink(path); return true; }
    const r = await exec("rm", ["-f", path], { on: machine, timeout: CHECK_TIMEOUT });
    return r.code === 0;
  } catch (e) {
    return machine == null && /no such file|not found|ENOENT|cannot find/i.test(String(e?.message ?? e));
  }
}

/** Retries deleting reports a timed-out `bru` may have written after its Run ended. */
export async function sweepReports() {
  for (const item of leftovers.splice(0)) if (!await removeReport(item.machine, item.path)) leftovers.push(item);
  if (leftovers.length > 20) leftovers.splice(0, leftovers.length - 20);
}

/** Deletes every report left in this computer's data folder by an earlier session. */
export async function clearLocalReports() {
  const dir = join(appHome(), "data/brunr");
  for (const name of await localNames(dir)) if (/^run-.*\.json$/.test(name)) await removeReport(null, `${dir}/${name}`);
}

const timedOutError = (e) => /time(d)? ?out/i.test(String(e?.message ?? e));

/**
 * One Run on the Collection's Machine. Plans it, runs `bru`, reads the report and deletes it,
 * whatever happened, then returns `readRun`'s result. Never throws.
 * `run`: `{ machine, collection, target, environment, globalEnvironment, workspacePath }`.
 */
export async function runBru({ machine = null, collection, target, environment = null, globalEnvironment = null, workspacePath = null }) {
  await sweepReports();
  let path = null;
  try { path = await reportPath(machine); } catch (e) {
    return readRun({ code: 1, stderr: `Cannot make a place for the report: ${e?.message ?? e}` });
  }
  const plan = planRun({ collection, target, environment, globalEnvironment, workspacePath, reportPath: path });
  const [cmd, lead] = bruCommand(machine);
  const input = { reportText: null, code: null, stdout: "", stderr: "", timedOut: false };
  try {
    const r = await exec(cmd, [...lead, ...plan.args], { cwd: plan.cwd, on: machine, timeout: plan.timeout });
    Object.assign(input, { code: r.code, stdout: r.stdout, stderr: r.stderr });
  } catch (e) {
    if (timedOutError(e)) input.timedOut = true;
    else Object.assign(input, { code: 1, stderr: `Cannot start ${cmd}: ${e?.message ?? e}` });
  }
  try {
    input.reportText = input.timedOut ? null : await readReport(machine, path);
  } finally {
    if (!await removeReport(machine, path) || input.timedOut) leftovers.push({ machine, path });
  }
  return readRun(input);
}

// Bruno desktop

/** Where Bruno desktop is installed on this computer, or null. */
export async function brunoApp() {
  const p = platform(), h = slash(home());
  const run = async (cmd, args) => { try { return await exec(cmd, args, { timeout: CHECK_TIMEOUT }); } catch { return null; } };
  if (p === "windows") {
    const dir = `${h}/AppData/Local/Programs/Bruno`;
    return (await fileNames(dir)).includes("Bruno.exe") ? `${dir}/Bruno.exe` : null;
  }
  if (p === "macos") return (await run("test", ["-d", "/Applications/Bruno.app"]))?.code === 0 ? "/Applications/Bruno.app" : null;
  const r = await run("sh", ["-c", "command -v bruno"]);
  return r?.code === 0 ? r.stdout.trim() : null;
}

/** Starts Bruno desktop, or brings it forward when it runs. False when it cannot be found. */
export async function openBruno() {
  const app = await brunoApp();
  if (!app) return false;
  const p = platform();
  if (p === "windows") await exec("cmd", ["/d", "/c", "start", "", app.replace(/\//g, "\\")], { timeout: CHECK_TIMEOUT });
  else if (p === "macos") await exec("open", [app], { timeout: CHECK_TIMEOUT });
  else await exec("sh", ["-c", '"$1" >/dev/null 2>&1 &', "brunr", app], { timeout: CHECK_TIMEOUT });
  return true;
}
