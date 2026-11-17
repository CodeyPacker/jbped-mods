// Gitr's settings file, <appHome>/gitr.json, and its state file, <appHome>/data/gitr/state.json.
// The state is written by one writer at a time.
import { appHome, readTextFile, writeTextFile } from "herdr";
import * as fs from "fs/promises";

export const settingsPath = () => `${appHome()}/gitr.json`;
export const stateDir = () => `${appHome()}/data/gitr`;
export const statePath = () => `${stateDir()}/state.json`;

export const DEFAULT_SETTINGS = { enter: "worktree", run: null };
export const LAST_LIMIT = 20;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The settings from gitr.json: { settings, errors }. A missing file gives the defaults and no errors.
 *  An unreadable file or a bad value gives the default and a line in `errors`. */
export async function loadSettings() {
  const settings = { ...DEFAULT_SETTINGS }, errors = [];
  const text = await readTextFile(settingsPath()).catch(() => null);
  if (text === null) return { settings, errors };
  let data;
  try { data = JSON.parse(text); } catch (e) { return { settings, errors: [`gitr.json is not valid JSON: ${e?.message ?? e}`] }; }
  if (!isObj(data)) return { settings, errors: ["gitr.json must hold an object."] };
  if ("enter" in data) {
    if (data.enter === "worktree" || data.enter === "checkout") settings.enter = data.enter;
    else errors.push('gitr.json: "enter" must be "worktree" or "checkout".');
  }
  if ("run" in data && data.run !== null) {
    if (Array.isArray(data.run) && data.run.length > 0 && data.run.every((a) => typeof a === "string" && a !== "")) settings.run = data.run;
    else errors.push('gitr.json: "run" must be null or a list of strings, such as ["pwsh"].');
  }
  return { settings, errors };
}

/** The empty state. `last` maps "<machine>\0<identity>" to the last GitState read. */
export const emptyState = () => ({ sort: "recent", remotesOpen: false, last: {} });

/** `last` with at most `limit` Repos: the newest by `at` stay. */
export function trimLast(last, limit = LAST_LIMIT) {
  const entries = Object.entries(last ?? {}).filter(([, v]) => isObj(v));
  if (entries.length <= limit) return Object.fromEntries(entries);
  entries.sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0));
  return Object.fromEntries(entries.slice(0, limit));
}

// The file's text as last read or written: the expected text of the next write. undefined: unread.
let known;

/** The saved state merged over the defaults (missing or mistyped fields filled). */
export async function loadState() {
  const text = await readTextFile(statePath()).catch(() => null);
  known = text;
  const out = emptyState();
  let saved;
  try { saved = JSON.parse(text); } catch { return out; }
  if (!isObj(saved)) return out;
  if (saved.sort === "recent" || saved.sort === "az") out.sort = saved.sort;
  if (typeof saved.remotesOpen === "boolean") out.remotesOpen = saved.remotesOpen;
  if (isObj(saved.last)) out.last = trimLast(saved.last);
  return out;
}

/** One writer: save() keeps the latest state, writes run one at a time, flush() waits for them. */
export function makeSaver() {
  let latest = null, dirty = false, running = null, made = false;
  async function write(text) {
    if (!made) { await fs.mkdir(stateDir(), { recursive: true }).catch(() => {}); made = true; }
    if (known === undefined) known = await readTextFile(statePath()).catch(() => null);
    if (text === known) return;
    try {
      await writeTextFile(statePath(), text, known);
    } catch {
      // The file changed outside: read it again and write once more.
      known = await readTextFile(statePath()).catch(() => null);
      await writeTextFile(statePath(), text, known);
    }
    known = text;
  }
  async function loop() {
    try {
      while (dirty) {
        dirty = false;
        try { await write(JSON.stringify({ ...latest, last: trimLast(latest.last) }) + "\n"); }
        catch (e) { console.log(`gitr: state not saved: ${e?.message ?? e}`); }
      }
    } finally { running = null; }
  }
  return {
    save(state) {
      latest = state; dirty = true;
      if (!running) running = loop();
    },
    flush() { return running ?? Promise.resolve(); },
  };
}
