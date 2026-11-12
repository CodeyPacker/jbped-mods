// Wranglr's state file, <appHome>/data/wranglr/state.json, written by one writer at a time.
import { appHome, readTextFile, writeTextFile } from "herdr";
import * as fs from "fs/promises";

export const stateDir = () => `${appHome()}/data/wranglr`;
export const statePath = () => `${stateDir()}/state.json`;

// The file's text as last read or written: the expected text of the next write. undefined: unread.
let known;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The saved State merged over `empty` (missing or mistyped fields filled), else `empty`. */
export async function loadState(empty) {
  const text = await readTextFile(statePath()).catch(() => null);
  known = text;
  let saved;
  try { saved = JSON.parse(text); } catch { return empty; }
  if (!isObj(saved)) return empty;
  const out = { ...saved };
  for (const [k, def] of Object.entries(empty)) {
    const v = saved[k];
    if (isObj(def)) out[k] = isObj(v) ? { ...def, ...v } : def;
    else if (Array.isArray(def)) out[k] = Array.isArray(v) ? v : def;
    else out[k] = v !== undefined && typeof v === typeof def ? v : def;
  }
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
        try { await write(JSON.stringify(latest) + "\n"); }
        catch (e) { console.log(`wranglr: state not saved: ${e?.message ?? e}`); }
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
