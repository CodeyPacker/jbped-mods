// The Problems tab in the Edit view's left column, and what feeds it: the project's own checkers
// (problems.js decides which and parses them) run one-shot where the repo's tools run, the way
// Inline edit runs its command (main.js inlineWhere: sh -lc with a fixed script on Linux, macOS and
// another machine, wsl.exe for a repo WSL owns, a native .exe otherwise on Windows). Arguments are
// always an argv array: no file name, setting or output is ever put into a shell string.
//
// One per copy (main.js: this.problems), and only the copy that owns Problems acts: the Edit
// panel's, else a pane copy when the layout has no Edit panel (the rule inlineEdit uses). Results
// are kept per repo (by idOf), so a run that ends after a space switch lands in its own repo's list.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, readTextFile, agents, terminals, panes, hc, spaces, shared } from "herdr";
import { PROBE_SH, parseProbe, dot, probes, ancestors, wantsListing, detect, parse, capOutput, failureLine, RunQueue, capDiags, shiftDiags, byLine, worst, problemRows, stepProblem, countText, buildProblemsPrompt, stripText, MAX_DIAGS } from "./problems.js";
import { plan as runPlan } from "./inlineedit.js";
import { chooseTarget, isWslArgv, promptProblem, sendToAgent } from "./commentprompt.js";
import { listDir, execOn } from "./fsx.js";
import { onWindows, toWsl } from "./git.js";
import { idOf } from "./remote.js";
import { ACTIVE } from "./captureloop.js";
import { fitBar, withKey } from "./barfit.js";

/** Check pressed in a copy that doesn't own Problems: { space, stamp } for the owner copy (tick). */
export const PROBLEMS_REQ = "wingman.problemsReq";
const PROBE_MS = 30000; // how long what exists in a folder is trusted
const WHERE_MS = 60000; // how long where a program runs from is trusted
const OPEN_DEBOUNCE = 400; // ms after a file opens before its checkers are looked for
const PROW = 22; // a row's height

const many = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export class Problems {
  /** opts: { log, agentLabel, hasView } from main.js (module functions there). */
  constructor(host, opts) {
    this.host = host; this.opts = opts;
    this.repos = new Map(); // repo id -> { id, store, units: Map<unit, { spec, diags, anchors, at, ms }>, failures: Map<unit, line>, running: Map<unit, name>, known: Map<unit, spec>, list, more, byRel, version, note }
    this.queue = new RunQueue();
    this.cache = new Map(); // `${repo}|${path}` -> { at, yes } and `${repo}|ls|${dir}` -> { at, names }
    this.whereCache = new Map();
    this.ui = new Map(); // space -> { sel, collapsed, ver, pick, confirmTo, note }
    this.openAt = new Map(); // file key -> stamp of the newest open (debounce)
    this.agentSeen = new Map(); // agent address -> status, for "Check after each agent turn"
    this.scroll = VirtualListScrollHandle.new();
    this.h = 300;
    this.reqSeen = Date.now(); // requests from before this copy started are old
  }

  // ---- who acts ---------------------------------------------------------------

  /** Whether this copy runs checkers and shows Problems: the Edit panel's copy, else a pane copy with no Edit panel. */
  owner() { const h = this.host; return !h.form && h.role !== "capture" && (h.view === "edit" || (!h.view && !this.opts.hasView("edit"))); }

  /** The master setting (on by default). */
  enabled() { return this.host.settings?.problems !== false; }

  repo(store) {
    const id = idOf(store);
    let R = this.repos.get(id);
    if (!R) { R = { id, store, units: new Map(), failures: new Map(), running: new Map(), known: new Map(), list: [], more: 0, byRel: new Map(), version: 0, note: null }; this.repos.set(id, R); }
    R.store = store;
    return R;
  }

  uiOf(space = this.host.spaceId) {
    let u = this.ui.get(space);
    if (!u) { u = { sel: null, collapsed: new Set(), ver: 0, pick: null, confirmTo: null, note: null }; this.ui.set(space, u); }
    return u;
  }

  /** The shown space's git repos with a Problems state. */
  shownRepos() { return this.host.stores.filter((st) => !st.plain).map((st) => this.repo(st)); }

  // ---- detection ---------------------------------------------------------------

  /** The set of `paths` (relative to the store's root) that exist, cached for PROBE_MS. */
  async existing(store, paths, dirs) {
    const id = idOf(store), now = Date.now(), yes = new Set(), lists = new Map();
    const fresh = (k) => { const c = this.cache.get(k); return c && now - c.at < PROBE_MS ? c : null; };
    const askPaths = paths.filter((p) => { const c = fresh(`${id}|${p}`); if (c?.yes) yes.add(p); return !c; });
    const askDirs = dirs.filter((d) => { const c = fresh(`${id}|ls|${d}`); if (c) lists.set(d, c.names); return !c; });
    if (!askPaths.length && !askDirs.length) return { yes, lists };
    const on = store.on ?? null;
    if (on) {
      // One call there for everything: each read would be a round trip.
      let r;
      try { r = await execOn("sh", ["-c", PROBE_SH, "wingman", ...askPaths.map(dot), "--", ...askDirs.map(dot)], { cwd: store.root, on, timeout: 15000 }); }
      catch (e) { throw new Error(/cannot start sh/i.test(String(e?.message ?? e)) ? `Problems need sh on ${on}` : String(e?.message ?? e)); }
      if (r.code !== 0) throw new Error(`Looking for checkers on ${on} failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}`);
      const { found, names } = parseProbe(r.stdout, askDirs);
      for (const p of askPaths) { this.cache.set(`${id}|${p}`, { at: now, yes: found.has(p) }); if (found.has(p)) yes.add(p); }
      for (const d of askDirs) { this.cache.set(`${id}|ls|${d}`, { at: now, names: names.get(d) }); lists.set(d, names.get(d)); }
      return { yes, lists };
    }
    // Here: reads in this process (a missing file is null), and a folder listing only for dotnet.
    await Promise.all(askPaths.map(async (p) => {
      const t = await readTextFile(`${store.root}/${p}`).catch(() => null);
      this.cache.set(`${id}|${p}`, { at: now, yes: t != null });
      if (t != null) yes.add(p);
    }));
    await Promise.all(askDirs.map(async (d) => {
      const names = await listDir(d ? `${store.root}/${d}` : store.root, { limit: 2000 }).then((l) => l.entries.filter((e) => !e.dir).map((e) => e.name)).catch(() => []);
      this.cache.set(`${id}|ls|${d}`, { at: now, names }); lists.set(d, names);
    }));
    return { yes, lists };
  }

  /** The checkers for `rel` in `store` (null: the repo as a whole). */
  async detectFor(store, rel) {
    const dirs = wantsListing(rel) ? ancestors(rel) : [];
    const { yes, lists } = await this.existing(store, probes(rel), dirs);
    const custom = this.host.settings?.problemsCommands?.[idOf(store)] ?? null;
    return detect(rel, { exists: (p) => yes.has(p), listing: (d) => lists.get(d) ?? [], custom });
  }

  // ---- when they run -----------------------------------------------------------

  /** A file was opened: its file-scope checkers run after a short pause (a newer open of it wins). */
  opened(store, rel, cx) {
    if (!this.owner() || !this.enabled() || !store || store.plain) return;
    const key = `${idOf(store)}|${rel}`, stamp = Date.now();
    this.openAt.set(key, stamp);
    cx.timer.after(OPEN_DEBOUNCE, (cx) => {
      if (this.openAt.get(key) !== stamp) return;
      this.openAt.delete(key);
      cx.spawn(async (cx) => this.runFile(store, rel, cx));
    });
  }

  /** An explicit save of `f`: once its writes are done (`queue`), its file-scope checkers run. */
  saved(f, queue, cx) {
    if (!f?.store || f.store.plain || !this.owner() || !this.enabled()) return;
    const store = f.store, rel = f.rel;
    cx.spawn(async (cx) => { await queue?.catch?.(() => {}); await this.runFile(store, rel, cx); });
  }

  /** The file's file-scope checkers now; its project checkers are remembered for Check. */
  async runFile(store, rel, cx) {
    const R = this.repo(store);
    let specs;
    try { specs = await this.detectFor(store, rel); R.note = null; }
    catch (e) { R.note = String(e?.message ?? e); this.host.paint(cx); return; }
    for (const s of specs) if (s.scope === "project" && s.id !== "custom") R.known.set(s.unit, s);
    for (const s of specs) if (s.scope === "file") this.request(store, s, cx);
  }

  /**
   * Check (the command, the button, the key, after an agent's turn): the project checkers of
   * `space`'s repos, those found at the root and from the files opened, and the current file's
   * own checkers. A repo with none detected gets a note, and nothing runs there.
   */
  checkNow(cx, space = this.host.spaceId) {
    if (!this.enabled()) { this.uiOf(space).note = "Problems are off in Settings"; this.host.paint(cx); return; }
    const s = this.host.stateOf(space), stores = (s?.stores ?? []).filter((st) => !st.plain);
    if (!stores.length) { this.uiOf(space).note = "No git repo in this space to check"; this.host.paint(cx); return; }
    const f = space === this.host.spaceId ? this.host.file() : null;
    this.uiOf(space).note = null;
    cx.spawn(async (cx) => {
      for (const st of stores) {
        const R = this.repo(st);
        let specs = [];
        try {
          specs = [...await this.detectFor(st, null), ...(f && f.store === st ? await this.detectFor(st, f.rel) : [])];
          R.note = null;
        } catch (e) { R.note = String(e?.message ?? e); continue; }
        // Built-in project checkers are remembered (a sub-project's tsc found from a file opened
        // there); the repo's own project command, read fresh each time, takes their place.
        for (const sp of specs) if (sp.scope === "project" && sp.id !== "custom") R.known.set(sp.unit, sp);
        const own = specs.find((sp) => sp.scope === "project" && sp.id === "custom");
        const run = new Map(own ? [[own.unit, own]] : [...R.known]);
        for (const sp of specs) if (sp.scope === "file") run.set(sp.unit, sp);
        // A project checker that no longer applies takes its list and its failure line with it.
        let gone = false;
        for (const u of [...R.units.keys(), ...R.failures.keys()]) {
          const scope = R.units.get(u)?.spec.scope ?? (u.startsWith("eslint|") || /^custom\|./.test(u) ? "file" : "project");
          if (scope === "project" && !run.has(u)) { R.units.delete(u); R.failures.delete(u); gone = true; }
        }
        if (gone) this.rebuild(R);
        if (!run.size) { R.note = `No checker found in ${this.host.repoName(st)}: eslint, tsc or dotnet with its config, or a Problems command in Settings`; continue; }
        for (const sp of run.values()) this.request(st, sp, cx);
      }
      this.host.paint(cx);
    });
  }

  /** Every second (owner): an agent that ended a turn starts a check of its space, when the setting is on. */
  tick(cx) {
    if (!this.owner()) return;
    const req = shared(PROBLEMS_REQ);
    if (req && req.stamp > this.reqSeen) { this.reqSeen = req.stamp; if (this.host.stateOf(req.space)) this.checkNow(cx, req.space); }
    const on = this.enabled() && this.host.settings?.problemsAfterTurn === true;
    const live = new Set();
    for (const a of agents()) {
      live.add(a.address);
      const was = this.agentSeen.get(a.address);
      this.agentSeen.set(a.address, a.status);
      if (on && was && ACTIVE.has(was) && !ACTIVE.has(a.status) && this.host.stateOf(a.space)) this.checkNow(cx, a.space);
    }
    for (const k of [...this.agentSeen.keys()]) if (!live.has(k)) this.agentSeen.delete(k);
  }

  /** Starts `spec` in `store` unless the same checker runs there: then it runs once more after (RunQueue). */
  request(store, spec, cx) {
    const R = this.repo(store), key = `${R.id}|${spec.unit}`;
    if (!this.queue.claim(key, { store, spec })) return;
    R.running.set(spec.unit, spec.name);
    this.host.paint(cx);
    cx.spawn(async (cx) => {
      let job = { store, spec };
      try {
        while (job) {
          await this.runOnce(job.store, job.spec, cx);
          const next = this.queue.finish(key);
          job = next === true ? job : next;
        }
      } finally { R.running.delete(spec.unit); this.host.paint(cx); }
    });
  }

  /** Where `argv[0]` runs for `store` (main.js inlineWhere), cached. */
  async whereFor(store, name) {
    const k = `${idOf(store)}|${name}`, c = this.whereCache.get(k);
    if (c && Date.now() - c.at < WHERE_MS) return c.where;
    const where = await this.host.inlineWhere(store, name);
    this.whereCache.set(k, { at: Date.now(), where });
    return where;
  }

  /** The texts (as saved) of the repo's files loaded in any space of this copy: what a run now reads. */
  loadedTexts(store) {
    const id = idOf(store), out = new Map(), h = this.host;
    for (const files of [h.files ?? [], ...[...(h.views?.values() ?? [])].map((v) => v.files ?? [])])
      for (const f of files) if (f.store && idOf(f.store) === id && !out.has(f.rel)) { const t = typeof f.diskC === "string" ? f.diskC : f.Ctext; if (typeof t === "string") out.set(f.rel, t); }
    return out;
  }

  async runOnce(store, spec, cx) {
    const R = this.repo(store), started = Date.now(), anchors = this.loadedTexts(store);
    const abs = spec.cwd ? `${store.root}/${spec.cwd}` : store.root;
    let r;
    try {
      const w = await this.whereFor(store, spec.argv[0]);
      const p = runPlan(spec.argv, { ...w, cwd: abs, wslCwd: toWsl(abs), timeout: spec.timeout });
      r = await (p.opts.on ? execOn(p.cmd, p.args, p.opts) : exec(p.cmd, p.args, p.opts));
    } catch (e) { r = e instanceof Error ? e : new Error(String(e?.message ?? e)); }
    const elapsed = Date.now() - started;
    const roots = [store.root, ...(onWindows() && !store.on ? [toWsl(store.root)] : [])];
    const ctx = { root: store.root, roots, cwd: spec.cwd, source: spec.name };
    let res = { diags: [], notes: [] };
    if (!(r instanceof Error)) {
      const out = spec.parser === "eslint-json" ? capOutput(r.stdout) : `${capOutput(r.stdout)}\n${capOutput(r.stderr)}`;
      res = parse(spec.parser, out, ctx);
    }
    // A file-scope run reports that file only.
    const fileRel = spec.scope === "file" ? spec.unit.slice(spec.unit.indexOf("|") + 1) : null;
    const diags = (fileRel ? res.diags.filter((d) => d.rel === fileRel) : res.diags).slice(0, MAX_DIAGS * 2).map((d) => ({ ...d, unit: spec.unit }));
    const why = failureLine(spec.name, r, { elapsed, timeout: spec.timeout, parsed: diags.length, notes: res.notes, unparsed: res.unparsed });
    this.opts.log(`problems ${spec.name} in ${store.root}${spec.cwd ? `/${spec.cwd}` : ""}: ${r instanceof Error ? `error ${r.message}` : `exit ${r.code}`}, ${diags.length} found in ${elapsed} ms${why ? ` (${why})` : ""}`);
    // A run that failed keeps the last good list (it says why above it); a good one replaces it.
    if (why) R.failures.set(spec.unit, why);
    else {
      R.failures.delete(spec.unit);
      R.units.set(spec.unit, { spec, diags, anchors, at: Date.now(), ms: elapsed });
      if (!diags.length && spec.scope === "file") R.units.delete(spec.unit);
    }
    R.lastMs = elapsed;
    this.rebuild(R);
    this.host.paint(cx);
  }

  /** The repo's list from its runs: errors first, capped at MAX_DIAGS. */
  rebuild(R) {
    const all = [];
    for (const u of R.units.values()) all.push(...u.diags);
    const { diags, more } = capDiags(all);
    R.list = diags; R.more = more; R.version++;
    R.byRel = new Map();
    for (const d of diags) { if (!R.byRel.has(d.rel)) R.byRel.set(d.rel, []); R.byRel.get(d.rel).push(d); }
    for (const u of this.ui.values()) u.ver++;
  }

  // ---- reading them --------------------------------------------------------------

  /**
   * The problems of a loaded file `f`, placed in its text as it is now (lines moved by edits since
   * the run, edited ones stale): { list, lines: Map line -> diags }, or null. Cached on the file.
   */
  forFile(f) {
    if (!this.owner() || !this.enabled() || !f?.store || f.store.plain) return null;
    const R = this.repos.get(idOf(f.store)), ds = R?.byRel.get(f.rel);
    if (!ds) return null;
    if (f._pb && f._pb.ver === R.version && f._pb.text === f.Ctext) return f._pb;
    const groups = new Map();
    for (const d of ds) { if (!groups.has(d.unit)) groups.set(d.unit, []); groups.get(d.unit).push(d); }
    const list = [];
    for (const [unit, g] of groups) {
      const U = R.units.get(unit);
      if (typeof f.Ctext !== "string" || !U) { list.push(...g); continue; }
      // A file not loaded when the run started: its text when first shown is taken as what was checked.
      if (!U.anchors.has(f.rel)) U.anchors.set(f.rel, f.Ctext);
      list.push(...shiftDiags(g, U.anchors.get(f.rel), f.Ctext));
    }
    f._pb = { ver: R.version, text: f.Ctext, list, lines: byLine(list) };
    return f._pb;
  }

  /** "error", "warning" or null for a file in the tree or a tab. */
  mark(store, rel) {
    if (!this.owner() || !this.enabled() || !store || store.plain) return null;
    return worst(this.repos.get(idOf(store))?.byRel.get(rel));
  }

  /** The shown space's problem files: [{ key, root, rel, st, diags }] (loaded files: placed in their text now). */
  files() {
    const h = this.host, out = [];
    for (const R of this.shownRepos()) {
      for (const [rel, ds] of R.byRel) {
        const key = `${R.store.root}|${rel}`, f = h.files.find((x) => x.key === key && !x.lazy);
        out.push({ key, root: R.store.root, rel, st: R.store, diags: (f && this.forFile(f)?.list) || ds });
      }
    }
    return out;
  }

  rows() {
    const u = this.uiOf();
    const text = this.host.file()?.Ctext; // the shown file being edited moves its problems (forFile)
    if (u._rows && u._rowsVer === u.ver && u._rowsN === this.host.files && u._rowsText === text) return u._rows;
    u._rows = problemRows(this.files(), u.collapsed); u._rowsVer = u.ver; u._rowsN = this.host.files; u._rowsText = text;
    return u._rows;
  }

  count() { return this.shownRepos().reduce((n, R) => n + R.list.length, 0); }

  /** The messages for the cursor's line in the shown file: the status strip's text and colour, or null. */
  strip(f, line) {
    const pb = line == null ? null : this.forFile(f), ds = pb?.lines.get(line);
    if (!ds?.length) return null;
    return { text: stripText(ds), severity: worst(ds), stale: ds.every((d) => d.stale) };
  }

  // ---- moving around -------------------------------------------------------------

  /** f8 / shift-f8: the next or previous problem, in the file first, then across files. */
  step(dir, cx) {
    const h = this.host, f = h.file();
    const at = f ? { key: f.key, line: h.cur?.line ?? -1, col: h.cur?.col ?? -1 } : null;
    const hit = stepProblem(this.files(), at, dir);
    if (!hit) { this.uiOf().note = this.count() ? null : "No problems to go to"; h.paint(cx); return; }
    this.open(hit.file, hit.d, cx, true);
  }

  /** Opens a problem's file at its line and column; `toEditor` gives the editor the keyboard. */
  open(file, d, cx, toEditor) {
    const h = this.host, u = this.uiOf();
    const rows = this.rows(), i = rows.findIndex((r) => r.kind === "diag" && r.d === d);
    if (i >= 0) { u.sel = rows[i].key; this.scroll.scroll_to_item(i); }
    cx.spawn(async (cx) => {
      await h.openFile(file.st, file.rel, cx, { line: Math.max(0, d.line - 1), col: Math.max(0, d.col - 1) });
      h.problemsFocus = !toEditor;
      if (toEditor) h.handle.focus();
      h.paint(cx);
    });
  }

  move(by, cx) {
    const u = this.uiOf(), rows = this.rows();
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.key === u.sel);
    i = i < 0 ? (by > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + by));
    u.sel = rows[i].key; this.scroll.scroll_to_item(i); this.host.paint(cx);
  }

  fold(open, cx) {
    const u = this.uiOf(), row = this.rows().find((r) => r.key === u.sel);
    if (!row) return;
    if (row.kind === "diag" && !open) { u.sel = `f|${row.file.key}`; this.host.paint(cx); return; }
    if (row.kind === "file") this.toggle(row.file.key, open, cx);
  }

  toggle(key, open, cx) {
    const u = this.uiOf(), shut = u.collapsed.has(key);
    if (open === !shut) return;
    if (shut) u.collapsed.delete(key); else u.collapsed.add(key);
    u.ver++; this.host.paint(cx);
  }

  enter(cx) {
    const u = this.uiOf(), row = this.rows().find((r) => r.key === u.sel);
    if (!row) return;
    if (row.kind === "file") this.toggle(row.file.key, u.collapsed.has(row.file.key), cx);
    else this.open(row.file, row.d, cx, true);
  }

  click(key, cx) {
    const u = this.uiOf(), row = this.rows().find((r) => r.key === key);
    if (!row) return;
    u.sel = key;
    this.host.handle.focus(); this.host.problemsFocus = true; this.host.searchFocus = false; this.host.treeFocus = false;
    if (row.kind === "diag") return this.open(row.file, row.d, cx, false);
    this.toggle(row.file.key, u.collapsed.has(row.file.key), cx);
    this.host.paint(cx);
  }

  /** Keys while the list has the keyboard; true when handled (other keys never type into the editor). */
  key(k, cx) {
    const h = this.host;
    if (!h.problemsShown()) { h.problemsFocus = false; return false; }
    const go = { up: () => this.move(-1, cx), down: () => this.move(1, cx), enter: () => this.enter(cx),
      left: () => this.fold(false, cx), right: () => this.fold(true, cx), escape: () => { h.problemsFocus = false; h.paint(cx); } }[k];
    if (go) { go(); return true; }
    const id = h.kIdx.pane.get(k);
    if (id) h.act(id, cx);
    return true;
  }

  // ---- to the agent ----------------------------------------------------------------

  /** The selected row's file, or null. */
  selectedFile() {
    const u = this.uiOf(), row = this.rows().find((r) => r.key === u.sel);
    return row?.file ?? null;
  }

  /** The problems to send: the selected file's (`file`) or all of the shown space's. */
  picked(file) { return file ? [...file.diags] : this.files().flatMap((x) => x.diags); }

  /** The prompt for `diags`, paths as agent `address` sees them, each source line quoted (read from disk when the file isn't open). */
  async prompt(diags, address) {
    const h = this.host, texts = new Map();
    for (const f of h.files) if (typeof f.Ctext === "string") texts.set(f.key, f.Ctext);
    const want = [...new Set(diags.map((d) => `${d.root}|${d.rel}`))].filter((k) => !texts.has(k)).slice(0, 100);
    const stores = new Map(this.shownRepos().map((R) => [R.store.root, R.store]));
    await Promise.all(want.map(async (k) => {
      const i = k.indexOf("|"), root = k.slice(0, i), rel = k.slice(i + 1), st = stores.get(root);
      const t = await readTextFile(`${root}/${rel}`, { on: st?.on ?? null }).catch(() => null);
      if (typeof t === "string") texts.set(k, t);
    }));
    const lineOf = (d) => { const t = texts.get(`${d.root}|${d.rel}`); return t == null ? null : t.split(/\r?\n/)[d.line - 1] ?? null; };
    const term = address ? terminals().find((x) => x.address === address) : null;
    const cwd = address ? panes().find((p) => p.terminal === address)?.cwd ?? term?.cwd ?? null : null;
    const repos = new Map(this.shownRepos().map((R) => [R.store.root, h.repoName(R.store)]));
    return buildProblemsPrompt(diags, { lineOf, cwd, wsl: isWslArgv(term?.argv), repos });
  }

  /** Send to agent: the space's only agent, else a pick; a working agent asks first (as review comments do). */
  send(cx, file = null, address = null) {
    const h = this.host, u = this.uiOf(), space = h.spaceId, diags = this.picked(file);
    if (u.busy) return;
    if (!diags.length) { u.note = "No problems to send"; h.paint(cx); return; }
    const sp = spaces().find((s) => s.id === space);
    if (!sp) return;
    if (!address) {
      const here = agents().filter((a) => a.space === space), live = new Set(terminals().filter((x) => x.state === "live").map((x) => x.address));
      const ch = chooseTarget([], here, live);
      u.pick = null; u.confirmTo = null;
      if (ch.error) { u.note = ch.error; h.paint(cx); return; }
      if (ch.pick) { u.pick = { file, list: ch.pick.map((a) => a.address) }; u.note = null; h.paint(cx); return; }
      address = ch.address;
    }
    const a = agents().find((x) => x.address === address);
    if (a && ACTIVE.has(a.status) && u.confirmTo?.address !== address) { u.pick = null; u.confirmTo = { address, file }; u.note = null; h.paint(cx); return; }
    u.pick = null; u.confirmTo = null;
    const who = this.opts.agentLabel(a ?? { address }), what = many(diags.length, "problem");
    u.busy = `Sending ${what} to ${who}…`; u.note = null; h.paint(cx);
    cx.spawn(async (cx) => {
      try {
        const prompt = await this.prompt(diags, address), bad = promptProblem(prompt);
        if (bad) throw new Error(bad);
        await sendToAgent(hc, address, prompt);
        u.note = `Sent ${what} to ${who}`;
      } catch (e) { u.note = `Not sent: ${e.message ?? e}`; }
      u.busy = null; h.paint(cx);
    });
  }

  /** Copy: the prompt on the clipboard, paths as the space's only agent sees them (else full paths). */
  copy(cx, file = null) {
    const h = this.host, u = this.uiOf(), diags = this.picked(file);
    if (!diags.length) { u.note = "No problems to copy"; h.paint(cx); return; }
    const here = agents().filter((a) => a.space === h.spaceId), address = here.length === 1 ? here[0].address : null;
    cx.spawn(async (cx) => {
      const text = await this.prompt(diags, address);
      cx.write_to_clipboard(text);
      u.note = `Copied ${many(diags.length, "problem")}${address ? ", paths as the agent sees them" : ""}`;
      h.paint(cx);
    });
  }

  /** A command from Herdr (`wingman.problems<Name>`), in the owner copy only. */
  command(c, cx) {
    const h = this.host;
    if (!this.owner()) return;
    const go = {
      problemsShow: () => h.setLeft("problems", cx),
      problemsDown: () => { h.problemsFocus = true; this.move(1, cx); },
      problemsUp: () => { h.problemsFocus = true; this.move(-1, cx); },
      problemsEnter: () => this.enter(cx),
      problemsSend: () => this.send(cx),
      problemsSendFile: () => this.send(cx, this.selectedFile()),
      problemsCopy: () => this.copy(cx),
      problemsConfirm: () => { const c = this.uiOf().confirmTo; if (c) this.send(cx, c.file, c.address); },
    }[c];
    go?.();
  }

  // ---- drawing -----------------------------------------------------------------------

  render(t) {
    const h = this.host, u = this.uiOf(), rows = this.rows(), repos = this.shownRepos();
    const all = repos.flatMap((R) => R.list), more = repos.reduce((n, R) => n + R.more, 0);
    const running = repos.flatMap((R) => [...R.running.values()]);
    const failures = repos.flatMap((R) => [...R.failures.values()]), notes = repos.map((R) => R.note).filter(Boolean);
    const sel = this.selectedFile();
    const items = [
      { id: "check", labels: [withKey("Check", h.kl("checkProblems")), "Check"], drop: Infinity, size: 11, pad: 20 },
      { id: "send", labels: ["Send to agent", "Send"], drop: 2, size: 11, pad: 20 },
      ...(sel ? [{ id: "send-file", labels: ["Send file"], drop: 1, size: 11, pad: 20 }] : []),
      { id: "copy", labels: ["Copy"], drop: 3, size: 11, pad: 20 },
    ];
    const fit = fitBar((h.leftW ?? 300) - 12, items, 0, 4); // leftW: element px already
    const btn = (id, bg, fn) => fit.has(id) ? [h.button(`problems-${id}`, fit.get(id), bg, fn).flex_none().whitespace_nowrap()] : [];
    const head = !this.enabled() ? "Problems are off in Settings"
      : running.length ? `Checking: ${[...new Set(running)].join(", ")}…` : `${countText(all, more)}${h.stores.length && !repos.length ? " · plain folders aren't checked" : ""}`;
    return v_flex().id("problems-view").flex_1().min_h(0)
      .child(h_flex().flex_none().px(6).pt(6).pb(4).gap(4).items_center()
        .children(btn("check", t.accent + "55", (cx) => this.checkNow(cx)))
        .children(btn("send", t.raised, (cx) => this.send(cx)))
        .children(btn("send-file", t.raised, (cx) => this.send(cx, sel)))
        .children(btn("copy", t.raised, (cx) => this.copy(cx))))
      .child(div().flex_none().px(8).pb(4).text_size(11).text_color(t.muted).child(head))
      .children([...new Set([...failures, ...notes])].map((l, i) => div().id(`problems-fail-${i}`).flex_none().px(8).pb(4).text_size(11).text_color(t.ansi1).child(l))) // wraps: the end of the line says why
      .when(!!u.busy || !!u.note, (e) => e.child(div().flex_none().px(8).pb(4).text_size(11).text_color(t.dim).child(u.busy ?? u.note)))
      .when(!!u.pick, (e) => e.child(v_flex().flex_none().mx(6).mb(4).p(6).gap(4).rounded(6).bg(t.raised).text_size(11)
        .child(div().text_color(t.muted).child("Send to which agent?"))
        .children(u.pick.list.map((addr, i) => div().id(`problems-pick-${i}`).px(6).py(3).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover)).truncate()
          .on_click((_e, cx) => this.send(cx, u.pick?.file ?? null, addr)).child(this.opts.agentLabel(agents().find((a) => a.address === addr) ?? { address: addr }))))
        .child(h.button("problems-pick-cancel", "Cancel", t.background, (cx) => { u.pick = null; h.paint(cx); }))))
      .when(!!u.confirmTo, (e) => e.child(v_flex().flex_none().mx(6).mb(4).p(6).gap(6).rounded(6).bg(t.raised).text_size(11)
        .child(div().child(`${this.opts.agentLabel(agents().find((a) => a.address === u.confirmTo.address) ?? { address: u.confirmTo.address })} is working. Send anyway?`))
        .child(h_flex().gap(6)
          .child(h.button("problems-confirm", "Send", t.accent + "55", (cx) => this.send(cx, u.confirmTo?.file ?? null, u.confirmTo?.address)))
          .child(h.button("problems-confirm-no", "Cancel", t.background, (cx) => { u.confirmTo = null; h.paint(cx); })))))
      .child(div().id("problems-results").flex_1().min_h(0).relative().overflow_hidden()
        .on_size_change((size, cx) => { if (Math.abs(this.h - size.height) > 0.5) { this.h = size.height; h.paint(cx); } })
        .when(rows.length > 0, (e) => e
          .child(v_virtual_list("problems-rows", rows.length, PROW, (i) => rows[i].key,
            (range) => rows.slice(range.start, range.end).map((row) => this.row(row, t, u)))
            .w_full().h(Math.max(PROW, this.h)).track_scroll(this.scroll)
            .on_item_click((key, cx) => this.click(key, cx)))
          .child(Scrollbar.vertical("problems-rows").viewport_from_layout().absolute().inset_0())));
  }

  /** One row (inside the virtual list: clicks come through on_item_click). */
  row(row, t, u) {
    const h = this.host, on = row.key === u.sel, selBg = h.problemsFocus ? t.selected : t.hover;
    const sevColor = (s) => (s === "error" ? t.ansi1 : t.ansi3);
    if (row.kind === "file") {
      const f = row.file, cut = f.rel.lastIndexOf("/") + 1, multi = h.repos().length > 1;
      return h_flex().w_full().h(PROW).px(6).gap(4).items_center().whitespace_nowrap().cursor_pointer()
        .when(on, (e) => e.bg(selBg))
        .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(u.collapsed.has(f.key) ? "▸" : "▾"))
        .child(div().flex_none().text_size(12).text_color(f.errors ? t.ansi1 : t.ansi3).child(f.rel.slice(cut)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child((multi ? h.repoName(f.st) + (cut ? "/" : "") : "") + f.rel.slice(0, Math.max(0, cut - 1))))
        .when(f.errors > 0, (e) => e.child(div().flex_none().px(5).rounded(8).bg(t.ansi1 + "40").text_size(10).child(String(f.errors))))
        .when(f.warnings > 0, (e) => e.child(div().flex_none().px(5).rounded(8).bg(t.ansi3 + "40").text_size(10).child(String(f.warnings))));
    }
    const d = row.d;
    return h_flex().w_full().h(PROW).pl(20).pr(6).gap(5).items_center().overflow_hidden().whitespace_nowrap().text_size(12).cursor_pointer()
      .when(on, (e) => e.bg(selBg)).when(!!d.stale, (e) => e.opacity(0.55))
      .child(div().w(10).flex_none().text_size(10).text_color(sevColor(d.severity)).child(d.severity === "error" ? "●" : "▲"))
      .child(div().flex_1().min_w(40).truncate().child(d.message))
      // A long rule name (@typescript-eslint/…) is cut before the message is.
      .child(div().flex_shrink(1).min_w(0).max_w(110).truncate().text_size(10).text_color(t.dim).child(`${d.source}${d.code ? ` ${d.code}` : ""}`))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(`${d.line}:${d.col}`));
  }
}
