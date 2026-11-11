// The Claude hook on another machine (a space's `machine`), installed from Settings. Everything
// goes in one folder there, the one the hook uses: $HERDR_WINGMAN_DIR, else
// ~/.config/herdr-app/data/wingman (a WSL machine of this PC ignores the Windows folder WSLENV hands
// in, as the hook does). It holds the hook (wingman-hook.sh, run as `sh <path>`, so it needs no
// execute bit), events/, feedback/ and wingman-install.json (what install made, so Remove takes
// away exactly that). Claude's ${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json gets the two entries
// install.sh adds here, edited in JavaScript (the machine may have no python3) and written
// compare-and-swap, with settings.json.bak-herdr-wingman beside it first.
import { exec } from "herdr";
import { readText, writeText, removeFile } from "./fsx.js";

// ---- the settings entries (pure) --------------------------------------------------

/** Every command Wingman adds contains this (install.sh's MARK). */
export const MARK = "herdr-wingman-hook";
export const MATCHER = "Edit|Write|MultiEdit|NotebookEdit";

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A hook command, as install.sh writes it: sh '<hook>' post # herdr-wingman-hook. */
export const hookCommand = (hook, arg) => `sh ${quote(hook)} ${arg} # ${MARK}`;

/** The two entries for a hook at `hook`, each a group as Claude's settings hold them. */
export function hookEntries(hook) {
  const cmd = (arg) => ({ type: "command", command: hookCommand(hook, arg), timeout: 10 });
  return { PostToolUse: { matcher: MATCHER, hooks: [cmd("post")] }, UserPromptSubmit: { hooks: [cmd("prompt")] } };
}

/** The hook path a Wingman command runs (null when the command isn't in install.sh's form). */
export function hookPathOf(command) {
  const m = /^sh '((?:[^']|'\\'')*)' (?:post|prompt) # herdr-wingman-hook$/.exec(String(command ?? "").trim());
  return m ? m[1].replace(/'\\''/g, "'") : null;
}

/** settings.json's text as an object ({} when absent or empty); throws when it isn't a JSON object. */
export function parseSettings(text) {
  if (text == null || !text.trim()) return {};
  let v;
  try { v = JSON.parse(text); } catch (e) { throw new Error(`isn't valid JSON (${e.message}); fix it or move it aside, then try again`); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("isn't a JSON object; fix it or move it aside, then try again");
  return v;
}

const groupsOf = (settings, event) => (Array.isArray(settings?.hooks?.[event]) ? settings.hooks[event] : []);

/** Every Wingman command in the settings: [{ event, command, path }]. */
export function wingmanHooks(settings) {
  const out = [];
  const hooks = settings?.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  for (const event of Object.keys(hooks)) for (const g of groupsOf(settings, event)) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
    if (typeof h?.command === "string" && h.command.includes(MARK)) out.push({ event, command: h.command, path: hookPathOf(h.command) });
  }
  return out;
}

/** A Wingman hook this PC's WSL setup added: it runs the Windows copy, through /mnt/<drive>/. */
export const isWslSetup = (path) => /^\/mnt\/[a-z]\//i.test(path ?? "");

/**
 * What the settings hold for the hook at `hook`: "installed" (both entries, as install adds them),
 * "partial" (some of ours), "wsl" (this PC's WSL setup's entries), "other" (another Wingman hook
 * entry) or "none". `existing`: the other entries' hook paths.
 */
export function hookState(settings, hook) {
  const all = wingmanHooks(settings), ours = all.filter((h) => h.path === hook), others = all.filter((h) => h.path !== hook);
  const existing = [...new Set(others.map((h) => h.path ?? h.command))];
  if (others.length) return { state: others.some((h) => isWslSetup(h.path)) ? "wsl" : "other", existing };
  if (!ours.length) return { state: "none", existing };
  const has = (event, arg, matcher) => groupsOf(settings, event).some((g) => (matcher === undefined || g.matcher === matcher)
    && (g.hooks ?? []).some((h) => h.command === hookCommand(hook, arg)));
  const exact = ours.length === 2 && has("PostToolUse", "post", MATCHER) && has("UserPromptSubmit", "prompt");
  return { state: exact ? "installed" : "partial", existing };
}

/** The settings without the Wingman commands that run `hook` (any Wingman command when `hook` is null);
 *  groups and events left empty go, and `hooks` too when nothing is left in it. A new object. */
export function withoutHooks(settings, hook = null) {
  const next = JSON.parse(JSON.stringify(settings));
  if (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks)) return next;
  const ours = (h) => typeof h?.command === "string" && h.command.includes(MARK) && (hook === null || hookPathOf(h.command) === hook);
  for (const event of Object.keys(next.hooks)) {
    const groups = next.hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!Array.isArray(g?.hooks) || !g.hooks.some(ours)) { kept.push(g); continue; }
      const left = g.hooks.filter((h) => !ours(h));
      if (left.length) kept.push({ ...g, hooks: left });
    }
    if (kept.length) next.hooks[event] = kept; else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

/**
 * settings.json's next text for `action` ("install" or "uninstall") of the hook at `hook`:
 * { text: the new text, or null when nothing changes, state, existing }. Install adds nothing when
 * another Wingman entry is there (this PC's WSL setup, or one made by hand): one hook per Claude.
 * Uninstall removes only the commands that run `hook`. Throws when the text isn't a JSON object.
 */
export function editSettings(text, action, hook) {
  const settings = parseSettings(text), { state, existing } = hookState(settings, hook);
  let next = null;
  if (action === "install" && (state === "none" || state === "partial")) {
    next = withoutHooks(settings, hook);
    const add = hookEntries(hook), hooks = (next.hooks ??= {});
    (hooks.PostToolUse ??= []).push(add.PostToolUse);
    (hooks.UserPromptSubmit ??= []).push(add.UserPromptSubmit);
  } else if (action === "uninstall" && (state === "installed" || state === "partial")) next = withoutHooks(settings, hook);
  return { text: next ? JSON.stringify(next, null, 2) + "\n" : null, state, existing };
}

/** The Settings popup's status line for a machine's hook (see hookStatus). */
export function hookSummary(s, on) {
  if (s.error) return s.error;
  const dir = s.dataThere ? "" : `, but ${s.dataDir} is missing: Install creates it`;
  switch (s.state) {
    case "installed":
      return `Installed on ${on}: ${s.settingsPath} runs ${s.hook}${dir}${s.dataThere && s.current === false ? ". It's older than this Wingman's hook: Install updates it" : ""}`;
    case "partial": return `Partly installed on ${on} (${s.settingsPath}): Install repairs it`;
    case "wsl": return `${s.dataThere ? "Installed by this PC's WSL setup" : "This PC's WSL setup has the hook"} (${s.existing.join(", ")})${s.dataThere ? `; edits are read from ${s.dataDir}` : dir}`;
    case "other": return `${s.settingsPath} already runs a Wingman hook (${s.existing.join(", ")})${s.dataThere ? `; edits are read from ${s.dataDir}` : dir}`;
    default: return `Not installed on ${on}: Claude's edits there are captured like any agent's, and notes about rejections and edits aren't sent`;
  }
}

// ---- on the machine ---------------------------------------------------------------

/**
 * sh: the data folder in $d, as the hook resolves it in a terminal there; $1, when set, is used
 * instead (tests). A HERDR_WINGMAN_DIR that WSLENV passes in from Windows is the Windows folder,
 * which the hook ignores in a WSL machine's terminals.
 */
export const DIR_SH = `d=$1
if [ -z "$d" ]; then
  d=\${HERDR_WINGMAN_DIR:-}
  case ":\${WSLENV:-}:" in *:HERDR_WINGMAN_DIR:*|*:HERDR_WINGMAN_DIR/*) d= ;; esac
  [ -n "$d" ] || d=$HOME/.config/herdr-app/data/wingman
fi`;

// $1 data folder or "", $2 settings path or "". Prints folder, settings path, then 1 or 0 (the folder is there).
const PROBE_SH = `${DIR_SH}
s=$2; [ -n "$s" ] || s=\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json
printf '%s\\0%s\\0' "$d" "$s"
if [ -d "$d" ]; then printf 1; else printf 0; fi`;

// $1 the data folder: makes it with events/ and feedback/, printing each folder it had to make
// (the data folder and the parents that were missing), deepest last.
const MKDIRS_SH = `d=$1 p=$1 made=
while [ -n "$p" ] && [ "$p" != / ] && [ ! -e "$p" ]; do made="$p
$made"; p=\${p%/*}; done
mkdir -p -- "$d/events" "$d/feedback" || exit 3
printf '%s' "$made"`;

// $1 the data folder, $2 the hook, $3 the record, $4 1 when Wingman made the folder, then the
// folders it made: removes the hook and the record, and, when it made the folder, events/ and
// feedback/ and each folder it made that is now empty (rmdir: never one holding anything else).
const REMOVE_SH = `d=$1; rm -f -- "$2" "$3"
if [ "$4" = 1 ]; then rm -rf -- "$d/events" "$d/feedback"; fi
shift 4
for p; do rmdir -- "$p" 2>/dev/null; done
[ -e "$d" ] && echo kept || echo gone`;

const run = async (script, args, on) => {
  let r;
  try { r = await exec("sh", ["-c", script, "wingman", ...args], { on, timeout: 30000 }); }
  catch (e) { throw /cannot start sh/i.test(String(e?.message ?? e)) ? new Error(`${on} has no sh (a Windows machine): the Claude hook can't be installed there`) : e; }
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `exit ${r.code}`);
  return r.stdout;
};

export const HOOK_NAME = "wingman-hook.sh", RECORD_NAME = "wingman-install.json";

/**
 * The hook on machine `on`: { dataDir, dataThere, settingsPath, hook, state, existing, current
 * (the hook there is `hookText`), settingsText, error }. `dataDir` and `settingsPath` override
 * where they are (tests). Three calls.
 */
export async function hookStatus(on, { dataDir = "", settingsPath = "", hookText = null } = {}) {
  const [d, s, there] = (await run(PROBE_SH, [dataDir, settingsPath], on)).split("\0");
  const hook = `${d}/${HOOK_NAME}`;
  const [settingsText, hookNow] = await Promise.all([readText(s, { on }), readText(hook, { on })]);
  const out = { dataDir: d, dataThere: there === "1", settingsPath: s, hook, settingsText, hookNow, current: hookText == null ? null : hookNow === hookText, state: "none", existing: [] };
  try { Object.assign(out, hookState(parseSettings(settingsText), hook)); }
  catch (e) { out.error = `${s} ${e.message}`; }
  return out;
}

/** settings.json.bak-herdr-wingman, a copy of the file as it is now (keeping its mode). */
const backup = (s, on) => run(`cp -p -- "$1" "$1.bak-herdr-wingman"`, [s], on);

/**
 * Installs the hook on machine `on` (`hookText`: the hook script's text). Idempotent: run again,
 * it changes nothing. Where another Wingman entry is in the settings (this PC's WSL setup), it
 * only makes the data folder, which that hook then uses. Resolves with a line saying what it did.
 */
export async function installHook(on, hookText, opts = {}) {
  const s = await hookStatus(on, { ...opts, hookText });
  if (s.error) throw new Error(s.error);
  const done = [];
  const made = (await run(MKDIRS_SH, [s.dataDir], on)).split("\n").filter(Boolean);
  if (made.length) done.push(`made ${s.dataDir}`);
  const recordPath = `${s.dataDir}/${RECORD_NAME}`, recordText = await readText(recordPath, { on });
  let record = {};
  try { record = recordText ? JSON.parse(recordText) : {}; } catch {}
  const own = s.state === "none" || s.state === "partial" || s.state === "installed";
  if (own && s.hookNow !== hookText) { await writeText(s.hook, hookText, s.hookNow, { on }); done.push(s.hookNow == null ? `copied the hook to ${s.hook}` : `updated ${s.hook}`); }
  const edit = editSettings(s.settingsText, "install", s.hook);
  let settingsMade = false;
  if (edit.text !== null) {
    if (s.settingsText != null) await backup(s.settingsPath, on);
    else { settingsMade = true; await run(`mkdir -p -- "\${1%/*}"`, [s.settingsPath], on); }
    await writeText(s.settingsPath, edit.text, s.settingsText, { on });
    done.push(`added the hook entries to ${s.settingsPath}`);
  }
  // The record keeps the first install's answers: what a later install finds there, it didn't make.
  const next = {
    version: 1, hook: own ? s.hook : null, settings: s.settingsPath,
    made: record.made ?? made, settingsMade: record.settingsMade ?? settingsMade, entries: own || !!record.entries,
  };
  const nextText = JSON.stringify(next, null, 2) + "\n";
  if (nextText !== recordText) await writeText(recordPath, nextText, recordText, { on });
  if (!own) done.push(`${s.settingsPath} already runs ${s.existing.join(", ")}, so no entry was added`);
  return done.length ? `${done.join("; ")}.` : `Already installed on ${on}: nothing to change.`;
}

/**
 * Removes what installHook added on machine `on`: its two entries (a backup first), the hook, the
 * record, and the folders it made (events and notes waiting there go with them). Entries it didn't
 * add (this PC's WSL setup) stay. Resolves with a line saying what it did.
 */
export async function uninstallHook(on, opts = {}) {
  const s = await hookStatus(on, opts);
  if (s.error) throw new Error(s.error);
  const done = [], recordPath = `${s.dataDir}/${RECORD_NAME}`, recordText = await readText(recordPath, { on });
  let record = null;
  try { record = recordText ? JSON.parse(recordText) : null; } catch {}
  const edit = editSettings(s.settingsText, "uninstall", s.hook);
  if (edit.text !== null) {
    await backup(s.settingsPath, on);
    // A settings file install made, left empty, goes too.
    if (record?.settingsMade && edit.text.trim() === "{}") { await removeFile(s.settingsPath, s.settingsText, { on }); done.push(`removed ${s.settingsPath} (install made it)`); }
    else { await writeText(s.settingsPath, edit.text, s.settingsText, { on }); done.push(`removed the hook entries from ${s.settingsPath}`); }
  }
  // Only the data folder and its parents can be in `made`; anything else in a record is ignored.
  const made = (record?.made ?? []).filter((p) => typeof p === "string" && p.startsWith("/") && (p === s.dataDir || s.dataDir.startsWith(`${p}/`)))
    .sort((a, b) => b.length - a.length);
  const madeDir = made.includes(s.dataDir);
  if (record || s.hookNow != null) {
    const left = (await run(REMOVE_SH, [s.dataDir, s.hook, recordPath, madeDir ? "1" : "0", ...made], on)).trim();
    done.push(madeDir && left === "gone" ? `removed ${s.dataDir}` : `removed the hook from ${s.dataDir}`);
  }
  return done.length ? `${done.join("; ")}.` : `Nothing of Wingman's to remove on ${on}.`;
}
