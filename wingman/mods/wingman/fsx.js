// File-system reads that run where a folder lives: this computer, or another machine (`on`, a
// space's machine) through herdr-core. Herdr's own fs/promises only reads granted folders here, so
// listings go through a program on the machine that holds the files:
// - Linux, macOS and any remote machine: POSIX sh.
// - A remote machine without sh: Windows, so PowerShell.
// - Windows drive paths here: PowerShell. Folders in WSL's own files: sh through wsl.exe.
// Paths are always arguments, never pasted into a shell line (PowerShell's -Command can't take
// arguments, so there the path is a single-quoted literal with its quotes doubled).
import { exec, readTextFile } from "herdr";
import { onWindows, toWsl, distroOf } from "./git.js";

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
