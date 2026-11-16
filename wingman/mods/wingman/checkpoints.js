// Checkpoints (G4): the working tree of each repo before every agent turn, kept so a turn can be
// listed ("what did it change") and undone ("put everything back to before it").
//
// Capture already snapshots a repo when an agent starts a turn (snapshot.sh: a git tree made with a
// private index). Each snapshot becomes a checkpoint: an entry in <git-dir>/wingman/checkpoints.json
// ({ version, list: [{ id, turn, tree, at, branch, agent, space, files, count, prompt, kind }],
// oldest first) and a ref, refs/wingman/checkpoints/<id>, naming the tree so `git gc` keeps it. A
// ref under refs/wingman/ is never a branch, tag or stash, git log --all leaves a tree ref out, and
// nothing else of the user's (index, HEAD, stash, branches) is touched. At most MAX_CHECKPOINTS
// per repo: the oldest go first, with their refs.
//
// Restore puts every file that differs between a checkpoint's tree and the working tree now (a new
// snapshot) back to the checkpoint's content: modified files rewritten, files created since
// deleted, files deleted since written again. Every write is compare-and-swap (store.swap, the
// path Reject uses). Before it writes, a "before restore" checkpoint of the working tree is
// recorded, so restoring that one goes forward again (see README: why not Ctrl+Z).
//
// The parts that decide (titles, the list, pruning, rows, plans, notes) are pure and tested under
// node; Checkpoints, planRestore and applyRestore run git and file calls through the Store, on
// this computer or another machine alike.
import { swap, MAX_TEXT } from "./store.js";
import { makeDir } from "./fsx.js";
import { Capture, isWriteTemp } from "./capture.js";
import { byteLength } from "./sha256.js";

export const MAX_CHECKPOINTS = 30;
/** Files kept per checkpoint entry (`count` has them all). */
export const MAX_FILES = 500;
export const REF = "refs/wingman/checkpoints/";
export const TITLE_MAX = 80;
/** A prompt counts for a turn when the hook saw it at most this long before the turn started. */
export const PROMPT_WINDOW = 60000;

/** A short title from a prompt: its first non-empty line, control characters dropped, at most TITLE_MAX characters. */
export function titleOf(prompt) {
  const line = String(prompt ?? "").split(/\r?\n/).map((l) => l.replace(/\t/g, " ").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const chars = [...line];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…` : line;
}

// ---- prompts seen by the hook (journal.js), for the capture leader's checkpoints -----------------
const prompts = new Map(); // terminal address -> { title, at }

/** The hook saw `terminal`'s prompt (UserPromptSubmit) at `at`. */
export function notePrompt(terminal, prompt, at = Date.now()) {
  const title = titleOf(prompt);
  if (terminal && title) prompts.set(terminal, { title, at });
  if (prompts.size > 200) prompts.delete(prompts.keys().next().value);
}

/** The title of `terminal`'s prompt for a turn that started at `since`, or null. */
export function promptFor(terminal, since) {
  const p = terminal ? prompts.get(terminal) : null;
  return p && p.at >= since - PROMPT_WINDOW ? p.title : null;
}

/** Forgets every prompt (tests). */
export const forgetPrompts = () => prompts.clear();

// ---- the list ---------------------------------------------------------------------------------

/** A checkpoint id: time and a random part, lowercase letters and digits (a safe ref name). */
export const newId = (at = Date.now(), rnd = Math.random) => `${at.toString(36)}-${rnd().toString(36).slice(2, 8).padEnd(6, "0")}`;
export const validId = (id) => typeof id === "string" && /^[0-9a-z]{1,12}-[0-9a-z]{1,12}$/.test(id);

/** checkpoints.json's text as data; anything unreadable is an empty list. */
export function parse(text) {
  try {
    const d = text ? JSON.parse(text) : null;
    if (d && Array.isArray(d.list)) return { version: 1, list: d.list.filter((e) => e && validId(e.id) && /^[0-9a-f]{40,64}$/.test(e.tree ?? "")) };
  } catch {}
  return { version: 1, list: [] };
}

/** Adds `entry` to `data` (in place), keeping the newest `max`. Returns the ids pruned. */
export function addTo(data, entry, max = MAX_CHECKPOINTS) {
  data.list = data.list.filter((e) => e.id !== entry.id);
  data.list.push(entry);
  data.list.sort((a, b) => a.at - b.at);
  const pruned = data.list.length > max ? data.list.splice(0, data.list.length - max) : [];
  return pruned.map((e) => e.id);
}

/** Sets the files a checkpoint's turn changed (and its prompt, once known) in `data`; false when nothing changed. */
export function patch(data, id, { files, prompt } = {}) {
  const e = data.list.find((x) => x.id === id);
  if (!e) return false;
  let changed = false;
  if (files) {
    const kept = files.slice(0, MAX_FILES);
    if (JSON.stringify(kept) !== JSON.stringify(e.files ?? []) || files.length !== (e.count ?? 0)) { e.files = kept; e.count = files.length; changed = true; }
  }
  if (prompt && !e.prompt) { e.prompt = prompt; changed = true; }
  return changed;
}

/**
 * The rows of a space's checkpoint list, newest first: one per turn (the checkpoints of all its
 * repos together). `repos`: [{ key, name, data }]. Entries made for another space don't show; one
 * without a space (agents of several spaces worked) shows in every space.
 * A row: { id, at, agent, prompt, kind, parts: [{ key, name, entry }], files: [{ key, name, rel }], count }.
 */
export function turnRows(repos, space) {
  const rows = new Map();
  for (const r of repos) for (const e of r.data?.list ?? []) {
    if (e.space && space && e.space !== space) continue;
    const id = e.turn ?? e.id, row = rows.get(id) ?? { id, at: e.at, agent: e.agent ?? null, prompt: e.prompt ?? null, kind: e.kind ?? "turn", parts: [], files: [], count: 0 };
    row.at = Math.min(row.at, e.at); row.agent ??= e.agent ?? null; row.prompt ??= e.prompt ?? null;
    row.parts.push({ key: r.key, name: r.name, entry: e });
    for (const rel of e.files ?? []) row.files.push({ key: r.key, name: r.name, rel });
    row.count += e.count ?? (e.files ?? []).length;
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => b.at - a.at);
}

/** The agents to tell about a restore to `row`: those of that turn and every later turn in `rows` (deduplicated). */
export function agentsSince(rows, row) {
  return [...new Set(rows.filter((r) => r.at >= row.at && r.kind !== "restore").map((r) => r.agent).filter(Boolean))];
}

const pad = (n) => String(n).padStart(2, "0");
/** "14:02" today, "Nov 3 14:02" otherwise (local time). */
export function timeLabel(at, now = Date.now()) {
  const d = new Date(at), n = new Date(now), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return hm;
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getDate()} ${hm}`;
}

const many = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** What a restore plan will do, for the confirm: "Restore 5 files in api (2 created since are deleted, 1 deleted comes back)?" */
export function confirmText(plan, when) {
  const files = plan.parts.flatMap((p) => p.files), del = files.filter((f) => f.after === null).length, back = files.filter((f) => f.before === null).length;
  const repos = [...new Set(plan.parts.filter((p) => p.files.length).map((p) => p.name))];
  const extra = [del ? `${del} created since ${del === 1 ? "is" : "are"} deleted` : "", back ? `${back} deleted since ${back === 1 ? "comes" : "come"} back` : ""].filter(Boolean);
  const skipped = plan.parts.flatMap((p) => p.skipped);
  return `Restore ${many(files.length, "file")}${repos.length ? ` in ${repos.join(", ")}` : ""} to how ${files.length === 1 ? "it was" : "they were"} before this turn (${when})${extra.length ? `: ${extra.join(", ")}` : ""}?`
    + (skipped.length ? ` ${many(skipped.length, "file")} can't be restored and stay${skipped.length === 1 ? "s" : ""} as ${skipped.length === 1 ? "it is" : "they are"}: ${skipped.slice(0, 5).map((s) => `${s.rel} (${s.why})`).join(", ")}${skipped.length > 5 ? ", …" : ""}.` : "");
}

/** The factual note for an agent whose files a restore put back (as a rejection's note). `paths`: as the agent sees them. */
export function restoreNote(paths, when) {
  const shown = paths.slice(0, 10).join(", "), more = paths.length > 10 ? ` and ${paths.length - 10} more` : "";
  return `Code review: the user restored ${many(paths.length, "file")} to how they were before the agent turn at ${when}: ${shown}${more}. Those files are back on disk as they were then (files created since are deleted); read them again before changing them.`;
}

/** The plan's set of files, to tell whether a fresh plan is the one that was confirmed. */
export const planSig = (plan) => plan.parts.map((p) => `${p.key}\0${p.files.map((f) => `${f.rel}\0${f.after === null ? "-" : "+"}`).join("\0")}`).join("\n");

/** Whether a path from git stays inside its repo (never absolute, never "..", never in .git). */
export const safeRel = (rel) => typeof rel === "string" && rel.length > 0 && !rel.includes("\0") && !/^\/|^[A-Za-z]:/.test(rel)
  && !rel.split("/").some((s) => s === ".." || s === "." || s === "" || s.toLowerCase() === ".git");

/** Parses `git diff-tree -r --no-renames -z` (raw): [{ status, path, from, to }] with both modes. */
export function parseRaw(out) {
  const parts = String(out ?? "").split("\0"), res = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])/.exec(parts[i]);
    if (!m) { i--; continue; } // out of step (a trailing empty part): look at the next one
    res.push({ status: m[3], path: parts[i + 1], from: m[1], to: m[2] });
  }
  return res;
}

// ---- git and files ------------------------------------------------------------------------------

/** One repo's checkpoints (Store `store`): the list file and the refs. */
export class Checkpoints {
  constructor(store) { this.store = store; this.path = `${store.dir}/checkpoints.json`; }

  async load() {
    const text = await this.store.read(this.path).catch(() => null);
    return { text, data: parse(text) };
  }

  /** Applies `fn(data)` and writes the list, compare-and-swap with a few retries; `fn` returning false writes nothing. */
  async change(fn) {
    for (let i = 0; ; i++) {
      const { text, data } = await this.load(), r = fn(data);
      if (r === false) return data;
      try { await swap(this.path, text, JSON.stringify(data, null, 2) + "\n", this.store.on); return data; }
      catch (e) { if (i >= 3 || !/changed since it was read/.test(String(e?.message ?? e))) throw e; }
    }
  }

  /**
   * Records a checkpoint of `tree` (a tree id from snapshot.sh): its ref first, then the list entry.
   * Pruned entries' refs go after the list is written. Returns the entry.
   */
  async record({ tree, branch = null, agent = null, space = null, turn = null, prompt = null, kind = "turn", at = Date.now() }) {
    if (!/^[0-9a-f]{40,64}$/.test(tree ?? "")) throw new Error(`not a tree id: ${tree}`);
    const id = newId(at), entry = { id, turn: turn ?? id, tree, at, branch, agent, space, files: [], count: 0, ...(prompt ? { prompt } : {}), ...(kind !== "turn" ? { kind } : {}) };
    const r = await this.store.git(["update-ref", `${REF}${id}`, tree]);
    if (r.code !== 0) throw new Error(`checkpoint ref: ${(r.stderr || r.stdout).trim()}`);
    let pruned = [];
    try { await this.change((d) => { pruned = addTo(d, entry); }); }
    catch (e) { await this.store.git(["update-ref", "-d", `${REF}${id}`]).catch(() => {}); throw e; }
    for (const p of pruned) if (validId(p)) await this.store.git(["update-ref", "-d", `${REF}${p}`]).catch(() => {});
    return entry;
  }

  /** Sets a checkpoint's files (and prompt). Only written when they changed since the last call. */
  async note(id, files, prompt = null) {
    const sig = `${id}\0${prompt ?? ""}\0${files.join("\0")}`;
    if (sig === this.noted) return;
    await this.change((d) => patch(d, id, { files, prompt }));
    this.noted = sig;
  }
}

/**
 * The plan for restoring a turn's checkpoints: for each part ({ store, key, name, entry }), every file
 * that differs between the checkpoint's tree and a snapshot of the working tree now, with its content
 * on disk now (`before`, null: absent) and in the checkpoint (`after`, null: delete). Binary files,
 * links, submodules and texts over 1 MiB can't be written as text: they're `skipped` with why.
 * Throws an Error naming every repo that can't be restored now: an agent is working there (its
 * capture is in a turn), the repo is on another branch than the checkpoint, or the tree is gone.
 */
export async function planRestore(parts, { capture = (st) => new Capture(st) } = {}) {
  const why = [], out = [];
  for (const p of parts) {
    const st = p.store, e = p.entry;
    const cap = await st.read(`${st.dir}/capture.json`).catch(() => null);
    let busy = false;
    try { busy = !!(cap && JSON.parse(cap).tree); } catch {}
    if (busy) { why.push(`an agent is working in ${p.name}: restore once its turn ends`); continue; }
    const branch = await st.branch();
    if (e.branch && branch !== e.branch) { why.push(`this checkpoint of ${p.name} was taken on branch ${e.branch}, and ${p.name} is on ${branch ?? "no branch"} now: switch back to ${e.branch} to restore it`); continue; }
    const ok = await st.git(["cat-file", "-e", `${e.tree}^{tree}`]);
    if (ok.code !== 0) { why.push(`the checkpoint's files are gone from ${p.name}'s git store`); continue; }
    out.push({ ...p, cap: capture(st) });
  }
  if (why.length) throw new Error(`Can't restore: ${why.join("; ")}`);
  const res = [];
  for (const p of out) {
    const st = p.store, tree = p.entry.tree, now = await p.cap.snapshot();
    const d = await st.git(["diff-tree", "-r", "--no-renames", "-z", tree, now]);
    if (d.code !== 0) throw new Error(`diff in ${p.name}: ${d.stderr.trim()}`);
    const files = [], skipped = [];
    for (const c of parseRaw(d.stdout)) {
      if (isWriteTemp(c.path)) continue;
      if (!safeRel(c.path)) { skipped.push({ rel: c.path, why: "an unsafe path" }); continue; }
      const link = (m) => m === "120000" || m === "160000";
      if (link(c.from) || link(c.to)) { skipped.push({ rel: c.path, why: c.from === "160000" || c.to === "160000" ? "a submodule" : "a link" }); continue; }
      const path = `${st.root}/${c.path}`;
      let after = null, before = null;
      if (c.status !== "A") {
        const r = await st.git(["cat-file", "--filters", `${tree}:${c.path}`]);
        if (r.code !== 0) { skipped.push({ rel: c.path, why: "unreadable in the checkpoint" }); continue; }
        if (r.stdout.includes("\0")) { skipped.push({ rel: c.path, why: "binary" }); continue; }
        if (byteLength(r.stdout) > MAX_TEXT) { skipped.push({ rel: c.path, why: "over 1 MB" }); continue; }
        after = r.stdout;
      }
      if (c.status !== "D") {
        try { before = await st.read(path); } catch { skipped.push({ rel: c.path, why: "not readable as text now" }); continue; }
        if (before == null) continue; // gone since the snapshot: nothing to compare against, left alone
        if (before.includes("\0")) { skipped.push({ rel: c.path, why: "binary" }); continue; }
      }
      if (before === after) continue;
      files.push({ rel: c.path, path, before, after });
    }
    res.push({ key: p.key, name: p.name, store: st, entry: p.entry, now, files, skipped });
  }
  return { parts: res };
}

/**
 * Restores a plan (planRestore's, confirmed): first records a "before restore" checkpoint of each
 * repo (its snapshot `now`, under one turn id), then writes each file compare-and-swap, deletions
 * first. `held(keys)`: the file keys ("<root>|<rel>") with unsaved edits in any Wingman copy: any
 * of them refuses the whole restore, naming them, before anything is written. A file that changed
 * since the plan was made isn't written: it's in `failed` with why. Returns { restored, failed, before }.
 */
export async function applyRestore(plan, { held = () => [], space = null, when = "", at = Date.now() } = {}) {
  const keys = plan.parts.flatMap((p) => p.files.map((f) => `${p.store.root}|${f.rel}`)), h = held(keys);
  if (h.length) throw new Error(`Unsaved edits in ${h.map((k) => k.slice(k.indexOf("|") + 1)).join(", ")}: save or discard them in Edit first`);
  const turn = newId(at), before = [];
  for (const p of plan.parts) {
    if (!p.files.length) continue;
    const e = await new Checkpoints(p.store).record({ tree: p.now, branch: await p.store.branch(), space, turn, prompt: `Before restore to ${when}`.trim(), kind: "restore", at });
    before.push(e.id);
  }
  const restored = [], failed = [];
  for (const p of plan.parts) {
    const on = p.store.on ?? null, made = new Set();
    const order = [...p.files.filter((f) => f.after === null), ...p.files.filter((f) => f.after !== null)];
    for (const f of order) {
      try {
        if (f.before === null) {
          const dir = f.path.slice(0, f.path.lastIndexOf("/"));
          if (dir.length > p.store.root.length && !made.has(dir)) { await makeDir(dir, { on }); made.add(dir); }
        }
        await swap(f.path, f.before, f.after, on);
        restored.push({ key: p.key, store: p.store, rel: f.rel, path: f.path, entry: p.entry });
      } catch (e) {
        const msg = String(e?.message ?? e);
        failed.push({ rel: f.rel, why: /changed since it was read/.test(msg) ? "changed since it was checked" : msg });
      }
    }
  }
  return { restored, failed, before };
}
