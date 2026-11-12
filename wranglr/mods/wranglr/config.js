// The config file, <appHome>/wranglr.json: settings, Workspaces, and per-Repo Machines.
// parseConfig is pure. Every field is optional; invalid entries fall back or drop and are named.
import { appHome, readTextFile, writeTextFile } from "herdr";

export const DEFAULT_SETTINGS = {
  sort: "kind",
  plus: "open",
  worktrees: ".worktrees/{branch}",
  autoname: true,
  ticket: "^(?:[a-z]+/)?#?(\\d{2,})",
  agent: null,
};

const SORTS = ["recent", "kind", "az", "manual"];
const PLUS = ["open", "worktree"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);

function parseSettings(raw, errors) {
  const s = { ...(isObj(raw) ? raw : {}) };
  if (raw !== undefined && !isObj(raw)) errors.push("settings: not an object");
  const fall = (key, why) => { errors.push(`settings.${key}: ${why}`); s[key] = DEFAULT_SETTINGS[key]; };
  if (!("sort" in s)) s.sort = DEFAULT_SETTINGS.sort; else if (!SORTS.includes(s.sort)) fall("sort", `must be one of ${SORTS.join(", ")}`);
  if (!("plus" in s)) s.plus = DEFAULT_SETTINGS.plus; else if (!PLUS.includes(s.plus)) fall("plus", `must be one of ${PLUS.join(", ")}`);
  if (!("worktrees" in s)) s.worktrees = DEFAULT_SETTINGS.worktrees; else if (typeof s.worktrees !== "string" || !s.worktrees) fall("worktrees", "must be a path pattern");
  if (!("autoname" in s)) s.autoname = DEFAULT_SETTINGS.autoname; else if (typeof s.autoname !== "boolean") fall("autoname", "must be true or false");
  if (!("ticket" in s)) s.ticket = DEFAULT_SETTINGS.ticket;
  else if (typeof s.ticket !== "string") fall("ticket", "must be a regular expression");
  else { try { new RegExp(s.ticket, "i"); } catch { fall("ticket", "is not a valid regular expression"); } }
  if (!("agent" in s)) s.agent = DEFAULT_SETTINGS.agent;
  else if (s.agent !== null && !(Array.isArray(s.agent) && s.agent.length && s.agent.every((a) => typeof a === "string"))) fall("agent", "must be null or a list of strings");
  return s;
}

// on: { [mkey]: object }, keeping only object entries.
const parseOn = (on) => (isObj(on) ? Object.fromEntries(Object.entries(on).filter(([, v]) => isObj(v))) : {});

function parseWorkspaces(raw, errors) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) { errors.push("workspaces: not a list"); return []; }
  const out = [], names = new Set();
  raw.forEach((w, i) => {
    if (!isObj(w) || typeof w.name !== "string" || !w.name.trim()) { errors.push(`workspaces[${i}]: has no name`); return; }
    if (names.has(w.name)) { errors.push(`workspaces[${i}]: duplicate name "${w.name}"`); return; }
    names.add(w.name);
    out.push({ ...w, repos: strings(w.repos), machines: strings(w.machines), on: parseOn(w.on) });
  });
  return out;
}

function parseRepos(raw, errors) {
  if (raw === undefined) return {};
  if (!isObj(raw)) { errors.push("repos: not an object"); return {}; }
  const out = {};
  for (const [id, r] of Object.entries(raw)) {
    if (!isObj(r)) { errors.push(`repos["${id}"]: not an object`); continue; }
    out[id] = { ...r, machines: strings(r.machines), on: parseOn(r.on) };
  }
  return out;
}

/** The config from the file's text (null or empty: defaults). Always complete; unknown keys kept. */
export function parseConfig(text) {
  const errors = [];
  let raw = {};
  if (text != null && text.trim()) {
    try { raw = JSON.parse(text); } catch (e) { errors.push(`wranglr.json is not valid JSON: ${e.message}`); raw = {}; }
    if (!isObj(raw)) { if (errors.length === 0) errors.push("wranglr.json: not an object"); raw = {}; }
  }
  const config = {
    ...raw,
    settings: parseSettings(raw.settings, errors),
    workspaces: parseWorkspaces(raw.workspaces, errors),
    repos: parseRepos(raw.repos, errors),
  };
  return { config, errors };
}

export const configPath = () => `${appHome()}/wranglr.json`;

export async function loadConfig() {
  const text = await readTextFile(configPath());
  return { ...parseConfig(text), text };
}

/** Sets settings[key] in the file, keeping everything else. Retries when the file changed under us. */
export async function saveSetting(key, value) {
  const path = configPath();
  for (let attempt = 0; ; attempt++) {
    const text = await readTextFile(path);
    let raw = {};
    if (text != null && text.trim()) {
      raw = JSON.parse(text); // A file that is not JSON is left alone: this throws.
      if (!isObj(raw)) throw new Error("wranglr.json is not a JSON object");
    }
    const next = { ...raw, settings: { ...(isObj(raw.settings) ? raw.settings : {}), [key]: value } };
    try {
      await writeTextFile(path, JSON.stringify(next, null, 2) + "\n", text);
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
}
