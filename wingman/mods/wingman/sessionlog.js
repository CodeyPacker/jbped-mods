// The agent's own session log as a second source of the files it touched (beside the Claude hook's
// journal and capture's snapshots). Only Claude Code's log ("dialect") is read: a JSON line per
// record, with `timestamp` (ISO-8601) and `message.content[]` items of `type: "tool_use"` whose
// `name` is the tool and `input.file_path` (`input.notebook_path`, `input.path`) the file.
//
// Where the log is: `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<slug>/<session id>.jsonl` on the
// machine Claude runs on, the slug being Claude's folder with "/" as "-" (older versions) or every
// character but a letter or digit as "-" (newer); both are tried. Without the session id (the hook
// reports it once Claude edits a file: noteSession) the newest log written since the agent started
// is the agent's; two Claudes in one folder can't be told apart that way (`ambiguous`).
//
// The log is untrusted data: every read is bounded (CHUNK bytes a call, at most MAX_FILES files
// kept per log), a line that isn't JSON or is longer than a chunk is skipped, and nothing in it is
// ever run or put into a command line: scripts take their values as arguments.
//
// The parts that decide (slugs, parsing, reduction, choosing a log, where to read from) are pure and
// tested under node; readLog / listLogs run the bounded scripts on the agent's machine.
import { exec } from "herdr";
import { execOn } from "./fsx.js";
import { fromWsl, toWsl, distroOf, knownDistro, onWindows } from "./git.js";
import { remotePath } from "./remote.js";
import { byteLength } from "./sha256.js";

/** Bytes read from a log per call: also the longest line read (a longer one is skipped). */
export const CHUNK = 2 * 1024 * 1024;
/** Files kept per log (the oldest by last touch go first). */
export const MAX_FILES = 2000;
/** Logs kept in memory, across agents and copies (the least recently used goes first). */
export const MAX_LOGS = 16;
/** A shown agent's log is read at most this often. */
export const EVERY_MS = 5000;
/** Where a log was found is looked up again this often (a newer session may have started). */
export const LOCATE_MS = 30000;
/** Logs listed per slug folder, newest first. */
const LIST_MAX = 8;

const OPS = { Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit" };
/** The touch a Claude tool makes ("read", "edit", "write"), or null for any other tool. */
export const toolOp = (name) => (Object.hasOwn(OPS, name) ? OPS[name] : null);

/** Whether an agent is Claude Code (its own report, else the program Herdr sees). */
export const isClaude = (a) => a?.app === "claude-code" || a?.program?.key === "claude";

// A slug is a folder name: letters, digits and a few safe characters only (never a quote, a
// separator or a dot-only name), so it can't leave the projects folder or a quoted literal.
const SAFE_SLUG = /^[A-Za-z0-9 ._+,=@~()-]{1,255}$/;

/** Claude Code's folder names for `cwd` as Claude sees it: the older encoding(s) first, then the newer. */
export function claudeSlugs(cwd) {
  const s = String(cwd ?? "");
  if (!s) return [];
  const out = [s.replace(/\//g, "-"), s.replace(/[\\/:]/g, "-"), s.replace(/[^A-Za-z0-9]/g, "-")];
  return [...new Set(out)].filter((x) => SAFE_SLUG.test(x) && !/^\.+$/.test(x));
}

const absolute = (p) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Touches in complete log lines `text`: { touches: [{ path, op, at }], bad, session }. `toHost`
 * turns a path as the agent wrote it into the mod's form. Lines that aren't JSON, are over
 * `lineMax` characters, or name a relative or overlong path are skipped (`bad` counts the first two).
 */
export function parseLines(text, toHost = (p) => p, lineMax = CHUNK) {
  const touches = [];
  let bad = 0, session = null;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    if (line.length > lineMax) { bad++; continue; }
    if (!line.includes('"tool_use"')) continue; // the cheap test: most lines are text and results
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    const items = o?.message?.content;
    if (!Array.isArray(items)) continue;
    if (typeof o.sessionId === "string" && SESSION_ID.test(o.sessionId)) session = o.sessionId;
    const t = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN, at = Number.isFinite(t) ? t : null;
    for (const it of items) {
      if (it?.type !== "tool_use" || typeof it.name !== "string") continue;
      const op = toolOp(it.name), inp = it.input;
      if (!op || !inp || typeof inp !== "object") continue;
      const raw = [inp.file_path, inp.notebook_path, inp.path].find((v) => typeof v === "string" && v);
      if (!raw || raw.length > 4096 || !absolute(raw) || /[\0\n]/.test(raw)) continue;
      const path = toHost(raw);
      if (path) touches.push({ path, op, at });
    }
  }
  return { touches, bad, session };
}

/**
 * Adds `touches` (in log order) to `files`, a Map of path -> { path, read, edited, created, lastAt }:
 * `created` when the first touch seen of the file was a write. Keeps at most `max` files.
 */
export function reduce(files, touches, max = MAX_FILES) {
  for (const { path, op, at } of touches) {
    let f = files.get(path);
    if (!f) { f = { path, read: false, edited: false, created: op === "write", lastAt: null }; files.set(path, f); }
    if (op === "read") f.read = true; else f.edited = true;
    if (at != null && (f.lastAt == null || at > f.lastAt)) f.lastAt = at;
  }
  if (files.size > max) for (const f of ordered(files).slice(max)) files.delete(f.path);
  return files;
}

/** The files newest first (no time last), then by path. */
export function ordered(files) {
  return [...files.values()].sort((a, b) => (b.lastAt ?? -Infinity) - (a.lastAt ?? -Infinity) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * What a read of `bytes` bytes at a log's offset gave (`chunk`, its text): the complete lines to
 * parse and how far the offset moves. A line still being written waits for the next read. A chunk
 * with no line end at all that filled the read is part of an oversized line: it's skipped
 * (`advance` the whole read, `skipNext` drops the rest of that line next time).
 * `skipFirst`: the text up to the first line end belongs to a line already skipped (or cut by a
 * tail read) and is dropped.
 */
export function takeLines(chunk, bytes, skipFirst = false, full = CHUNK) {
  const s = String(chunk ?? ""), end = s.lastIndexOf("\n");
  if (end < 0) {
    if (bytes >= full) return { text: "", advance: bytes, skipNext: true, bad: skipFirst ? 0 : 1 };
    return { text: "", advance: 0, skipNext: skipFirst, bad: 0 };
  }
  let text = s.slice(0, end + 1);
  const advance = byteLength(text);
  if (skipFirst) text = text.slice(text.indexOf("\n") + 1);
  return { text, advance, skipNext: false, bad: 0 };
}

/**
 * Where the next read of a log starts, given what was kept of it (`prev`: { offset }) and its size
 * now: from the last offset; from the start of its last CHUNK when it is new to us (`partial`: the
 * older part isn't read) or shrank (truncated or replaced: `reset`, everything is read again).
 */
export function readPlan(prev, size, tail = CHUNK) {
  if (prev && size >= prev.offset) return { start: prev.offset, reset: false, partial: !!prev.partial };
  const start = Math.max(0, size - tail);
  return { start, reset: true, partial: start > 0 };
}

/**
 * The agent's log among `logs` ([{ path, mtime, size, where }]): the one named for `session` when
 * it's there, else the newest written since `since` (2 s of slack; any when unknown). `ambiguous`:
 * picked by time while `others` other Claudes work in the same folder.
 */
export function chooseLog(logs, { session = null, since = null, others = 0 } = {}) {
  if (session) {
    const named = logs.find((l) => baseName(l.path) === `${session}.jsonl`);
    if (named) return { log: named, ambiguous: false };
  }
  const fresh = logs.filter((l) => since == null || l.mtime >= since - 2000).sort((a, b) => b.mtime - a.mtime);
  return fresh.length ? { log: fresh[0], ambiguous: others > 0 } : { log: null, ambiguous: others > 0 };
}

const baseName = (p) => String(p).split(/[\\/]/).pop();

/**
 * Where to look for the log of a Claude whose folder is `cwd` (the mod's form of it), on machine
 * `on` (null: this computer), with `windows` this computer being Windows. Each place: { kind, cwd }
 * with `cwd` as Claude there names it; kind "sh" (this computer), "on" (another machine, sh there),
 * "wsl" (WSL from Windows, `distro` null for the default) or "ps" (Windows itself, PowerShell).
 * A folder on a Windows drive may hold a Windows Claude or a WSL one, so both are tried.
 */
export function placesFor(cwd, on = null, windows = false) {
  if (!cwd) return [];
  if (on) return [{ kind: "on", on, cwd }];
  if (!windows) return [{ kind: "sh", cwd }];
  const s = String(cwd).replace(/\\/g, "/"), distro = distroOf(s);
  if (distro) return [{ kind: "wsl", distro, cwd: toWsl(s) }];
  if (/^[A-Za-z]:/.test(s)) return [{ kind: "ps", cwd: s.replace(/\//g, "\\") }, { kind: "wsl", distro: null, cwd: toWsl(s) }];
  return [{ kind: "wsl", distro: null, cwd: s }];
}

/** A path as the agent at `place` wrote it, in the mod's form (as the hook's paths are kept). */
export function hostOfPlace(place, p) {
  if (place.kind === "on") return remotePath(p);
  if (place.kind === "ps") return String(p).replace(/\\/g, "/");
  if (place.kind === "wsl") return fromWsl(String(p), place.distro ?? knownDistro());
  return String(p);
}

export const placeKey = (place) => `${place.kind}\u0000${place.on ?? place.distro ?? ""}`;

// ---- the session id the hook saw ---------------------------------------------------
// The Claude hook's events carry `session_id`; the journal hands each one here (noteSession), so a
// Claude that has edited something is known by its log's name. Module state: every copy shares it.
const sessions = new Map();

/** Records the session id of the Claude in terminal `terminal` (Herdr's address) from a hook event. */
export function noteSession(terminal, event) {
  const id = event?.session_id;
  if (!terminal || typeof id !== "string" || !SESSION_ID.test(id)) return;
  sessions.delete(terminal); sessions.set(terminal, id);
  if (sessions.size > 64) sessions.delete(sessions.keys().next().value);
}
/** The session id the hook last reported for terminal `terminal`, or null. */
export const sessionOf = (terminal) => sessions.get(terminal) ?? null;

/** When an agent's terminal started, in ms, from what terminals() says of it; null when unknown. */
export function startedAt(term) {
  for (const k of ["started_at", "startedAt", "created_at", "createdAt", "created", "start_time"]) {
    const v = term?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string") { const t = Date.parse(v); if (Number.isFinite(t)) return t; }
  }
  return null;
}

// ---- running on the agent's machine ---------------------------------------------------

// $1 most logs per folder, $2... slugs. Prints "<mtime s>\0<size>\0<path>\0" per log, newest first.
const LIST_SH = `d="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
[ -d "$d" ] || exit 0
max=$1; shift
for s in "$@"; do
  [ -d "$d/$s" ] || continue
  ls -t -- "$d/$s" 2>/dev/null | grep '\\.jsonl$' | head -n "$max" | while IFS= read -r n; do
    f="$d/$s/$n"; [ -f "$f" ] || continue
    t=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f" 2>/dev/null) || continue
    z=$(wc -c < "$f" | tr -d ' ')
    printf '%s\\0%s\\0%s\\0' "$t" "$z" "$f"
  done
done
exit 0`;

// $1 log, $2 offset, $3 most bytes. Prints the size and a line end, then at most $3 bytes from $2.
const READ_SH = `[ -f "$1" ] || { printf 'none'; exit 0; }
z=$(wc -c < "$1" | tr -d ' ')
printf '%s\\n' "$z"
[ "$2" -lt "$z" ] && tail -c +"$(($2 + 1))" -- "$1" | head -c "$3"
exit 0`;

// PowerShell takes no arguments with -Command: values go in as single-quoted literals (quotes
// doubled, curly ones too, as fsx.js does) and numbers as checked digits.
const lit = (s) => "'" + String(s).replace(/['‘’‚‛]/g, "$&$&") + "'";
const ps = (script) => exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20000 });
const listPs = (slugs, max) => `$ErrorActionPreference = 'SilentlyContinue'
$c = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$o = [Console]::OpenStandardOutput(); $sb = [Text.StringBuilder]::new()
foreach ($s in @(${slugs.map(lit).join(", ")})) {
  $d = [IO.DirectoryInfo]::new([IO.Path]::Combine($c, 'projects', $s)); if (-not $d.Exists) { continue }
  foreach ($f in ($d.EnumerateFiles('*.jsonl') | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First ${max})) {
    $t = [long]([DateTimeOffset]$f.LastWriteTimeUtc).ToUnixTimeSeconds()
    [void]$sb.Append($t).Append([char]0).Append($f.Length).Append([char]0).Append($f.FullName).Append([char]0) } }
$b = [Text.UTF8Encoding]::new($false).GetBytes($sb.ToString()); $o.Write($b, 0, $b.Length); $o.Flush()`;
const readPs = (path, offset, max) => `$ErrorActionPreference = 'Stop'; $o = [Console]::OpenStandardOutput()
try { $f = [IO.File]::Open(${lit(path)}, 'Open', 'Read', 'ReadWrite, Delete') } catch { [Console]::Out.Write('none'); exit 0 }
try { $z = $f.Length; $h = [Text.Encoding]::ASCII.GetBytes("$z\`n"); $o.Write($h, 0, $h.Length)
  if (${offset} -lt $z) { [void]$f.Seek(${offset}, 'Begin'); $n = [Math]::Min([long]${max}, $z - ${offset}); $b = New-Object byte[] $n; $r = 0
    while ($r -lt $n) { $k = $f.Read($b, $r, $n - $r); if ($k -le 0) { break }; $r += $k }
    $o.Write($b, 0, $r) }
  $o.Flush() } finally { $f.Close() }`;

/** Runs an sh script with `args` at `place` (this computer, WSL or another machine). */
function sh(place, script, args) {
  if (place.kind === "on") return execOn("sh", ["-c", script, "wingman", ...args], { on: place.on, timeout: 20000 });
  if (place.kind === "wsl") return exec("wsl.exe", [...(place.distro ? ["-d", place.distro] : []), "-e", "sh", "-c", script, "wingman", ...args], { timeout: 20000 });
  return exec("sh", ["-c", script, "wingman", ...args], { timeout: 20000 });
}

/** The newest logs of `place`'s folder: [{ path, mtime (ms), size, place }]. */
export async function listLogs(place) {
  const slugs = claudeSlugs(place.cwd);
  if (!slugs.length) return [];
  const r = place.kind === "ps" ? await ps(listPs(slugs, LIST_MAX)) : await sh(place, LIST_SH, [String(LIST_MAX), ...slugs]);
  if (r.code !== 0) throw new Error(`session logs: ${String(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`);
  const f = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 2 < f.length && out.length < LIST_MAX * slugs.length; i += 3) {
    const mtime = Number(f[i]) * 1000, size = Number(f[i + 1]), path = f[i + 2];
    if (!Number.isFinite(mtime) || !Number.isFinite(size) || !/\.jsonl$/.test(path) || /[\n\r]/.test(path)) continue;
    out.push({ path, mtime, size, place });
  }
  return out;
}

/** At most `max` bytes of log `path` at `place` from byte `offset`: { size, text, bytes } or null when it's gone. */
export async function readLog(place, path, offset, max = CHUNK) {
  const off = Math.max(0, Math.floor(offset)), n = Math.max(1, Math.floor(max));
  const r = place.kind === "ps" ? await ps(readPs(path, off, n)) : await sh(place, READ_SH, [path, String(off), String(n)]);
  if (r.code !== 0) throw new Error(`session log: ${String(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`);
  if (r.stdout.startsWith("none")) return null;
  const nl = r.stdout.indexOf("\n"), size = Number(r.stdout.slice(0, nl));
  if (nl < 0 || !Number.isFinite(size)) throw new Error("session log: unreadable size");
  return { size, text: r.stdout.slice(nl + 1), bytes: Math.max(0, Math.min(n, size - off)) };
}

// ---- the source: one pass per agent ------------------------------------------------------

const logs = new Map();   // placeKey + path -> { offset, partial, skipNext, files, bad, used }
const agentsSeen = new Map(); // agent address -> { at, busy, located: { log, at }, result }

/** Forgets every log and agent (tests; also when the setting is turned off). */
export function forgetLogs() { logs.clear(); agentsSeen.clear(); }

/** Reads a log's new lines into its kept state (one bounded read; two for a log new to us whose size isn't known). */
async function pull(log) {
  const key = `${placeKey(log.place)}\u0000${log.path}`;
  let st = logs.get(key);
  if (!st) {
    const size = log.size ?? (await readLog(log.place, log.path, 0, 1))?.size;
    if (size == null) return null;
    const plan = readPlan(null, size);
    st = { offset: plan.start, partial: plan.partial, skipNext: plan.start > 0, files: new Map(), bad: 0, session: null };
    logs.set(key, st);
  }
  st.used = Date.now();
  if (logs.size > MAX_LOGS) [...logs].sort((a, b) => a[1].used - b[1].used).slice(0, logs.size - MAX_LOGS).forEach(([k]) => logs.delete(k));
  if (log.size === st.offset) return st; // nothing new since the last read
  const got = await readLog(log.place, log.path, st.offset);
  if (!got) return st;
  if (got.size < st.offset) { logs.delete(key); return pull({ ...log, size: got.size }); } // truncated or replaced: read again
  const take = takeLines(got.text, got.bytes, st.skipNext);
  const p = parseLines(take.text, (x) => hostOfPlace(log.place, x));
  reduce(st.files, p.touches);
  st.offset += take.advance; st.skipNext = take.skipNext; st.bad += p.bad + take.bad;
  if (p.session) st.session = p.session;
  return st;
}

/**
 * The files Claude agent `agent` touched, from its session log: { files (newest first), log,
 * ambiguous, partial, bad, error } or null when there's nothing to say yet. `cwd`: its folder (the
 * mod's form), `on` its machine, `others`: other Claudes in that folder, `since` its start (ms) when
 * known, `enabled`: the setting (off: nothing is read at all). At most one pass per EVERY_MS per
 * agent; meanwhile the last result.
 */
export async function agentTouches(agent, { cwd, on = null, others = 0, since = null, enabled = true, now = Date.now(), windows = onWindows() } = {}) {
  if (!enabled || !agent?.address || !cwd) return null;
  const a = agentsSeen.get(agent.address) ?? { at: 0, busy: false, located: null, result: null };
  agentsSeen.set(agent.address, a);
  if (a.busy || now - a.at < EVERY_MS) return a.result;
  a.busy = true; a.at = now;
  try {
    const session = sessionOf(agent.address);
    let fresh = false;
    if (!a.located || a.located.cwd !== cwd || now - a.located.at >= LOCATE_MS || (session && !a.located.bySession)) {
      const found = [], errors = [], places = placesFor(cwd, on, windows);
      for (const place of places) {
        try { found.push(...(await listLogs(place))); } catch (e) { errors.push(e); }
      }
      if (!found.length && errors.length === places.length && errors.length) throw errors.at(-1);
      const pick = chooseLog(found, { session, since, others });
      a.located = { cwd, at: now, log: pick.log, ambiguous: pick.ambiguous, bySession: !!session && !!pick.log && sameName(pick.log.path, session) };
      fresh = true;
    }
    const log = a.located.log;
    if (!log) { a.result = { files: [], log: null, ambiguous: a.located.ambiguous, partial: false, bad: 0, error: null }; return a.result; }
    // Between listings the size is learnt from the read itself.
    const st = await pull(fresh ? log : { ...log, size: null });
    if (!st) { a.located = null; a.result = { files: [], log: null, ambiguous: false, partial: false, bad: 0, error: null }; return a.result; }
    a.result = { files: ordered(st.files), log: log.path, ambiguous: a.located.ambiguous, partial: st.partial, bad: st.bad, error: null };
  } catch (e) {
    a.result = { ...(a.result ?? { files: [], log: null, ambiguous: false, partial: false, bad: 0 }), error: String(e?.message ?? e).slice(0, 200) };
  } finally { a.busy = false; }
  return a.result;
}

const sameName = (path, session) => baseName(path) === `${session}.jsonl`;
