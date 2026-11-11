// Crash breadcrumbs for the Changes view (diagnosis of a native abort ~2 s after it becomes shown).
// crumb(text) starts ONE host write and returns: no await, no queue, no read of an earlier file,
// so the last crumbs before an abort have the best chance of reaching disk (main.js's log() queues
// and rewrites a whole file, which loses them).
//
// Files: writeTextFile(path, text, expected) needs the old content to overwrite, so a ring of
// reused slot files can't be written blind. Each window gets a fresh folder instead and every
// crumb a new file (expected null = must not exist):
//   <appHome>/data/wingman-crumbs/<window start ms>-<view>-<rand>/<000..399>.txt
// A line is `<ISO time> <copy view> #<n> <text>`. At most CAP files per folder, then crumbs stop.
// Nothing is deleted or cleaned here (deleting needs exec); remove old folders by hand.
//
// Gating: crumbs are written only from 0 to WINDOW_MS after the Changes copy shows (openCrumbs
// shares the start with every copy), so normal operation writes nothing, not even the folder.
import * as fs from "fs/promises";
import { writeTextFile, appHome, shared, setShared, props } from "herdr";

/** Turn the breadcrumbs off. */
export const CRUMBS = true;

export const KEY = "wingman.crumbWindow";
export const WINDOW_MS = 30000, ALIVE_MS = 10000, CAP = 400;

export const slotName = (n) => `${String(n).padStart(3, "0")}.txt`;
export const inWindow = (at, now, within = WINDOW_MS) => typeof at === "number" && now >= at && now - at < within;
export const crumbLine = (now, view, n, text) => `${new Date(now).toISOString()} ${view} #${n} ${text}\n`;

let localAt = 0; // this copy's own window start (shared() may lag a copy's own setShared)
let run = null; // { at, dir, n, ok, ready }: the folder of the current window

const viewOf = () => { try { return props()?.view ?? "main"; } catch { return "main"; } };

/** A hidden-to-shown transition: opens the window for every copy. Never throws. */
export function openCrumbs() {
  if (!CRUMBS) return;
  try { localAt = Date.now(); setShared(KEY, localAt); } catch {}
}

/**
 * One breadcrumb. `view`: only from a copy of that view (null: any). `within`: only this many ms after
 * the window opened (default: all of it). Never throws, never awaits.
 */
export function crumb(text, view = null, within = WINDOW_MS) {
  if (!CRUMBS) return;
  try {
    const now = Date.now();
    let at = localAt;
    try { const s = shared(KEY); if (typeof s === "number" && s > at) at = s; } catch {}
    if (!inWindow(at, now, within)) return;
    const mine = viewOf();
    if (view && mine !== view) return;
    if (!run || run.at !== at) {
      const dir = `${appHome()}/data/wingman-crumbs/${at}-${mine}-${Math.random().toString(36).slice(2, 6)}`, r = { at, dir, n: 0, ok: false };
      r.ready = fs.mkdir(dir, { recursive: true }).catch(() => {}).then(() => { r.ok = true; });
      run = r;
    }
    if (run.n >= CAP) return;
    const n = run.n++, path = `${run.dir}/${slotName(n)}`, content = crumbLine(now, mine, n, String(text));
    const go = () => { try { Promise.resolve(writeTextFile(path, content, null)).catch(() => {}); } catch {} };
    if (run.ok) go(); else run.ready.then(go);
  } catch {}
}

/** For tests: forget the window and folder. */
export function resetCrumbs() { localAt = 0; run = null; }
