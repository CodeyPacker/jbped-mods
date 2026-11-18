// The config file, <appHome>/wranglr.json: settings, Workspaces, and per-Repo Machines.
// parseConfig is pure. Every field is optional; invalid entries fall back or drop and are named.
import { appHome, readTextFile, writeTextFile } from "herdr";

export const DEFAULT_SETTINGS = {
  sort: "kind",
  plus: "open",
  worktrees: "{clone}/.worktrees/{branch}",
  autoname: true,
  ticket: "^(?:[a-z]+/)?#?(\\d{2,})",
  agent: null,
  machine: null,
  folder: null,
  agents: true,
  revive: true,
};

const SORTS = ["recent", "kind", "az", "manual"];
const PLUS = ["open", "worktree"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);
// A Machine name as a key of `on`: "" is this computer. __proto__ would not be stored as a key.
const okMachine = (m) => typeof m === "string" && m !== "__proto__";
const absolute = (p) => typeof p === "string" && /^([\/\\]|[A-Za-z]:[\/\\])/.test(p);
// A ref handed to git: one word, and not an option.
const REF = "must be a git ref, such as origin/staging";
const okRef = (r) => typeof r === "string" && /^[^\s-]\S*$/.test(r);

function parseSettings(raw, errors) {
  const s = { ...(isObj(raw) ? raw : {}) };
  if (raw !== undefined && !isObj(raw)) errors.push("settings: not an object");
  const fall = (key, why) => { errors.push(`settings.${key}: ${why}`); s[key] = DEFAULT_SETTINGS[key]; };
  if (!("sort" in s)) s.sort = DEFAULT_SETTINGS.sort; else if (!SORTS.includes(s.sort)) fall("sort", `must be one of ${SORTS.join(", ")}`);
  if (!("plus" in s)) s.plus = DEFAULT_SETTINGS.plus; else if (!PLUS.includes(s.plus)) fall("plus", `must be one of ${PLUS.join(", ")}`);
  if (!("worktrees" in s)) s.worktrees = DEFAULT_SETTINGS.worktrees; else if (!anchored(s.worktrees)) fall("worktrees", ANCHOR);
  if (!("autoname" in s)) s.autoname = DEFAULT_SETTINGS.autoname; else if (typeof s.autoname !== "boolean") fall("autoname", "must be true or false");
  if (!("ticket" in s)) s.ticket = DEFAULT_SETTINGS.ticket;
  else if (typeof s.ticket !== "string") fall("ticket", "must be a regular expression");
  else { try { new RegExp(s.ticket, "i"); } catch { fall("ticket", "is not a valid regular expression"); } }
  if (!("agent" in s)) s.agent = DEFAULT_SETTINGS.agent;
  else if (s.agent !== null && !(Array.isArray(s.agent) && s.agent.length && s.agent.every((a) => typeof a === "string"))) fall("agent", "must be null or a list of strings");
  if (!("agents" in s)) s.agents = DEFAULT_SETTINGS.agents; else if (typeof s.agents !== "boolean") fall("agents", "must be true or false");
  if (!("revive" in s)) s.revive = DEFAULT_SETTINGS.revive; else if (typeof s.revive !== "boolean") fall("revive", "must be true or false");
  if (!("folder" in s)) s.folder = DEFAULT_SETTINGS.folder;
  else if (s.folder !== null && !(absolute(s.folder) && !/[\r\n]/.test(s.folder))) fall("folder", "must be an absolute path, or null for the home folder");
  if (!("machine" in s)) s.machine = DEFAULT_SETTINGS.machine;
  else if (s.machine !== null && !okMachine(s.machine)) fall("machine", 'must be a Machine name, "" for this computer, or null');
  return s;
}

/** Why this value cannot be that setting, or null when it can. */
export function settingError(key, value) {
  const errors = [];
  parseSettings({ [key]: value }, errors);
  return errors.length ? errors[0].replace(/^settings\.\w+: /, "") : null;
}

// on: { [mkey]: object }, keeping only object entries.
const parseOn = (on) => (isObj(on) ? Object.fromEntries(Object.entries(on).filter(([, v]) => isObj(v))) : {});

// A worktrees pattern says where it starts: at the Repo's clone on that Machine ({clone}), or at an absolute path.
const ANCHOR = "must start with {clone} or be an absolute path";
const anchored = (p) => typeof p === "string" && (p.startsWith("{clone}") || absolute(p));

// A Repo's own worktree settings: where they go (`worktrees`) and the ref a new branch starts from (`from`).
// One that is not a non-empty string is dropped and named.
function pattern(entry, where, errors) {
  if ("worktrees" in entry && !anchored(entry.worktrees)) { errors.push(`${where}.worktrees: ${ANCHOR}`); delete entry.worktrees; }
  if ("from" in entry && !okRef(entry.from)) { errors.push(`${where}.from: ${REF}`); delete entry.from; }
  return entry;
}

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
    out[id] = pattern({ ...r, machines: strings(r.machines), on: parseOn(r.on) }, `repos["${id}"]`, errors);
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

// Reads the file, applies `change` to its JSON and writes it back, keeping every other key.
// The write is compare-and-swap: when the file changed under us it is read and changed again.
// A file that is not JSON is left alone, and so is a change that would add a config problem.
async function edit(change) {
  const path = configPath();
  for (let attempt = 0; ; attempt++) {
    const text = await readTextFile(path);
    let raw = {};
    if (text != null && text.trim()) {
      try { raw = JSON.parse(text); } catch { throw new Error("wranglr.json is not valid JSON, so it was left as it is"); }
      if (!isObj(raw)) throw new Error("wranglr.json is not a JSON object, so it was left as it is");
    }
    const out = JSON.stringify(change(raw), null, 2) + "\n";
    if (out === text) return;
    if (parseConfig(out).errors.length > parseConfig(text).errors.length) throw new Error("that change would break wranglr.json, so it was not saved");
    try {
      await writeTextFile(path, out, text);
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
    }
  }
}

/** Sets several settings in one write. Nothing is written when one of them is not valid. */
export async function saveSettings(values) {
  if (!isObj(values)) throw new Error("settings are not an object");
  for (const [key, value] of Object.entries(values)) {
    if (!(key in DEFAULT_SETTINGS)) throw new Error(`${key} is not a setting`);
    const why = settingError(key, value);
    if (why) throw new Error(`${key} ${why}`);
  }
  await edit((raw) => ({ ...raw, settings: { ...(isObj(raw.settings) ? raw.settings : {}), ...values } }));
}

/** Sets settings[key] in the file, keeping everything else. */
export const saveSetting = (key, value) => saveSettings({ [key]: value });

const GROUP_FIELDS = { workspace: ["machines", "homes"], repo: ["machines", "worktrees", "from"], custom: ["machines"] };

/**
 * What is wrong with a Group's settings, as { field: why }, empty when nothing is.
 * values: machines (priority list), and for a Repo worktrees and from ("" removes it),
 * for a Workspace homes: { [machine]: folder } ("" removes it; its field is `home:<machine>`).
 */
export function groupError(kind, values) {
  const fields = GROUP_FIELDS[kind];
  if (!fields || !isObj(values)) return { settings: "are not valid" };
  const bad = {};
  for (const k of Object.keys(values)) if (!fields.includes(k)) bad[k] = "is not a setting of this Group";
  if ("machines" in values && !bad.machines) {
    const m = values.machines;
    if (!Array.isArray(m) || !m.every(okMachine)) bad.machines = "must be a list of Machine names";
    else if (new Set(m).size !== m.length) bad.machines = "names a Machine twice";
  }
  if ("worktrees" in values && !bad.worktrees && values.worktrees !== "" && !anchored(values.worktrees)) bad.worktrees = ANCHOR;
  if ("from" in values && !bad.from && values.from !== "" && !okRef(values.from)) bad.from = REF;
  if ("homes" in values && !bad.homes) {
    if (!isObj(values.homes)) bad.homes = "must be a folder for each Machine";
    else for (const [mk, home] of Object.entries(values.homes))
      if (!okMachine(mk) || (home !== "" && !absolute(home))) bad[`home:${mk}`] = "must be an absolute path";
  }
  return bad;
}

/** Writes a Workspace's (key: its name) or a Repo's (key: its id) settings. Only the given fields change. */
export async function saveGroup(kind, key, values) {
  if (kind !== "workspace" && kind !== "repo") throw new Error("only a Workspace or a Repo has settings in wranglr.json");
  if (typeof key !== "string" || !key || key === "__proto__") throw new Error("no such Group");
  const bad = Object.entries(groupError(kind, values))[0];
  if (bad) throw new Error(`${bad[0]} ${bad[1]}`);
  await edit((raw) => {
    let entry;
    if (kind === "workspace") {
      entry = Array.isArray(raw.workspaces) ? raw.workspaces.find((w) => isObj(w) && w.name === key) : null;
      if (!entry) throw new Error(`the Workspace "${key}" is not in wranglr.json`);
    } else {
      if (raw.repos === undefined) raw.repos = {};
      if (!isObj(raw.repos)) throw new Error("repos in wranglr.json is not an object");
      if (!Object.hasOwn(raw.repos, key)) raw.repos[key] = {};
      entry = raw.repos[key];
      if (!isObj(entry)) throw new Error(`repos["${key}"] in wranglr.json is not an object`);
    }
    // An empty list is only written over a list that is there.
    if ("machines" in values && (values.machines.length || "machines" in entry)) entry.machines = [...values.machines];
    for (const k of ["worktrees", "from"]) {
      if (!(k in values)) continue;
      if (values[k]) entry[k] = values[k]; else delete entry[k];
    }
    for (const [mk, home] of Object.entries(values.homes ?? {})) {
      if (home) {
        if (!isObj(entry.on)) entry.on = {};
        if (!isObj(entry.on[mk])) entry.on[mk] = {};
        entry.on[mk].home = home;
      } else if (isObj(entry.on) && isObj(entry.on[mk])) {
        delete entry.on[mk].home;
        if (!Object.keys(entry.on[mk]).length) delete entry.on[mk];
      }
    }
    if (kind === "repo") {
      if (!Object.keys(entry).length) delete raw.repos[key];
      if (!Object.keys(raw.repos).length) delete raw.repos;
    }
    return raw;
  });
}
