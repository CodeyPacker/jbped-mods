// File-system reads that run where a folder lives: this computer, or another machine (`on`, a
// space's machine) through herdr-core. Herdr's own fs/promises only reads granted folders here, so
// listings go through a program on the machine that holds the files:
// - Linux, macOS and any remote machine: POSIX sh.
// - A remote machine without sh: Windows, so PowerShell.
// - Windows drive paths here: PowerShell. Folders in WSL's own files: sh through wsl.exe.
// Paths are always arguments, never pasted into a shell line (PowerShell's -Command can't take
// arguments, so there the path is a single-quoted literal with its quotes doubled).
import { exec, readTextFile, writeTextFile } from "herdr";
import { onWindows, toWsl, distroOf } from "./git.js";
import { byteLength, chunkBytes, sha256Hex } from "./sha256.js";

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

// Runs a POSIX sh script with `args` where `path` lives, or returns null when that is a Windows
// machine (PowerShell's turn).
async function sh(script, path, args, on) {
  if (on) {
    if (noSh.has(on)) return null;
    try { return await exec("sh", ["-c", script, "wingman", path, ...args], { on }); }
    catch (e) {
      if (!/cannot start sh/i.test(String(e?.message ?? e))) throw e;
      noSh.add(on);
      return null;
    }
  }
  if (!onWindows()) return exec("sh", ["-c", script, "wingman", path, ...args]);
  if (!WSL_FILES.test(path)) return null;
  const d = distroOf(path);
  return exec("wsl.exe", [...(d ? ["-d", d] : []), "-e", "sh", "-c", script, "wingman", toWsl(path), ...args], { timeout: 15000 });
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
  return exec("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${KIND_FN}; & { param($p) ${block} } ${lit}`], { on });
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
  return (await readTextFile(path, { on }).catch(() => null)) ?? null;
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

/** Deletes a file here (Windows drive and WSL paths included). */
async function removeHere(path) {
  const r = WSL_FILES.test(path) ? await exec("wsl.exe", ["-e", "rm", "-f", "--", toWsl(path)])
    : isDrive(path)
    ? await exec("cmd", ["/c", "del", "/f", "/q", path.replace(/\//g, "\\")])
    : await exec("rm", ["-f", "--", path]);
  if (r.code !== 0) throw new Error(`delete ${path}: ${(r.stderr || r.stdout).trim()}`);
}

/** Creates a folder and its parents here. Mods may only write under ~/.config/herdr-app through
 *  fs/promises, so folders inside a repo are made by the OS's own mkdir. */
async function makeDirHere(path) {
  const win = isDrive(path);
  const r = WSL_FILES.test(path) ? await exec("wsl.exe", ["-e", "mkdir", "-p", "--", toWsl(path)]) : win ? await exec("cmd", ["/c", "mkdir", path.replace(/\//g, "\\")]) : await exec("mkdir", ["-p", "--", path]);
  // cmd's mkdir creates parents but fails when the folder exists, which is fine here.
  if (r.code !== 0 && !(win && /already exists/i.test(r.stderr + r.stdout))) throw new Error(`mkdir ${path}: ${(r.stderr || r.stdout).trim()}`);
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
    const r = await exec("sh", ["-c", 'printf %s "$@" | wc -c', "wingman", ...Array(n).fill(piece)], { on, timeout: 20000 });
    if (r.code === 0 && Number(r.stdout.trim()) === BIG_CALL) size = BIG_CALL;
  } catch {}
  callSize.set(on, size);
  return size;
}

/** Runs WRITE_SH on machine `on`; a machine without sh is a Windows machine. */
async function writeSh(on, args, timeout = 60000) {
  if (noSh.has(on)) throw new Error(WINDOWS_NOTE);
  try { return await exec("sh", ["-c", WRITE_SH, "wingman", ...args], { on, timeout }); }
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
    const again = await readTextFile(path, { on }).catch(() => undefined);
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
  try { r = await exec("mkdir", ["-p", "--", path], { on }); }
  catch (e) { throw /cannot start mkdir/i.test(String(e?.message ?? e)) ? new Error(WINDOWS_NOTE) : e; }
  if (r.code !== 0) throw new Error(`mkdir ${path}: ${(r.stderr || r.stdout).trim()}`);
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
  try { r = await exec("sh", ["-c", PRINTS_SH, "wingman", ...paths], { on, timeout: 20000 }); }
  catch (e) { if (/cannot start sh/i.test(String(e?.message ?? e))) noSh.add(on); return {}; }
  const lines = r.stdout.split("\n"), out = {};
  paths.forEach((p, i) => { const x = lines[i]?.trim(); if (x) out[p] = x === "-" ? null : x; });
  return out;
}
