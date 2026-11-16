// Claude hook events -> review stores. The hook (hooks/wingman-hook.sh) saves each
// Edit/Write as data/wingman/events/<ns>-<terminal>-<pid>.json. Each edited file goes to
// the store of the repo it lives in, so one space's review can span several repos.
// The first edit of a file sets its baseline from Claude's own `originalFile`, which is
// exactly what was on disk before the edit. Files outside any git repo are skipped.
// On another machine (`on`) the hook writes the same files in its own data folder there
// (hooksetup.js): drainOn reads and removes them there, and the review stores it writes are that
// machine's; feedback for a terminal there goes to that folder's feedback/.
import * as fs from "fs/promises";
import { readTextFile, writeTextFile, appHome, terminals, agents, exec } from "herdr";
import { Store, ensureDir, parkStale } from "./store.js";
import { hostPath } from "./capture.js";
import { writeText, removeFile, readOn, execOn } from "./fsx.js";
import { REMOTE, remotePath, rootId, addressOn, idOn, mapLimit } from "./remote.js";
import { DIR_SH } from "./hooksetup.js";
import { noteSession } from "./sessionlog.js";
import { notePrompt } from "./checkpoints.js";

/** A UserPromptSubmit event (hook "prompt"): its prompt's first line titles the turn's checkpoint, nothing is reviewed. */
const isPrompt = (event) => event?.hook_event_name === "UserPromptSubmit" && typeof event.prompt === "string";
import { DEFAULT_COMMAND } from "./inlineedit.js";

export const reviewDir = () => `${appHome()}/data/wingman`;
const SPACES = () => `${reviewDir()}/spaces.json`;

/** Repos each space's agents have edited: { "<space id>": ["C:/dev/a", ...] }. */
export async function spaceRepos() {
  const t = await readTextFile(SPACES());
  return t ? JSON.parse(t) : {};
}

/** Adds [space, root] pairs to the space -> repos map (also used by Open folder). */
export async function addSpaceRepos(add) {
  const before = await readTextFile(SPACES()), map = before ? JSON.parse(before) : {};
  let changed = false;
  for (const [space, root] of add) {
    const list = (map[space] ??= []);
    if (!list.includes(root)) { list.push(root); changed = true; }
  }
  if (changed) await writeTextFile(SPACES(), JSON.stringify(map, null, 2) + "\n", before);
}

const dirOf = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/"))) || p;

/** Whether the hook's data folder was found on each machine the journal looked at (true / false). */
const hookThere = new Map();

/** What the journal last saw of the hook on machine `on`: true (installed), false (its folder is
 *  missing) or undefined (not looked yet). */
export const hookKnown = (on) => hookThere.get(on);

/** Forgets what was seen (after an install or removal from Settings). */
export const forgetHook = () => hookThere.clear();

// $1 data folder or "" (DIR_SH), $2 the most names to print. "none" when the folder is missing,
// else "dir", the folder, then event file names, NUL-separated.
const EVENTS_SH = `${DIR_SH}
[ -d "$d" ] || { printf none; exit 0; }
printf 'dir\\0%s\\0' "$d"
n=0
for p in "$d"/events/*.json; do
  [ -f "$p" ] || continue
  printf '%s\\0' "\${p##*/}"
  n=$((n+1)); [ "$n" -ge "$2" ] && break
done
exit 0`;

export class Journal {
  constructor(log) { this.log = log; this.stores = new Map(); this.failures = new Map(); }

  /** The store for the repo that holds `path`'s folder (on machine `on`), cached by folder; null outside git. */
  async storeFor(folder, on = null) {
    const id = on ? rootId(folder, on) : folder;
    if (!this.stores.has(id)) this.stores.set(id, await (on ? Store.open(folder, on) : Store.open(folder)).catch(() => null));
    return this.stores.get(id);
  }

  /** Processes every pending event file in order, then removes it. Returns files adopted. */
  async drain() {
    const dir = `${reviewDir()}/events`;
    if (!(await fs.exists(dir))) return 0;
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    let adopted = 0;
    const spaces = [];
    for (const name of names) {
      const path = `${dir}/${name}`;
      let done = true;
      try {
        const text = await readTextFile(path);
        if (text) {
          const { terminal, event, wingman } = JSON.parse(text);
          noteSession(terminal, event); // the session log's name for this Claude (sessionlog.js)
          if (isPrompt(event)) { notePrompt(terminal, event.prompt); this.log(`hook ${terminal} prompt`); }
          else {
            // Wingman's own events (an inline edit, postEdit) name their space and machine; the hook's don't.
            const space = terminals().find((t) => t.address === terminal)?.labels?.["herdr.space"] ?? wingman?.space ?? null;
            const r = await this.apply(event, terminal, wingman?.on ?? null, wingman?.space ?? null);
            this.log(`hook ${terminal} ${event?.tool_name} ${event?.tool_input?.file_path ?? ""} -> ${r?.added ? "added" : r ? "already reviewed" : "not in a repo"}`);
            if (r && space) spaces.push([space, r.root]);
            if (r?.added) adopted++;
            // Claude's own folder belongs to the space too, even before it edits there.
            const cwd = hostPath(event.cwd);
            const home = cwd && (await this.storeFor(cwd));
            if (home && space) spaces.push([space, home.root]);
          }
        }
      } catch (e) {
        // Keep the event for a retry (a file may be mid-write); drop it after 3 failures.
        const n = (this.failures.get(name) ?? 0) + 1;
        this.failures.set(name, n);
        done = n >= 3 || e instanceof SyntaxError;
        this.log(`event ${name}: ${e.message ?? e}${done ? " (dropped)" : " (will retry)"}`);
      }
      if (done) { this.failures.delete(name); await fs.unlink(path).catch(() => {}); }
      else break; // keep order: later events for the same file must wait
    }
    if (spaces.length) await addSpaceRepos(spaces);
    return adopted;
  }

  /**
   * drain for machine `on`: one call lists its events folder (null `installed` when the hook's
   * folder isn't there), at most `max` new events are read a few at a time, applied in name
   * order as drain does, and the processed ones removed there in one call. An event's terminal
   * is the bare id the hook saw (HC_TERMINAL_ID), mapped to Herdr's address ("<on>/<id>").
   * `dataDir`: the folder there (tests); by default the one the hook uses.
   * Resolves with { installed, adopted, events }.
   */
  async drainOn(on, { dataDir = "", max = REMOTE.journalMax } = {}) {
    let r;
    try { r = await execOn("sh", ["-c", EVENTS_SH, "wingman", dataDir, String(max * 5)], { on, timeout: 20000 }); }
    catch (e) {
      if (!/cannot start sh/i.test(String(e?.message ?? e))) throw e;
      hookThere.set(on, false); // a Windows machine: no hook there
      return { installed: false, adopted: 0, events: 0 };
    }
    if (r.code !== 0) throw new Error(`events on ${on}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    if (!r.stdout.startsWith("dir\0")) { hookThere.set(on, false); return { installed: false, adopted: 0, events: 0 }; }
    hookThere.set(on, true);
    const [, dir, ...rest] = r.stdout.split("\0");
    const names = rest.filter((n) => n.endsWith(".json")).sort().slice(0, max);
    const texts = await mapLimit(names, REMOTE.parallel, (n) => readOn(`${dir}/events/${n}`, { on }).then((text) => ({ text }), (error) => ({ error })));
    let adopted = 0;
    const spaces = [], gone = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i], key = `${on}\0${name}`;
      let done = true;
      try {
        if (texts[i].error) throw texts[i].error;
        if (texts[i].text) {
          const { terminal: id, event } = JSON.parse(texts[i].text), terminal = addressOn(on, id);
          noteSession(terminal, event);
          if (isPrompt(event)) { notePrompt(terminal, event.prompt); this.log(`hook ${terminal} prompt`); }
          else {
            const space = agents().find((a) => a.address === terminal)?.space ?? null;
            const res = await this.apply(event, terminal, on);
            this.log(`hook ${terminal} ${event?.tool_name} ${event?.tool_input?.file_path ?? ""} -> ${res?.added ? "added" : res ? "already reviewed" : "not in a repo"}`);
            if (res && space) spaces.push([space, res.root]);
            if (res?.added) adopted++;
            const cwd = remotePath(event?.cwd);
            const home = cwd && (await this.storeFor(cwd, on));
            if (home && space) spaces.push([space, home.root]);
          }
        }
      } catch (e) {
        const n = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, n);
        done = n >= 3 || e instanceof SyntaxError;
        this.log(`event ${name} on ${on}: ${e.message ?? e}${done ? " (dropped)" : " (will retry)"}`);
      }
      if (!done) break; // keep order: later events for the same file must wait
      this.failures.delete(key);
      gone.push(`${dir}/events/${name}`);
    }
    if (gone.length) {
      const rm = await execOn("rm", ["-f", "--", ...gone], { on, timeout: 20000 });
      if (rm.code !== 0) this.log(`events on ${on}: rm: ${(rm.stderr || rm.stdout).trim()}`);
    }
    if (spaces.length) await addSpaceRepos(spaces);
    return { installed: true, adopted, events: gone.length };
  }

  /**
   * Adds an edited file to its repo's review unless it is already there. `on`: the machine the
   * event came from; its paths are that machine's (never converted) and `terminal` is Herdr's
   * address for the terminal there.
   */
  async apply(event, terminal, on = null, inSpace = null) {
    const asSeen = event?.tool_input?.file_path ?? event?.tool_input?.notebook_path;
    const file = on ? remotePath(asSeen) : hostPath(asSeen);
    if (!file) return null;
    const store = await this.storeFor(dirOf(file), on);
    if (!store) return null; // outside git: not reviewed (MVP)
    const rel = file.slice(store.root.length + 1);
    const head = file.slice(0, store.root.length);
    if (!rel || (on ? head !== store.root : head.toLowerCase() !== store.root.toLowerCase())) return null;
    const read = (p) => readOn(p, { on });
    const put = (p, text, before) => (on ? writeText(p, text, before, { on }) : writeTextFile(p, text, before));
    const res = event.tool_response ?? {};
    const created = res.type === "create";
    const original = created ? "" : res.originalFile;
    // Write on a very large file reports no originalFile; generic capture covers those.
    if (typeof original !== "string") { this.log(`no original for ${file}; left to capture`); return { root: store.root }; }

    const indexPath = `${store.dir}/index.json`, before = await read(indexPath);
    const index = before ? JSON.parse(before) : { version: 1, files: {} };
    const branch = await store.branch();
    parkStale(index, rel, branch); // an entry from another branch steps aside for this one
    if (index.files[rel]) {
      if (!index.files[rel].by && terminal) {
        Object.assign(index.files[rel], { by: terminal, as: asSeen });
        await put(indexPath, JSON.stringify(index, null, 2) + "\n", before);
      }
      return { root: store.root };
    }
    await ensureDir(`${store.dir}/baselines`, on);
    const name = `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.txt`;
    await put(`${store.dir}/baselines/${name}`, original, null);
    // `as`: the path as Claude wrote it (/mnt/c/... in WSL), so feedback names the file its way.
    const space = agents().find((a) => a.address === terminal)?.space ?? inSpace;
    index.files[rel] = { baseline: name, created, by: terminal, as: asSeen, branch, head: await store.head(), ...(space ? { space } : {}) };
    await put(indexPath, JSON.stringify(index, null, 2) + "\n", before);
    this.log(`claude ${terminal}: ${store.root} ${rel}${created ? " (new)" : ""}${on ? ` on ${on}` : ""}`);
    return { root: store.root, added: true };
  }
}

/**
 * Puts a file Wingman itself changes (an inline edit) under review the way a hook event does: an
 * event in this computer's events/ folder that the capture leader applies in turn with the hook's
 * (Journal.drain, never while a collect pass writes an index). `original`: the text the review
 * baseline gets; `space`: the space the change shows in; `on`: the machine the file is on. An entry
 * already there is kept as it is (its baseline stays). Resolves with the event file's path.
 */
export async function postEdit({ path, original, space, on = null }) {
  const dir = `${reviewDir()}/events`;
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const name = `${Date.now()}000000-wingman-${Math.random().toString(36).slice(2, 10)}.json`;
  const event = { tool_name: "WingmanInlineEdit", tool_input: { file_path: path }, tool_response: { type: "update", originalFile: original } };
  await writeTextFile(`${dir}/${name}`, JSON.stringify({ terminal: null, event, wingman: { space, on } }), null);
  return `${dir}/${name}`;
}

// $1 data folder or "" (DIR_SH): makes its feedback/ and prints the folder, or "none" when the
// data folder is missing (the hook isn't installed there).
const FEEDBACK_SH = `${DIR_SH}
[ -d "$d" ] || { printf none; exit 0; }
mkdir -p -- "$d/feedback" && printf 'dir %s' "$d"`;

/** The feedback file on machine `on` for Herdr's terminal address `terminal` (one call). Throws when
 *  the hook isn't installed there. */
async function feedbackPath(on, terminal, dataDir) {
  const r = await execOn("sh", ["-c", FEEDBACK_SH, "wingman", dataDir], { on, timeout: 20000 });
  if (r.code !== 0) throw new Error(`feedback on ${on}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  if (!r.stdout.startsWith("dir ")) { hookThere.set(on, false); throw new Error(`the Claude hook isn't installed on ${on}`); }
  return `${r.stdout.slice(4)}/feedback/${idOn(on, terminal)}.ctx`;
}

/**
 * Queues a message for the Claude in `terminal`; its hook passes it on as additionalContext
 * on the next tool call or prompt. Stored as one JSON string, ready for the hook to embed.
 * `on`: a terminal on that machine (its address, "<on>/<id>"); the file goes to the hook's folder there.
 */
export async function queueFeedback(terminal, text, { on = null, dataDir = "" } = {}) {
  if (on) {
    const path = await feedbackPath(on, terminal, dataDir), before = await readOn(path, { on });
    const lines = before ? JSON.parse(before).split("\n") : [];
    lines.push(text);
    await writeText(path, JSON.stringify(lines.join("\n")), before, { on });
    return;
  }
  const dir = `${reviewDir()}/feedback`, path = `${dir}/${terminal}.ctx`;
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const before = await readTextFile(path);
  const lines = before ? JSON.parse(before).split("\n") : [];
  lines.push(text);
  await writeTextFile(path, JSON.stringify(lines.join("\n")), before);
}

/** Withdraws a queued message (an undone rejection) if the hook hasn't delivered it yet;
 *  true when it was still queued. */
export async function withdrawFeedback(terminal, text, { on = null, dataDir = "" } = {}) {
  if (on) {
    const path = await feedbackPath(on, terminal, dataDir), before = await readOn(path, { on });
    if (!before) return false;
    const all = JSON.parse(before).split("\n"), lines = all.filter((l) => l !== text);
    if (lines.length === all.length) return false;
    if (lines.length) await writeText(path, JSON.stringify(lines.join("\n")), before, { on });
    else await removeFile(path, before, { on }).catch(() => {}); // the hook took it meanwhile
    return true;
  }
  const path = `${reviewDir()}/feedback/${terminal}.ctx`, before = await readTextFile(path);
  if (!before) return false;
  const all = JSON.parse(before).split("\n"), lines = all.filter((l) => l !== text);
  if (lines.length === all.length) return false;
  if (lines.length) await writeTextFile(path, JSON.stringify(lines.join("\n")), before);
  else await fs.unlink(path).catch(() => {});
  return true;
}

// ---- follow-up prompts (O2) and settings (O3) ------------------------------

/**
 * Queues a message to type into an agent's terminal as if the user sent it. The capture
 * leader delivers it once that agent isn't mid-turn, so it never interrupts work.
 */
export async function queuePrompt(terminal, text) {
  const dir = `${reviewDir()}/outbox`;
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const name = `${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}-${terminal}.json`;
  await writeTextFile(`${dir}/${name}`, JSON.stringify({ terminal, text }), null);
}

/** Delivers queued prompts to agents that are idle; `busy(terminal)` says who is mid-turn. */
export async function drainOutbox(busy, send, log) {
  const dir = `${reviewDir()}/outbox`;
  if (!(await fs.exists(dir))) return;
  for (const name of (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).sort()) {
    const path = `${dir}/${name}`;
    let msg;
    try { msg = JSON.parse(await readTextFile(path)); } catch { await fs.unlink(path).catch(() => {}); continue; }
    if (!terminals().some((t) => t.address === msg.terminal && t.state === "live")) {
      log(`prompt for ${msg.terminal} dropped: terminal is gone`);
      await fs.unlink(path).catch(() => {});
      continue;
    }
    if (busy(msg.terminal)) continue;
    const r = await send(msg.terminal, msg.text);
    log(`prompt to ${msg.terminal}: ${r.code === 0 ? "sent" : `failed ${(r.stderr || r.stdout).trim()}`}`);
    await fs.unlink(path).catch(() => {});
  }
}

const SETTINGS = () => `${reviewDir()}/settings.json`;
export async function loadSettings() {
  const t = await readTextFile(SETTINGS());
  // autosave: save on focus loss and file switch; autosaveDelay: also after typing stops (s, 0 = off).
  return { autoNote: true, editNote: true, autosave: true, autosaveDelay: 0, editor: "wingman", autoPairs: true, autoTags: true, externalEditor: "code", externalCommand: "", inlineCommand: DEFAULT_COMMAND, wordWrap: false, sessionLog: true, hideHerdrPanels: false, formatOnSave: false, problems: true, problemsAfterTurn: false, problemsCommands: {}, ...(t ? JSON.parse(t) : {}) };
}
/** The user's keyboard shortcuts: { "<action>": ["key", ...] }, only the ones changed from the defaults. */
const KEYS = () => `${reviewDir()}/keys.json`;
export async function loadKeys() {
  const t = await readTextFile(KEYS());
  try { return t ? JSON.parse(t) : {}; } catch { return {}; }
}
export async function saveKeys(next) {
  await fs.mkdir(reviewDir(), { recursive: true }).catch(() => {});
  await writeTextFile(KEYS(), JSON.stringify(next, null, 2) + "\n", await readTextFile(KEYS()));
}

export async function saveSettings(next) {
  await writeTextFile(SETTINGS(), JSON.stringify(next, null, 2) + "\n", await readTextFile(SETTINGS()));
}
