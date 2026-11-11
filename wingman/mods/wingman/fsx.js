// File-system reads that run where a folder lives: this computer, or another machine (`on`, a
// space's machine) through herdr-core. Herdr's own fs/promises only reads granted folders here, so
// listings go through a program on the machine that holds the files:
// - Linux, macOS and any remote machine: POSIX sh.
// - A remote machine without sh: Windows, so PowerShell.
// - Windows drive paths here: PowerShell. Folders in WSL's own files: sh through wsl.exe.
// Paths are always arguments, never pasted into a shell line (PowerShell's -Command can't take
// arguments, so there the path is a single-quoted literal with its quotes doubled).
import { exec, readTextFile, writeTextFile, appHome } from "herdr";
import { inside } from "./fileops.js";
import { onWindows, toWsl, distroOf } from "./git.js";
import { byteLength, chunkBytes, sha256Hex } from "./sha256.js";
import { withTimeout, LIMITS } from "./remote.js";

// ---- paths (pure) ---------------------------------------------------------------

// head: a drive ("C:") or UNC share ("//host/share"); rooted: starts at that head or "/".
function split(p) {
  const m = /^(\/\/[^/]+\/[^/]+|[A-Za-z]:)?(\/?)(.*)$/s.exec(String(p).replace(/\\/g, "/"));
  return { head: m[1] ?? "", rooted: !!(m[1] || m[2]), rest: m[3].split("/").filter(Boolean) };
}
function format({ head, rooted, rest }) {
  if (head.startsWith("//")) return [head, ...rest].join("/");
  if (rooted) return `${head}/${rest.join("/")}`;
  return rest.join("/") || ".";
}

/** Parts joined with "/", keeping the first part's drive or UNC head; ".." is not resolved. */
export function join(...parts) {
  const [first, ...more] = parts.filter((x) => x != null && x !== "");
  if (first == null) return ".";
  const p = split(first);
  for (const m of more) p.rest.push(...String(m).replace(/\\/g, "/").split("/").filter(Boolean));
  return format(p);
}

/** The folder holding `p` ("C:/a/b" -> "C:/a"); a root is its own folder, a bare name's is ".". */
export function dirname(p) {
  const s = split(p);
  s.rest.pop();
  return format(s);
}

/** The last name in `p` ("" for a root). */
export const basename = (p) => split(p).rest.at(-1) ?? "";

// ---- where a call runs ----------------------------------------------------------

const WSL_FILES = /^(?:\/\/|\\\\)(?:wsl\.localhost|wsl\$)[\\/]/i;
const noSh = new Set(); // machines found to have no sh

/** wsl.exe's arguments that pick the distro holding `path` (none for the default distro's paths). */
export const distroArgs = (path) => { const d = distroOf(String(path ?? "")); return d ? ["-d", d] : []; };

// Calls to another machine get a time limit here too (remote.LIMITS), so a call that never answers
// fails, with a message saying so, instead of holding up every save queued behind it.
export { LIMITS };

/** exec on machine `opts.on`, with the time limit. */
export const execOn = (cmd, args, opts) => withTimeout(exec(cmd, args, opts), (opts.timeout ?? 30000) + LIMITS.grace, `${cmd} on ${opts.on}`);

/** readTextFile on machine `on` (null: here, no limit), with the time limit; rejects as readTextFile does. */
export const readOn = (path, { on = null } = {}) => (on ? withTimeout(readTextFile(path, { on }), LIMITS.read, `Reading ${path} on ${on}`) : readTextFile(path));

// Runs a POSIX sh script with `args` where `path` lives, or returns null when that is a Windows
// machine (PowerShell's turn).
async function sh(script, path, args, on) {
  if (on) {
    if (noSh.has(on)) return null;
    try { return await execOn("sh", ["-c", script, "wingman", path, ...args], { on }); }
    catch (e) {
      if (!/cannot start sh/i.test(String(e?.message ?? e))) throw e;
      noSh.add(on);
      return null;
    }
  }
  if (!onWindows()) return exec("sh", ["-c", script, "wingman", path, ...args]);
  if (!WSL_FILES.test(path)) return null;
  return exec("wsl.exe", [...distroArgs(path), "-e", "sh", "-c", script, "wingman", toWsl(path), ...args], { timeout: 15000 });
}

// "d" or "f" for a FileSystemInfo. Links keep folder attributes even when dangling, so their target
// is checked. Other reparse points (OneDrive's folders) have no LinkType and are folders. Target
// is an array in Windows PowerShell and a string in PowerShell 7, hence @(...)[0].
const KIND_FN = `function kind($i) { if (-not ($i.Attributes -band 16)) { 'f' } elseif (-not ($i.Attributes -band 1024) -or -not $i.LinkType) { 'd' } elseif (($t = @($i.Target)[0]) -and [IO.Directory]::Exists([IO.Path]::Combine([IO.Path]::GetDirectoryName($i.FullName), $t))) { 'd' } else { 'f' } }`;

// Runs a PowerShell block taking `param($p)`, with `path` as its single-quoted argument. Plain .NET
// rather than cmdlets: Get-ChildItem and ConvertTo-Json add hundreds of ms to each call.
function ps(block, path, on) {
  // Windows PowerShell otherwise writes the console code page; exec decodes UTF-8. PowerShell
  // reads curly single quotes as quotes too, so they're doubled like '.
  const lit = "'" + path.replace(/\//g, "\\").replace(/['‘’‚‛]/g, "$&$&") + "'";
  const args = ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${KIND_FN}; & { param($p) ${block} } ${lit}`];
  return on ? execOn("powershell", args, { on }) : exec("powershell", args);
}

const firstLine = (s) => String(s ?? "").trim().split(/\r?\n/)[0].trim();

// ---- listing --------------------------------------------------------------------

// $1 folder, $2 the most entries to print (one more than the limit, to tell there are more).
// Each entry is "d" or "f", then its name, NUL-separated. -d follows links, so a link to a folder
// is "d" and a dangling one "f".
const LIST_SH = `[ -d "$1" ] || { echo "Not a folder: $1" >&2; exit 2; }
[ -r "$1" ] && [ -x "$1" ] || { echo "Permission denied: $1" >&2; exit 2; }
n=0
for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do
  [ -e "$p" ] || [ -L "$p" ] || continue
  name=\${p##*/}
  [ "$name" = .git ] && continue
  if [ -d "$p" ]; then k=d; else k=f; fi
  printf '%s\\0%s\\0' "$k" "$name"
  n=$((n+1)); [ "$n" -ge "$2" ] && break
done
exit 0`;

// The same output from PowerShell.
const listPs = (max) => `$d = [IO.DirectoryInfo]::new($p); if (-not $d.Exists) { throw "Not a folder: $p" }
$o = [Text.StringBuilder]::new(); $n = 0
foreach ($i in $d.EnumerateFileSystemInfos()) { if ($i.Name -eq '.git') { continue }; [void]$o.Append((kind $i)).Append([char]0).Append($i.Name).Append([char]0); if (++$n -ge ${max}) { break } }
[Console]::Out.Write($o.ToString())`;

/** A folder's entries, without ".git": { entries: [{ name, dir }], more } (more: there were over `limit`). Unsorted. */
export async function listDir(dir, { on = null, limit = 500 } = {}) {
  const max = Math.max(0, Math.floor(limit)) + 1;
  const r = (await sh(LIST_SH, dir, [String(max)], on)) ?? (await ps(listPs(max), dir, on));
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || `Cannot list ${dir}`);
  const f = r.stdout.split("\0"), entries = [];
  for (let i = 0; i + 1 < f.length; i += 2) entries.push({ name: f[i + 1], dir: f[i] === "d" });
  return { entries: entries.slice(0, max - 1), more: entries.length >= max };
}

// ---- single paths ---------------------------------------------------------------

const KIND_SH = `if [ -d "$1" ]; then echo d; elif [ -e "$1" ] || [ -L "$1" ]; then echo f; fi`;
// A DirectoryInfo reads any path's attributes: -1 when it is absent.
const KIND_PS = `$i = [IO.DirectoryInfo]::new($p); if ([int]$i.Attributes -ne -1) { kind $i }`;

/** "dir", "file" or null (absent). A link counts as what it points to; a dangling one is a file. */
export async function pathKind(path, { on = null } = {}) {
  try {
    const r = (await sh(KIND_SH, path, [], on)) ?? (await ps(KIND_PS, path, on));
    const k = r.code === 0 ? r.stdout.trim() : "";
    return k === "d" ? "dir" : k === "f" ? "file" : null;
  } catch { return null; }
}

/** UTF-8 text or null when absent/unreadable. */
export async function readText(path, { on = null } = {}) {
  return (await readOn(path, { on }).catch(() => null)) ?? null;
}

// ---- writing --------------------------------------------------------------------
// This computer: Herdr's writeTextFile (compare-and-swap, atomic) and the OS's rm and mkdir.
// Another machine: a mod's exec has no stdin and Herdr has no remote write, so the content goes as
// arguments to a POSIX sh script there (byte exact: the shell never parses arguments). It's written
// to a temp file beside the target, the target's SHA-256 is compared with the hash of `expected`
// made here, and the temp file is renamed over the target. Content over one call's size goes in
// pieces appended to the temp file first. A failed or abandoned write removes its temp file
// (`.wingman-<token>.tmp`, a name a later cleanup can find) and never leaves a half-written target.

export const STALE = "changed since it was read";
const staleError = (path) => new Error(`${path} ${STALE}; reload and try again`);
export const WINDOWS_NOTE = "Saving on a Windows machine isn't supported yet";

const isDrive = (p) => /^[A-Za-z]:/.test(p);

// Windows drive and share paths here go to PowerShell as quoted literals (psWith), never through
// cmd: cmd /c reads a path's , ; = ^ & % as its own syntax, so a name could delete or make another.
const winHere = (path) => isDrive(path) || (onWindows() && /^\/\/[^/]/.test(path) && !WSL_FILES.test(path));
const MKDIR_PS = `try { [void][IO.Directory]::CreateDirectory($p); 'ok' } catch { wmWhy $_ }`;

/** Deletes a file here (Windows drive and WSL paths included). */
async function removeHere(path) {
  if (winHere(path)) {
    const r = await psWith(OPS_PS.rm, [path, "", ""], null), line = firstLine(r.stdout);
    if (line !== "ok" && line !== "missing") throw new Error(`delete ${path}: ${line.replace(/^error /, "") || (r.stderr || "").trim() || `exit ${r.code}`}`);
    return;
  }
  const r = WSL_FILES.test(path) ? await exec("wsl.exe", [...distroArgs(path), "-e", "rm", "-f", "--", toWsl(path)]) : await exec("rm", ["-f", "--", path]);
  if (r.code !== 0) throw new Error(`delete ${path}: ${(r.stderr || r.stdout).trim()}`);
}

/** Creates a folder and its parents here. Mods may only write under ~/.config/herdr-app through
 *  fs/promises, so folders inside a repo are made by the OS's own mkdir (.NET's on Windows). */
async function makeDirHere(path) {
  if (winHere(path)) {
    const r = await psWith(MKDIR_PS, [path, "", ""], null), line = firstLine(r.stdout);
    if (line !== "ok") throw new Error(`mkdir ${path}: ${line.replace(/^error /, "") || (r.stderr || "").trim() || `exit ${r.code}`}`);
    return;
  }
  const r = WSL_FILES.test(path) ? await exec("wsl.exe", [...distroArgs(path), "-e", "mkdir", "-p", "--", toWsl(path)]) : await exec("mkdir", ["-p", "--", path]);
  if (r.code !== 0) throw new Error(`mkdir ${path}: ${(r.stderr || r.stdout).trim()}`);
}

// The machine's write script. $1 step, $2 path, $3 temp token, $4 expected: a SHA-256 in hex,
// "absent" (only if there's no file) or "-" (no check: steps that only build the temp file);
// $5... the content's pieces, printed back to back.
// Steps: put (whole content, check, rename), start / add (create / append the temp file),
// end (append the last piece, check, rename), drop (remove the temp file), rm (delete if it matches).
// Output: "ok", "stale <hash|present|absent>" (exit 10) or "error <what>" (exit 3).
// Portable: dash, bash, busybox and macOS sh; sha256sum, else shasum -a 256, else openssl;
// GNU stat -c, else BSD stat -f for the mode. A link is followed to the file it names (rm deletes
// the link itself), and the file's mode is kept.
export const WRITE_SH = `op=$1 p=$2 k=$3 h=$4
shift 4
if [ "$op" != rm ]; then
  n=0
  while [ -L "$p" ] && [ "$n" -lt 40 ]; do
    l=$(readlink -- "$p") || break
    case $l in /*) p=$l ;; *) p=\${p%/*}/$l ;; esac
    n=$((n+1))
  done
fi
t=\${p%/*}/.wingman-$k.tmp
fail() { [ "$op" = rm ] || rm -f -- "$t"; echo "error $1"; exit 3; }
case $op in
  drop) rm -f -- "$t"; echo ok; exit 0 ;;
  start) printf %s "$@" > "$t" || fail "cannot write beside $p"; echo ok; exit 0 ;;
  add) [ -f "$t" ] || fail "the temp file went"; printf %s "$@" >> "$t" || fail "cannot write beside $p"; echo ok; exit 0 ;;
  put) printf %s "$@" > "$t" || fail "cannot write beside $p" ;;
  end) [ -f "$t" ] || fail "the temp file went"; printf %s "$@" >> "$t" || fail "cannot write beside $p" ;;
  rm) ;;
  *) fail "unknown step $op" ;;
esac
if [ -e "$p" ] || [ -L "$p" ]; then
  if [ "$h" = absent ]; then cur=present
  else
    if command -v sha256sum >/dev/null 2>&1; then cur=$(sha256sum < "$p")
    elif command -v shasum >/dev/null 2>&1; then cur=$(shasum -a 256 < "$p")
    elif command -v openssl >/dev/null 2>&1; then cur=$(openssl dgst -sha256 -r < "$p")
    else fail "no sha256sum, shasum or openssl on this machine"; fi || fail "cannot read $p"
    cur=\${cur%% *}
  fi
  if [ "$cur" != "$h" ]; then [ "$op" = rm ] || rm -f -- "$t"; echo "stale $cur"; exit 10; fi
  if [ "$op" = rm ]; then rm -f -- "$p" || fail "cannot delete $p"; echo ok; exit 0; fi
  m=$(stat -c %a -- "$p" 2>/dev/null || stat -f %Lp -- "$p" 2>/dev/null) && chmod "$m" "$t" 2>/dev/null
  mv -f -- "$t" "$p" || fail "cannot replace $p"
else
  if [ "$h" != absent ]; then [ "$op" = rm ] || rm -f -- "$t"; echo "stale absent"; exit 10; fi
  [ "$op" = rm ] && { echo ok; exit 0; }
  # ln fails when the target exists, so creating is race free; mv is for file systems without links.
  if ln -- "$t" "$p" 2>/dev/null; then rm -f -- "$t"
  elif [ -e "$p" ]; then rm -f -- "$t"; echo "stale present"; exit 10
  else mv -f -- "$t" "$p" || fail "cannot create $p"; fi
fi
echo ok`;

// What one call may carry. Proven safe on every route: 30000 bytes in all, script and path included,
// counting each " and \\ twice (a Windows command line, about 32 K, escapes them when a machine is
// reached through a Windows program).
// Where the arguments go straight to the machine's execve, one call carries up to 1 MB in
// arguments of 100000 bytes (Linux allows 131071 per argument, about 2 MB in all).
export const SAFE_CALL = 30000, BIG_CALL = 1000000, BIG_ARG = 100000;
const callSize = new Map(); // machine -> bytes per call, once proven

/** The cost of a piece of content on the safe route: UTF-8 bytes, plus one per " and \\. */
const safeCost = (s) => byteLength(s) + (s.match(/["\\]/g)?.length ?? 0);

/** Bytes one call to `on` may carry (the probe's answer, else the safe size). For tests: `set`. */
export function callBytes(on, set) {
  if (set !== undefined) { if (set) callSize.set(on, set); else callSize.delete(on); }
  return callSize.get(on) ?? SAFE_CALL;
}

/**
 * Proves once per machine whether a 1 MB call gets through: `wc -c` counts it there, and nothing
 * is written. Asked only when a write is over the safe size; a failure keeps the safe size.
 */
async function proveBig(on) {
  if (callSize.has(on)) return callSize.get(on);
  let size = SAFE_CALL;
  try {
    const piece = "w".repeat(BIG_ARG), n = BIG_CALL / BIG_ARG;
    const r = await execOn("sh", ["-c", 'printf %s "$@" | wc -c', "wingman", ...Array(n).fill(piece)], { on, timeout: 20000 });
    if (r.code === 0 && Number(r.stdout.trim()) === BIG_CALL) size = BIG_CALL;
  } catch {}
  callSize.set(on, size);
  return size;
}

/** Runs WRITE_SH on machine `on`; a machine without sh is a Windows machine. */
async function writeSh(on, args, timeout = 60000) {
  if (noSh.has(on)) throw new Error(WINDOWS_NOTE);
  try { return await execOn("sh", ["-c", WRITE_SH, "wingman", ...args], { on, timeout }); }
  catch (e) {
    if (!/cannot start sh/i.test(String(e?.message ?? e))) throw e;
    noSh.add(on);
    throw new Error(WINDOWS_NOTE);
  }
}

/** The calls' content pieces for `text`: each call's list of arguments. */
async function plan(text, path, on) {
  if (!text) return [[]];
  const budget = SAFE_CALL - safeCost(WRITE_SH) - safeCost(path) - 200;
  if (safeCost(text) <= budget) return [[text]];
  const size = await proveBig(on);
  if (size === SAFE_CALL) return chunkBytes(text, budget, safeCost).map((p) => [p]);
  // Big calls: arguments of at most BIG_ARG bytes, as many as fit in one call.
  const pieces = chunkBytes(text, BIG_ARG), calls = [];
  let cur = [], bytes = 0;
  for (const p of pieces) {
    const b = byteLength(p);
    if (cur.length && bytes + b > size) { calls.push(cur); cur = []; bytes = 0; }
    cur.push(p); bytes += b;
  }
  calls.push(cur);
  return calls;
}

/** "absent" for null, else the hex SHA-256 of the text as UTF-8. */
const hashOf = async (expected) => (expected === null ? "absent" : await sha256Hex(expected));

const outcome = (r) => firstLine(r.stdout);

/**
 * A stale answer from the machine, explained: when the file still reads back as `expected`, its
 * bytes aren't what that text encodes to (a byte-order mark the read dropped, bytes that aren't
 * UTF-8), and writing would change bytes nobody edited, so that's refused instead.
 */
async function staleOrForeign(path, expected, on) {
  if (expected !== null) {
    const again = await readOn(path, { on }).catch(() => undefined);
    if (again === expected) return new Error(`${basename(path)} isn't plain UTF-8 text (a byte-order mark, or bytes that aren't UTF-8): Wingman doesn't save it on another machine, so bytes you didn't edit stay as they are`);
  }
  return staleError(path);
}

const token = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Writes `text` to `path` only if the file still has the content `expected` (null: only if absent).
 * Local: writeTextFile. On another machine: a temp file beside the target, a hash check, then an
 * atomic rename. Rejects with an Error whose message contains "changed since it was read" when the
 * check fails (the same wording store.js's swap uses), so callers treat local and remote alike.
 */
export async function writeText(path, text, expected, { on = null } = {}) {
  if (!on) {
    const now = await readTextFile(path);
    if (now !== expected) throw staleError(path);
    await writeTextFile(path, text, expected);
    return;
  }
  const [want, calls] = await Promise.all([hashOf(expected), plan(text, path, on)]), k = token();
  if (calls.length === 1) {
    const r = await writeSh(on, ["put", path, k, want, ...calls[0]]);
    if (r.code === 10) throw await staleOrForeign(path, expected, on);
    if (r.code !== 0) throw new Error(`save ${path}: ${outcome(r).replace(/^error /, "") || (r.stderr || "").trim() || `exit ${r.code}`}`);
    return;
  }
  // In pieces: build the temp file, then check and rename with the last piece.
  let r = null;
  try {
    for (let i = 0; i < calls.length; i++) {
      const step = i === 0 ? "start" : i === calls.length - 1 ? "end" : "add";
      r = await writeSh(on, [step, path, k, i === calls.length - 1 ? want : "-", ...calls[i]]);
      if (r.code !== 0) break;
    }
  } catch (e) {
    await writeSh(on, ["drop", path, k, "-"]).catch(() => {});
    throw e;
  }
  if (r.code === 10) throw await staleOrForeign(path, expected, on);
  if (r.code !== 0) {
    await writeSh(on, ["drop", path, k, "-"]).catch(() => {});
    throw new Error(`save ${path}: ${outcome(r).replace(/^error /, "") || (r.stderr || "").trim() || `exit ${r.code}`}`);
  }
}

/** Deletes a file only if it still has the content `expected` (null: there's nothing to delete). */
export async function removeFile(path, expected, { on = null } = {}) {
  if (!on) {
    const now = await readTextFile(path);
    if (now !== expected) throw staleError(path);
    if (expected !== null) await removeHere(path);
    return;
  }
  const r = await writeSh(on, ["rm", path, token(), await hashOf(expected)]);
  if (r.code === 10) throw await staleOrForeign(path, expected, on);
  if (r.code !== 0) throw new Error(`delete ${path}: ${outcome(r).replace(/^error /, "") || (r.stderr || "").trim()}`);
}

/** Creates a folder and its parents. */
export async function makeDir(path, { on = null } = {}) {
  if (!on) return makeDirHere(path);
  if (noSh.has(on)) throw new Error(WINDOWS_NOTE);
  let r;
  try { r = await execOn("mkdir", ["-p", "--", path], { on }); }
  catch (e) { throw /cannot start mkdir/i.test(String(e?.message ?? e)) ? new Error(WINDOWS_NOTE) : e; }
  if (r.code !== 0) throw new Error(`mkdir ${path}: ${(r.stderr || r.stdout).trim()}`);
}

// ---- the Explorer's file operations -----------------------------------------------
// Create, rename or move, delete, each confined to a root folder (`root`): every path must be
// strictly inside it (fileops.inside: no "..", nothing in .git, never the root itself), checked here
// and, for a recursive delete, again by the script. Where they run:
// - Linux, macOS and another machine: OPS_SH with the paths as arguments.
// - Windows drive and share paths here: PowerShell with each path as a quoted literal (OPS_PS).
// - WSL's own files from Windows: OPS_SH through wsl.exe, with WSL paths.
// - A Windows machine elsewhere (no sh): refused with WINDOWS_NOTE.
// The answer is one line: "ok", "exists", "missing", or "error <why>".

// $1 the step, then its paths. A create is "only if absent" (noclobber's exclusive create); a move
// refuses an existing target (checked just before mv: a target appearing in between is the one
// window) and goes through a temp name when only letter case changes on a case-insensitive file
// system (`$4` = 1 and both names are the same file); rmtree also takes the root and refuses
// anything not under it, "/" and a home folder or one above it.
export const OPS_SH = `op=$1; shift
ex() { [ -e "$1" ] || [ -L "$1" ]; }
say() { printf '%s\\n' "$*"; exit 0; }
mkparent() { d=\${1%/*}; [ -z "$d" ] || [ -d "$d" ] || e=$(mkdir -p -- "$d" 2>&1) || say "error $e"; }
case $op in
  file)
    ex "$1" && say exists
    mkparent "$1"
    if (set -C; : > "$1") 2>/dev/null; then say ok; fi
    ex "$1" && say exists
    say "error cannot create $1" ;;
  dir)
    ex "$1" && say exists
    e=$(mkdir -p -- "$1" 2>&1) || say "error $e"
    say ok ;;
  mv)
    ex "$1" || say missing
    if ex "$2"; then
      [ "$3" = 1 ] && [ "$1" -ef "$2" ] || say exists
      t=\${1%/*}/.wingman-rename-$$
      ex "$t" && say "error $t is in the way"
      e=$(mv -- "$1" "$t" 2>&1) || say "error $e"
      if e=$(mv -- "$t" "$2" 2>&1); then say ok; fi
      mv -- "$t" "$1"; say "error $e"
    fi
    mkparent "$2"
    e=$(mv -- "$1" "$2" 2>&1) || say "error $e"
    say ok ;;
  rm)
    [ -d "$1" ] && [ ! -L "$1" ] && say "error $1 is a folder"
    ex "$1" || say missing
    e=$(rm -f -- "$1" 2>&1) || say "error $e"
    say ok ;;
  rmtree)
    case \${2%/} in ''|/mnt|/mnt/[a-zA-Z]|/home|/Users) say "error refusing to delete inside $2" ;; esac
    case $1 in "$2"/?*) ;; *) say "error $1 isn't inside $2" ;; esac
    case $1 in /|'') say "error refusing to delete $1" ;; esac
    h=\${HOME%/}
    [ -n "$h" ] && case $h/ in "\${1%/}"/*) say "error refusing to delete a home folder or one above it" ;; esac
    ex "$1" || say missing
    if [ -L "$1" ]; then e=$(rm -f -- "$1" 2>&1) || say "error $e"; say ok; fi
    [ -d "$1" ] || say "error $1 isn't a folder"
    e=$(rm -rf -- "$1" 2>&1) || say "error $e"
    ex "$1" && say "error $1 is still there"
    say ok ;;
  *) say "error unknown step $op" ;;
esac`;

// The same steps in PowerShell, each a block taking param($p, $q, $c): plain .NET. File.Move and
// Directory.Move never replace a target; a case-only rename goes through a temp name (and back if the
// second step fails). A recursive delete walks the folder itself, clearing read-only attributes (git's
// objects have them), and removes a junction or folder link as a link, never walking into it
// (Windows PowerShell's Directory.Delete(path, true) refuses a junction inside: access denied).
// Helper names start with wm: a plain name can be a built-in alias (del is Remove-Item), and aliases win.
const PS_FN = `function wmEx($x) { [IO.File]::Exists($x) -or [IO.Directory]::Exists($x) }; function wmWhy($e) { $i = $e.Exception; while ($i.InnerException) { $i = $i.InnerException }; 'error ' + $i.Message }`;
const OPS_PS = {
  file: `if (wmEx $p) { 'exists'; return }; try { [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p)); $s = [IO.File]::Open($p, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write); $s.Close(); 'ok' } catch { if (wmEx $p) { 'exists' } else { wmWhy $_ } }`,
  dir: `if (wmEx $p) { 'exists'; return }; try { [void][IO.Directory]::CreateDirectory($p); 'ok' } catch { wmWhy $_ }`,
  mv: `$d = [IO.Directory]::Exists($p); if (-not ($d -or [IO.File]::Exists($p))) { 'missing'; return }
if ($c -ne '1' -and (wmEx $q)) { 'exists'; return }
$t = $null
try {
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($q))
  if ($c -eq '1') { $t = [IO.Path]::Combine([IO.Path]::GetDirectoryName($p), '.wingman-rename-' + [Guid]::NewGuid().ToString('N')); if ($d) { [IO.Directory]::Move($p, $t); [IO.Directory]::Move($t, $q) } else { [IO.File]::Move($p, $t); [IO.File]::Move($t, $q) }; 'ok' }
  elseif ($d) { [IO.Directory]::Move($p, $q); 'ok' } else { [IO.File]::Move($p, $q); 'ok' }
} catch {
  $r = wmWhy $_
  if ($t -and (wmEx $t)) { try { if ($d) { [IO.Directory]::Move($t, $p) } else { [IO.File]::Move($t, $p) } } catch {} }
  if ($c -ne '1' -and (wmEx $q) -and (wmEx $p)) { 'exists' } else { $r }
}`,
  rm: `if ([IO.Directory]::Exists($p)) { "error $p is a folder"; return }; if (-not [IO.File]::Exists($p)) { 'missing'; return }
try { $i = [IO.FileInfo]::new($p); if ($i.Attributes -band 1) { $a = [int]$i.Attributes -band -2; if (-not $a) { $a = 128 }; $i.Attributes = [IO.FileAttributes]$a }; [IO.File]::Delete($p); 'ok' } catch { wmWhy $_ }`,
  rmtree: `$f = [IO.Path]::GetFullPath($p).TrimEnd('\\'); $r = [IO.Path]::GetFullPath($q).TrimEnd('\\')
if ($r -ieq [IO.Path]::GetPathRoot($r).TrimEnd('\\')) { "error refusing to delete inside $r"; return }
if (-not $f.StartsWith($r + '\\', [StringComparison]::OrdinalIgnoreCase)) { "error $f isn't inside $r"; return }
if ($f -ieq [IO.Path]::GetPathRoot($f).TrimEnd('\\')) { "error refusing to delete a drive's root"; return }
$h = [Environment]::GetFolderPath('UserProfile').TrimEnd('\\')
if ($h -and ($h -ieq $f -or $h.StartsWith($f + '\\', [StringComparison]::OrdinalIgnoreCase))) { 'error refusing to delete a home folder or one above it'; return }
$d = [IO.DirectoryInfo]::new($f)
if (-not $d.Exists) { if ([IO.File]::Exists($f)) { "error $f isn't a folder" } else { 'missing' }; return }
function wmRw($i) { if ($i.Attributes -band 1) { $a = [int]$i.Attributes -band -2; if (-not $a) { $a = 128 }; $i.Attributes = [IO.FileAttributes]$a } }
function wmDel($x) { foreach ($i in $x.EnumerateFileSystemInfos()) { wmRw $i; if (($i.Attributes -band 16) -and -not ($i.Attributes -band 1024)) { wmDel $i } else { $i.Delete() } }; wmRw $x; $x.Delete() }
try { if ($d.Attributes -band 1024) { $d.Delete() } else { wmDel $d }; 'ok' } catch { wmWhy $_ }`,
};

/** A PowerShell block with params ($p, $q, $c) given as single-quoted literals (see ps). */
function psWith(block, args, on) {
  const lit = (s) => "'" + String(s).replace(/\//g, "\\").replace(/['‘’‚‛]/g, "$&$&") + "'";
  return exec("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${PS_FN}; & { param($p, $q, $c) ${block} } ${args.map(lit).join(" ")}`], { on, timeout: OPS_MS });
}

const OPS_MS = 300000; // a large folder's delete can take minutes on a Windows drive

/**
 * Whether `p` is a folder no project is: "/", a drive or share root, /mnt or /mnt/<letter>, a WSL
 * distro's root, the folder that holds home folders, or a well-known system folder ("/usr",
 * "C:/Windows", "/mnt/c/Program Files"). Such a root is only there because a terminal sits in it.
 */
export function systemFolder(p) {
  let s = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+/i, "");
  if (s === "" || /^\/\/[^/]+(?:\/[^/]+)?$/.test(s)) return true;
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(s);
  if (mnt) s = `${mnt[1]}:${mnt[2] ?? ""}`;
  if (/^[A-Za-z]:(?:\/(?:Users|Windows|Program Files|Program Files \(x86\)|ProgramData))?$/i.test(s)) return true;
  return /^\/(?:mnt|home|Users|usr|etc|var|bin|sbin|lib|lib32|lib64|libx32|opt|boot|proc|sys|dev|run|srv|snap|System|Library|Applications|private|Volumes)$/.test(s);
}

/** Runs one step where `root` lives; resolves with the answer line. */
async function runOp(op, root, paths, extra, on) {
  if (systemFolder(root)) throw new Error(`File operations aren't available in ${root}: open a project folder`);
  for (const p of paths) if (!inside(p, root)) throw new Error(`${p} isn't inside ${root}`);
  const args = [...paths, ...extra];
  let r;
  if (on) {
    if (noSh.has(on)) throw new Error(WINDOWS_NOTE);
    try { r = await execOn("sh", ["-c", OPS_SH, "wingman", op, ...args], { on, timeout: OPS_MS }); }
    catch (e) {
      if (!/cannot start sh/i.test(String(e?.message ?? e))) throw e;
      noSh.add(on);
      throw new Error(WINDOWS_NOTE);
    }
  } else if (!onWindows()) r = await exec("sh", ["-c", OPS_SH, "wingman", op, ...args], { timeout: OPS_MS });
  else if (WSL_FILES.test(root)) {
    const wsl = (a) => (WSL_FILES.test(a) ? toWsl(a) : a);
    r = await exec("wsl.exe", [...distroArgs(root), "-e", "sh", "-c", OPS_SH, "wingman", op, ...args.map(wsl)], { timeout: OPS_MS });
  } else {
    const [p, q = "", c = ""] = op === "rmtree" ? [paths[0], extra[0]] : op === "mv" ? [paths[0], paths[1], extra[0]] : [paths[0]];
    r = await psWith(OPS_PS[op], [p, q, c], null);
  }
  const line = firstLine(r.stdout);
  if (!line) throw new Error((r.stderr || "").trim() || `exit ${r.code}`);
  return line;
}

/** "ok" passes; the rest become errors naming `path` ("already exists", "no longer exists", the reason). */
function answer(line, path) {
  if (line === "ok") return;
  const name = basename(path) || path;
  const e = new Error(line === "exists" ? `${name} already exists` : line === "missing" ? `${name} no longer exists` : line.replace(/^error /, ""));
  e.code = line === "exists" || line === "missing" ? line : "error";
  throw e;
}

/** Creates an empty file only if nothing is at `path` (its folders as needed). */
export async function createFile(path, root, { on = null } = {}) { answer(await runOp("file", root, [path], [], on), path); }

/** Creates a folder (and its parents) only if nothing is at `path`. */
export async function createDir(path, root, { on = null } = {}) { answer(await runOp("dir", root, [path], [], on), path); }

/**
 * Renames or moves `from` to `to` (a file or a folder), refusing when something is already at `to`.
 * A rename that only changes letter case works on case-insensitive file systems (Windows, macOS).
 */
export async function movePath(from, to, root, { on = null } = {}) {
  const caseOnly = from !== to && from.toLowerCase() === to.toLowerCase();
  answer(await runOp("mv", root, [from, to], [caseOnly ? "1" : "0"], on), to);
}

/** Deletes a file (or a link), never a folder. */
export async function deleteFile(path, root, { on = null } = {}) { answer(await runOp("rm", root, [path], [], on), path); }

const HOMEISH = /^(?:\/home|\/Users|\/root|[A-Za-z]:\/Users|\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/i;

/**
 * Deletes a folder and everything in it, permanently. Refused unless `path` is strictly inside
 * `root`, and for "/", a drive's root, a home folder or a folder above one. A link to a folder is
 * removed as a link.
 */
export async function deleteTree(path, root, { on = null } = {}) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, ""), s = p.replace(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+/i, "");
  if (!p || s === "" || /^[A-Za-z]:$/.test(p) || HOMEISH.test(s) || systemFolder(p)) throw new Error(`refusing to delete ${path || "an empty path"}`);
  if (!on) {
    let home = "";
    try { home = appHome().replace(/\\/g, "/").replace(/\/\.config\/herdr-app\/?$/, ""); } catch {}
    const ci = /^[A-Za-z]:/.test(p), a = ci ? p.toLowerCase() : p, h = ci ? home.toLowerCase() : home;
    if (h && (h === a || h.startsWith(`${a}/`))) throw new Error("refusing to delete a home folder or one above it");
  }
  answer(await runOp("rmtree", root, [p], [String(root).replace(/\\/g, "/").replace(/\/+$/, "")], on), p);
}

// ---- revealing in the system's file manager (this computer) ---------------------------

/** Shows `path` in Explorer (selected), Finder (`open -R`), or the file manager (xdg-open of its folder). */
export async function revealPath(path, isDir = false) {
  if (onWindows()) {
    await exec("explorer.exe", [isDir ? path.replace(/\//g, "\\") : "/select,", ...(isDir ? [] : [path.replace(/\//g, "\\")])]); // explorer answers 1 even when it worked
    return;
  }
  const mac = (await exec("uname", ["-s"]).catch(() => ({ stdout: "" }))).stdout.trim() === "Darwin";
  const r = mac ? await exec("open", ["-R", path]) : await exec("xdg-open", [isDir ? path : dirname(path)]);
  if (r.code !== 0) throw new Error(`${mac ? "open" : "xdg-open"}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
}

// One line per path: its SHA-256, or "-" when it isn't a file (absent, a folder).
const PRINTS_SH = `if command -v sha256sum >/dev/null 2>&1; then s="sha256sum"; elif command -v shasum >/dev/null 2>&1; then s="shasum -a 256"; else s="openssl dgst -sha256 -r"; fi
for p; do
  if [ -f "$p" ] && x=$($s < "$p" 2>/dev/null); then printf '%s\\n' "\${x%% *}"; else echo -; fi
done`;

/**
 * Each path's content hash on machine `on` in one call ({ path: hex | null }), for noticing outside
 * changes without watching: compare with sha256Hex of the text last read (or the last answer).
 */
export async function fingerprints(paths, { on }) {
  if (!paths.length) return {};
  if (noSh.has(on)) return {};
  let r;
  try { r = await execOn("sh", ["-c", PRINTS_SH, "wingman", ...paths], { on, timeout: 20000 }); }
  catch (e) { if (/cannot start sh/i.test(String(e?.message ?? e))) noSh.add(on); return {}; }
  const lines = r.stdout.split("\n"), out = {};
  paths.forEach((p, i) => { const x = lines[i]?.trim(); if (x) out[p] = x === "-" ? null : x; });
  return out;
}
