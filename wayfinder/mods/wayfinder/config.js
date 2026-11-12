// Loads and checks wayfinder.json. Pure: no Herdr imports, so it runs under node for tests.
import { validOrg, ENV_NAME } from "./providers/azure.js";
import { templateErrors } from "./launch.js";

export const PROVIDERS = ["github", "azure", "clickup"];
// A Repo's Checkout mode for a Review: a detached worktree (the default) or the branch in the clone itself.
export const CHECKOUTS = ["worktree", "branch"];
// Wayfinder never stores secrets (ADR 0002). A field whose name ends in one of these is an error,
// except the two that hold a variable's name.
const SECRET_KEY = /(^|_|-)?(token|pat|password|secret|access_?token|api_?key)$/i;
const ENV_KEYS = new Set(["patEnv", "tokenEnv"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;

function findSecrets(value, path, out) {
  if (Array.isArray(value)) value.forEach((v, i) => findSecrets(v, `${path}[${i}]`, out));
  else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && !ENV_KEYS.has(k)) out.push(`${path}.${k}: Wayfinder doesn't store secrets. Sign in with the gh or az CLI, or name an environment variable in patEnv (Azure) or tokenEnv (ClickUp).`);
      findSecrets(v, `${path}.${k}`, out);
    }
  }
}

export function defaultRunner(platform) {
  return platform === "windows" ? "wsl:Ubuntu" : "native";
}

export function validRunner(r) {
  return r === "native" || (typeof r === "string" && /^wsl:\S+$/.test(r));
}

function checkProfile(name, p, platform, errors) {
  const at = `profiles.${name}`;
  if (!isObj(p)) { errors.push(`${at}: must be an object`); return null; }
  const runner = p.runner ?? defaultRunner(platform);
  if (!validRunner(runner)) errors.push(`${at}.runner: use "native" or "wsl:<distro>"`);

  const list = (key) => {
    const v = p[key] ?? [];
    if (!Array.isArray(v)) { errors.push(`${at}.${key}: must be a list`); return []; }
    return v;
  };
  const ids = (items, key) => {
    const seen = new Set();
    items.forEach((it, i) => {
      if (!isObj(it) || !isStr(it.id)) errors.push(`${at}.${key}[${i}]: needs an "id"`);
      else if (seen.has(it.id)) errors.push(`${at}.${key}: "${it.id}" is used twice`);
      else seen.add(it.id);
    });
    return seen;
  };

  const accounts = list("accounts"), repos = list("repos"), boards = list("boards");
  const accountIds = ids(accounts, "accounts"), repoIds = ids(repos, "repos");
  ids(boards, "boards");

  accounts.forEach((a, i) => {
    if (!isObj(a)) return;
    const where = `${at}.accounts[${i}]`;
    if (!PROVIDERS.includes(a.provider)) errors.push(`${where}.provider: use one of ${PROVIDERS.join(", ")}`);
    if (a.provider === "github" && !isStr(a.login)) errors.push(`${where}.login: the gh account name`);
    if (a.provider === "azure") {
      if (!validOrg(a.org)) errors.push(`${where}.org: the organization URL, e.g. https://dev.azure.com/<org>`);
      if (a.projects != null && (!Array.isArray(a.projects) || !a.projects.every(isStr))) errors.push(`${where}.projects: a list of project names`);
      if (a.patEnv != null && !(isStr(a.patEnv) && ENV_NAME.test(a.patEnv))) errors.push(`${where}.patEnv: must be an environment variable name in upper case, e.g. AZURE_DEVOPS_PAT`);
    }
    if (a.provider === "clickup" && a.tokenEnv != null && !(isStr(a.tokenEnv) && ENV_NAME.test(a.tokenEnv))) {
      errors.push(`${where}.tokenEnv: must be an environment variable name in upper case, e.g. CLICKUP_API_TOKEN`);
    }
    if (a.prRepos != null) {
      const f = a.prRepos, names = (v) => v == null || (Array.isArray(v) && v.every((r) => isStr(r) && r.includes("/")));
      if (!isObj(f) || (f.mode != null && !["all", "selected", "ignored"].includes(f.mode)) || !names(f.selected) || !names(f.ignored)) {
        errors.push(`${where}.prRepos: { "mode": "all" | "selected" | "ignored", "selected": [...], "ignored": [...] } with "owner/name" (GitHub) or "project/repo" (Azure) names`);
      }
    }
  });
  repos.forEach((r, i) => {
    if (!isObj(r)) return;
    if (!isStr(r.path)) errors.push(`${at}.repos[${i}].path: the local clone's folder`);
    if (r.prRepo != null && !(isStr(r.prRepo) && r.prRepo.includes("/"))) errors.push(`${at}.repos[${i}].prRepo: the Pull Request repo it clones, "owner/name" or "project/repo"`);
    if (r.checkout != null && !CHECKOUTS.includes(r.checkout)) errors.push(`${at}.repos[${i}].checkout: "worktree" (a detached worktree, the default) or "branch" (the branch in the clone itself)`);
    errors.push(...templateErrors(r.review, `${at}.repos[${i}].review`));
  });
  boards.forEach((b, i) => {
    if (!isObj(b)) return;
    const where = `${at}.boards[${i}]`;
    if (!accountIds.has(b.account)) errors.push(`${where}.account: no account "${b.account}" in this profile`);
    if (!isObj(b.ref)) errors.push(`${where}.ref: must be an object`);
    else if (accounts.find((a) => a?.id === b.account)?.provider === "azure" && !(isStr(b.ref.project) && isStr(b.ref.team))) {
      errors.push(`${where}.ref: an Azure Board needs "project" and "team" (and optionally "board")`);
    } else if (accounts.find((a) => a?.id === b.account)?.provider === "clickup" && !isStr(b.ref.list)) {
      errors.push(`${where}.ref: a ClickUp Board needs "list" (the List's id)`);
    }
    for (const r of b.repos ?? []) if (!repoIds.has(r)) errors.push(`${where}.repos: no repo "${r}" in this profile`);
    if (b.trackedStatuses != null && (!Array.isArray(b.trackedStatuses) || !b.trackedStatuses.every(isStr))) {
      errors.push(`${where}.trackedStatuses: a list of state names, or null`);
    }
    errors.push(...templateErrors(b.launch, `${where}.launch`));
  });
  const n = p.notifications ?? {};
  if (!isObj(n) || (n.enabled != null && typeof n.enabled !== "boolean") || (n.minutes != null && !(Number.isInteger(n.minutes) && n.minutes >= 1 && n.minutes <= 60))) {
    errors.push(`${at}.notifications: { "enabled": true | false, "minutes": 1..60 }`);
  }
  const notifications = { enabled: isObj(n) && typeof n.enabled === "boolean" ? n.enabled : true, minutes: isObj(n) && Number.isInteger(n.minutes) && n.minutes >= 1 && n.minutes <= 60 ? n.minutes : 5 };
  // Each Repo carries its Checkout mode, "worktree" by default.
  const withCheckout = repos.map((r) => (isObj(r) ? { ...r, checkout: r.checkout ?? "worktree" } : r));
  return { name, runner, accounts, repos: withCheckout, boards, notifications };
}

// Returns { config, profile, errors }. `profile` is the active one, normalized; null when errors.
export function parseConfig(text, platform) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) {
    return { config: null, profile: null, errors: [`Not valid JSON: ${e.message}`] };
  }
  const errors = [];
  if (!isObj(raw)) return { config: null, profile: null, errors: ["The file must hold a JSON object"] };
  findSecrets(raw, "$", errors);
  if (!isObj(raw.profiles) || Object.keys(raw.profiles).length === 0) {
    errors.push("profiles: add at least one profile");
    return { config: raw, profile: null, errors };
  }
  const profiles = {};
  for (const [name, p] of Object.entries(raw.profiles)) profiles[name] = checkProfile(name, p, platform, errors);
  const active = raw.activeProfile ?? Object.keys(raw.profiles)[0];
  if (!profiles[active]) errors.push(`activeProfile: no profile "${active}"`);
  if (raw.templates != null && !isObj(raw.templates)) errors.push("templates: must be an object");
  else for (const k of ["launch", "review"]) errors.push(...templateErrors(raw.templates?.[k], `templates.${k}`));
  return { config: raw, profile: errors.length ? null : profiles[active], profileNames: Object.keys(profiles), templates: isObj(raw.templates) ? raw.templates : {}, errors };
}
