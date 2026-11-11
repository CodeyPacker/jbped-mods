// Wingman: Cursor-style whole-file diffs of an agent's changes, with per-hunk
// Accept/Reject that write to disk and undo. A space's review covers every repo its
// agents touched: the repo its agents started in (capture.js, any agent) and every
// repo Claude edited (journal.js, from the Claude hook). Each repo keeps its own store
// in <git-dir>/wingman.
//
// Actions update the in-memory file state and redraw at once; disk writes run
// after, in order, on a queue. Every write is compare-and-swap, so a failure
// never overwrites someone else's edit: the view reports it and reloads.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, ScrollHandle, TextareaState, Textarea, InputState, Input } from "gpui-base";
import { theme, settings, props, readTextFile, writeTextFile, panes, spaces, machines, agents, terminals, appHome, exec, hc, pickFolder, openOverlay, closeOverlay, nextCommand, run, layout, shared, setShared } from "herdr";
import { rows as buildRows, acceptAt, rejectAt, acceptAll, rejectAll, partialAt } from "./model.js";
import { Store, PlainRoot, norm, shows } from "./store.js";
import { highlight, highlightLines, languageOf, color } from "./highlight.js";
import { edit, body, cmp, linesOf, wordMove, wordAt, textBetween, indentUnit, visualCol, charAt, expandTabs } from "./edit.js";
import { Capture, hostPath } from "./capture.js";
import { merge3, diffHunks, changedRanges, mapLine } from "./merge.js";
import { createTree, setFolder, toggle, reveal, loaded, rows as treeRows, folderIndex, STATUS_TREE, parseStatus as parseTreeStatus, ignoredMatcher, PER_FOLDER } from "./filetree.js";
import { listDir, pathKind, join as pjoin, fingerprints, createFile, createDir, movePath, deleteFile, deleteTree, revealPath } from "./fsx.js";
import { checkRel, newTarget, renameTarget, parentOf, nameOf, under, windowsRoot, remap, within, copyPaths, countUnder, deleteQuestion, stemEnd } from "./fileops.js";
import { sha256Hex } from "./sha256.js";
import { openInNvim, openInEditor, EDITORS, editorName } from "./nvim.js";
import { PAIRS, typed, inEmptyPair, betweenBrackets } from "./pairs.js";
import { tagKind, closingTag, completeClose, betweenTags } from "./tags.js";
import { segments, segmentOf } from "./wrap.js";
import { git, onWindows } from "./git.js";
import { READ, STATUS, STATUS_V2, MAX_FILES, parseStatus, parseStatusV2, onDisk, statusLetter, reviewTag, discardCommands, commitCommands, NUMSTAT, NUMSTAT_NO_HEAD, parseNumstat, countLines } from "./changes.js";
import { compile, findAll, nextMatch, prevMatch, replacement, parseLine } from "./find.js";
import { rank, parseQuery } from "./quickopen.js";
import { ACTIONS, BY_ID, resolve, index, holders, bind, unbind, reset as resetKey, refused, keystrokeOf, keyLabel, withModSection, herdrGlobal } from "./keymap.js";
import { lineSpan, moveLines, copyLines, deleteLines, joinLines, toggleComment, commentFor } from "./lineops.js";
import { splitLines } from "./model.js";
import { spaceRoots, addFolder, removeFolder, repoInfo, addWorktree, removeWorktree, scanRepos, sharedBranch, worktreeDest, isHome, pathFor } from "./workspace.js";
import { REMOTE, NVIM_NOTE, EDITOR_NOTE, NOTES_NOTE, REASON_NOTE, remotePath, rootId, idOf, mapLimit } from "./remote.js";
import { grepArgs, searchRepo, replacePlan } from "./search.js";
import { MAX_RESULTS, fmt, many, resultRows, occurrences, summaryOf, matchPieces, replaceState } from "./searchview.js";
import { matchBracket, tokenSkip } from "./brackets.js";
import { spans as spansOf } from "./spans.js";
import { Journal, addSpaceRepos, queueFeedback, withdrawFeedback, queuePrompt, drainOutbox, loadSettings, saveSettings, loadKeys, saveKeys, hookKnown, forgetHook } from "./journal.js";
import { hookStatus, hookSummary, installHook, uninstallHook } from "./hooksetup.js";
import { capSteps } from "./undocap.js";

const ROW = 20, GUTTER = 58, BTN_W = 110, BTN_GAP = 6, BUTTONS = 3; // Reject, Accept, Prompt
// Agents count as working while they are in a turn, including while blocked on a question.
const ACTIVE = new Set(["working", "blocked"]);
const base = (p) => p.split("/").pop();
const SROW = 22; // a Search result row's height
const TOK_CHARS = 4e6; // the highlight cache's texts, in characters (tok)

/** A space's Search view state (the Edit tab's left column): kept per space like the rest of the view. */
function newSearch() {
  return { left: "explorer", query: "", include: "", exclude: "", replace: "", opts: { cased: false, word: false, regex: false }, more: false,
    results: null, running: false, seq: 0, collapsed: new Set(), shutVer: 0, sel: null, confirm: false, note: null, busy: false };
}

/**
 * A file state for undo and redo, without its caches (fields starting with "_": rowsOf's rows,
 * matches' find results). They're rebuilt when the state is shown again; kept, every undo step
 * would hold a row object per line of the file.
 */
const bare = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith("_")));

/** A path as the agent in `terminal` sees it: /mnt/c/... for an agent running in WSL. */
function agentPath(path, terminal) {
  const t = terminals().find((x) => x.address === terminal);
  const wsl = /(^|[\\/])wsl(\.exe)?$/i.test(t?.argv?.[0] ?? "");
  const m = /^([A-Za-z]):\/(.*)$/.exec(path);
  return wsl && m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : path;
}

// Outside mods/: any write under a mod folder (even a hidden file) hot-reloads every copy.
const LEADER_FILE = () => `${appHome()}/data/wingman-leader.json`;
const LEASE_MS = 5000;

/** Capture runs in whichever copy leads, often a hidden one, so it logs to a file (in order). */
let logQueue = Promise.resolve();
function log(msg) {
  const path = `${appHome()}/data/wingman-capture.log`, line = `${new Date().toISOString()} ${msg}\n`;
  logQueue = logQueue.then(async () => {
    const old = await readTextFile(path);
    await writeTextFile(path, ((old ?? "").length > 20000 ? old.slice(-10000) : old ?? "") + line, old);
  }).catch(() => {});
}

/** Folders an agent in `space` works in, as this machine's git sees them (on another machine: as it names them). */
function agentFolders(space) {
  const at = pathFor(space);
  return agents().filter((a) => a.space === space.id).map((a) => at(panes().find((p) => p.pane === a.pane)?.cwd
    ?? terminals().find((t) => t.address === a.address)?.cwd)).filter(Boolean);
}

/** Folders of every terminal in `space`, agents' first (Q18), as this machine's git sees them (see agentFolders). */
function termFolders(space) {
  const tabs = new Set(space.tabs.map((t) => t.id)), at = pathFor(space);
  const all = [...agentFolders(space), ...panes().filter((p) => p.terminal && tabs.has(p.tab)).map((p) => at(p.cwd))];
  return [...new Set(all.filter(Boolean))];
}

/** The space of the agent in terminal `by`, while it's still there. */
const spaceOfAgent = (by) => (by && agents().find((a) => a.address === by)?.space) || null;

/** Spaces that hold a Wingman pane, on this computer or another machine. */
function reviewSpaces() {
  const tabs = new Set(panes().filter((p) => p.mod === "wingman").map((p) => p.tab));
  return spaces().filter((s) => s.tabs.some((t) => tabs.has(t.id)));
}

/**
 * Herdr's global keys reach Herdr before Wingman. For each Wingman key that Herdr binds globally,
 * the "mod:wingman" section of Herdr's keys.json sends it to Wingman while Wingman has focus
 * (Q4). Only Wingman's own entries ("wingman.<action>") in that section are rewritten.
 */
async function syncHerdrKeys(keymap) {
  const path = `${appHome()}/keys.json`, text = await readTextFile(path);
  if (!text) return;
  try {
    const global = herdrGlobal(text), entries = {};
    for (const a of ACTIONS) for (const k of keymap.get(a.id) ?? []) if (global[k] && !(k in entries)) entries[k] = `wingman.${a.id}`;
    const next = withModSection(text, entries);
    if (next) { await writeTextFile(path, next, text); log(`keys.json: mod:wingman now ${JSON.stringify(entries)}`); }
  } catch (e) { log(`keys.json: ${e.message ?? e}`); } // another copy wrote it first, or the file isn't JSON
}

// Panel split: a copy whose block has props {view: "review" | "edit"} shows only that view. The
// copies talk through shared(): GOTO hands the current file to the other view, DIRTY lists each
// copy's files with unsaved edits, SAVE asks the copies holding them to save (autosave on).
const GOTO = "wingman.goto", DIRTY = "wingman.dirty", SAVE = "wingman.saveReq";
const REVIEW = "wingman.review"; // Review's open change count per file key, for the Changes view
const DIRTY_FRESH = 30000; // ms: an entry older than this is from a copy that's gone
// The Explorer's file operations: TREE_MENU names the copy whose tree the right-click menu is for
// (every shown copy gets the menu's command); FILEOP tells the other copies what was renamed or deleted.
const TREE_MENU = "wingman.treeMenu", FILEOP = "wingman.fileop";

/** Whether the layout has a Wingman panel copy for `view`. */
function hasView(view) {
  const walk = (n) => !!n && ((n.content?.mod === "wingman" && n.content.props?.view === view) || (n.children ?? []).some(walk));
  return walk(layout());
}

/** Shows the layout block of the Wingman copy for `view`: selects it in its stacks, shows hidden parents. */
function showView(view) {
  const path = [];
  const walk = (n) => {
    if (!n) return false;
    path.push(n);
    if (n.content?.mod === "wingman" && n.content.props?.view === view) return true;
    for (const c of n.children ?? []) if (walk(c)) return true;
    path.pop(); return false;
  };
  if (!walk(layout())) return false;
  path.forEach((n, i) => {
    const next = path[i + 1];
    if (n.type === "stack" && next && n.active !== next.id) run("layout.select", { stack: n.id, child: next.id });
    if (n.hidden) run("layout.show", { id: n.id });
  });
  return true;
}

export default class Review extends View {
  // A pane copy can't tell which pane it is (mod panes get no props, and every copy
  // restarts together on reload), so copies don't depend on it:
  // - Display: a Wingman pane is only visible while its space is active, so every copy
  //   shows the active space's review, and keeps each space's state for when it returns.
  // - Capture: one copy holds a lease (.leader.json) and captures for every space that
  //   has a Wingman pane, so the work never runs twice.
  init(_props, cx) {
    // Opened as a popup (reason or follow-up prompt): a small form, none of the pane's work.
    if (props()?.form) return this.initForm(cx);
    this.id = Math.random().toString(36).slice(2);
    this.settings = { autoNote: true, editNote: true, autosave: true, autosaveDelay: 0, editor: "wingman", autoPairs: true, autoTags: true, externalEditor: "code", externalCommand: "", wordWrap: false };
    this.editNotes = new Map(); // file key -> the edit note last queued for it
    // Q48: Review (tabs are changed files) or Edit (file tree, tabs for changed and opened files).
    this.view = ["review", "edit", "changes"].includes(props()?.view) ? props().view : null; // a panel copy for one view
    this.gotoSeen = Date.now(); this.dirtySig = ""; this.dirtyAt = 0; this.saveSeen = Date.now(); this.fileopSeen = Date.now();
    try { this.repoShut = new Set(JSON.parse(localStorage.getItem("repoShut") ?? "[]")); } catch { this.repoShut = new Set(); }
    try { this.repoOpen = new Set(JSON.parse(localStorage.getItem("repoOpen") ?? "[]")); } catch { this.repoOpen = new Set(); }
    this.mode = this.view ?? "review"; this.treeOn = true; this.trees = new Map(); this.ftrees = new Map();
    loadSettings().then((st) => { this.settings = st; });
    this.setKeymap({});
    cx.spawn(async () => { this.setKeymap(await loadKeys()); await syncHerdrKeys(this.keymap); });
    // The pane takes the keyboard back after its popup closes.
    // Commands: "focus" when a popup over the pane closes; the rest come from the right-click menu.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).replace(/^wingman\./, "");
        if (c === "focus") { if (this.treeEdit && !this.treeEdit.busy) this.focusTreeInput(true); else this.handle.focus(); }
        else if (/^tree[A-Z]/.test(c)) this.treeMenuCmd(c, cx);
        else await ({
          prompt: () => this.askPrompt(this.current, cx),
          reject: () => this.decide("reject", cx),
          // Reject, then open the reason popup for that rejection right away.
          rejectReason: () => this.decide("reject", cx, true),
          accept: () => this.decide("accept", cx),
          reason: () => this.askReason(cx),
          clear: () => this.clearSelection(cx),
          save: () => this.save(cx),
          // E3 line operations, for keys.json's "mod:wingman" section (e.g. "alt-up": "wingman.moveLineUp").
          moveLineUp: () => this.lineOp("moveUp", cx),
          moveLineDown: () => this.lineOp("moveDown", cx),
          copyLineUp: () => this.lineOp("copyUp", cx),
          copyLineDown: () => this.lineOp("copyDown", cx),
          deleteLine: () => this.lineOp("delete", cx),
          joinLines: () => this.lineOp("join", cx),
          toggleComment: () => this.lineOp("comment", cx),
          openInVSCode: () => this.toVSCode(cx),
          // The settings popup saved a change.
          settings: async () => { this.settings = await loadSettings(); this.setKeymap(await loadKeys()); },
          // The settings popup installed or removed the Claude hook on a machine: look again now.
          hook: () => { forgetHook(); for (const j of this.journals?.values() ?? []) j.at = 0; },
        })[c]?.() ?? (BY_ID.has(c) ? this.runAction(c, cx) : undefined);
        cx.notify();
      }
    });
    this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new(); this.searchScroll = VirtualListScrollHandle.new(); this.treeScroll = ScrollHandle.new();
    this.initFind();
    this.views = new Map(); this.captures = new Map(); this.tokens = new Map();
    this.reset([]);
    this.queue = Promise.resolve(); this.writing = 0;
    cx.timer.every(1000, (cx) => this.follow(cx));
    cx.timer.every(250, (cx) => { this.autosave(cx); this.publishDirty(); this.publishReview(); this.takeShared(cx); });
    if (this.view === "changes") this.initChanges(cx);
    cx.timer.every(500, (cx) => this.lead(cx));
    cx.timer.every(3000, (cx) => this.collectAll(cx));
    cx.timer.every(5000, (cx) => this.mode === "edit" && (this.treeOn || this.nvim()) && this.refreshTrees(cx));
    // Watch events would be the fast path, but they did not fire on Windows in testing,
    // so a 2 s content check is what catches outside edits. "#index" keeps the index
    // checked even when no files are listed (e.g. right after a reset).
    cx.timer.every(2000, (cx) => this.stores.length && this.onWatch(new Set(["#index", ...this.files.map((f) => norm(f.path ?? ""))]), cx));
    this.follow(cx);
  }

  /** Per-space view state; no stores means no repo found yet. */
  reset(stores) {
    this.stores = stores; this.files = []; this.sel = null; this.current = 0; this.history = [];
    this.deferred = new Set(); this.indexTexts = {}; this.error = null;
    this.cur = null; this.anchor = null; this.redo = []; this.hx = 0; this.opened = [];
    this.search = newSearch(); this.searchFocus = false;
    this.treeCur = this.treeEdit = this.treeDel = null; this.treeFocus = false;
    this.status = stores.length ? "Loading…" : "Waiting for an agent in a git repo in this space, or open a folder.";
  }

  // ---- which space ---------------------------------------------------------

  /** Shows the active space's review, opening its repo when an agent there is in one. `force`: look
   *  the roots up now (a space on another machine is looked up at most every 5 s). */
  async follow(cx, force = false) {
    if (this.following || this.writing) return;
    this.following = true;
    try {
      const sp = spaces().find((s) => s.active);
      const key = sp?.id ?? null;
      if (key !== this.spaceId) {
        if (this.settings.autosave) this.saveAll(cx);
        if (this.spaceId) this.views.set(this.spaceId, this.snapshotView());
        this.spaceId = key;
        const saved = this.views.get(key);
        if (saved) Object.assign(this, saved); else this.reset([]);
        this.views.delete(key); // the live state is on the instance now (saved again on leaving)
        this.pruneViews();
        this.syncSearchInputs();
        cx.notify();
      }
      if (!sp) return;
      const on = sp.machine ?? null;
      if (on) {
        const at = (this.rootsAt ??= new Map()).get(key) ?? 0;
        if (!force && Date.now() - at < REMOTE.rootsMs) return;
        this.rootsAt.set(key, Date.now());
      }
      // The space's repos (workspace.js): where its agents started (any agent), its workspace
      // file's folders, and every repo the Claude hook saw them edit, less the ones removed by
      // hand. A repo joins the view when it appears and leaves when it's removed.
      // D2: every terminal's folder counts. One outside any repo, or a workspace folder that isn't
      // one, is a plain root: listed and editable, never reviewed. Repos come first.
      const start = props()?.root ? await Store.open(props().root).catch(() => null) : null;
      const { repos, plain } = props()?.root ? { repos: start ? [start.root] : [], plain: [] } : await this.folderRoots(sp);
      const { roots, names } = await spaceRoots(sp, [...repos, ...plain]);
      const found = [];
      for (const root of roots) {
        const st = this.stores.find((x) => x.root === root || x.asked === root) ?? (isHome(root) ? null : await this.openStore(root, on))
          ?? ((await this.folderKind(root, on)).dir ? new PlainRoot(root, on) : null);
        if (st && !found.includes(st)) found.push(st);
      }
      found.sort((a, b) => !!a.plain - !!b.plain);
      for (const st of found) st.label = names.get(st.asked ?? st.root) ?? names.get(st.root) ?? null;
      const same = found.length === this.stores.length && found.every((st, i) => st === this.stores[i]);
      if (!same && this.spaceId === key) {
        const left = new Set(found), files = this.files.filter((f) => left.has(f.store));
        const keep = { sel: files.some((f) => f.key === this.sel) ? this.sel : files[0]?.key ?? null, current: this.current,
          history: this.history.filter((h) => h.snaps ? h.snaps.every((f) => left.has(f.store)) : !h.key || files.some((f) => f.key === h.key)), opened: this.opened.filter((k) => files.some((f) => f.key === k)),
          search: this.search, searchFocus: this.searchFocus };
        this.reset(found);
        Object.assign(this, keep); this.files = files;
        await this.reloadAll(cx);
        if (this.mode === "edit") this.refreshTrees(cx);
      }
    } finally { this.following = false; }
  }

  /**
   * Drops the kept views of spaces that are gone: their files, highlighting and undo steps would
   * stay for good otherwise. A space on another machine is only known gone while that machine's
   * layout is loaded (offline, its spaces aren't listed), and a view with unsaved edits stays.
   */
  pruneViews() {
    const live = new Set(spaces().map((s) => s.id)), ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name));
    for (const [k, v] of this.views) {
      if (live.has(k) || v.stores.some((st) => st.on && !ready.has(st.on)) || v.files.some((f) => this.dirty(f))) continue;
      this.views.delete(k); this.rootsAt?.delete(k);
    }
  }

  /** A repo's store (on machine `on`), or null when the folder isn't (or isn't yet) a repo: retried after 30 s. */
  async openStore(root, on = null) {
    const id = rootId(root, on), miss = (this.misses ??= new Map()), at = miss.get(id);
    if (at && Date.now() - at < 30000) return null;
    const st = await Store.open(root, on).catch(() => null);
    if (!st) { miss.set(id, Date.now()); return null; }
    miss.delete(id); st.asked = root;
    return st;
  }

  /**
   * What a folder is, cached: { root } (the repo it's in), { dir: true } (a folder outside any repo)
   * or neither (gone). A home folder is never searched for a repo. Misses are checked again after 30 s.
   */
  async folderKind(folder, on = null) {
    const id = rootId(folder, on), cache = (this.resolved ??= new Map()), c = cache.get(id);
    if (c && (c.root || Date.now() - c.at < 30000)) return c;
    // On another machine git's "not a repository" answer means the folder is there (a missing
    // folder can't be a git's working folder: the call rejects), which saves a second call.
    let there = false;
    const st = isHome(folder) ? null : await Store.open(folder, on).catch((e) => { there = !!on && /^not a git repository/.test(e?.message ?? ""); return null; });
    const r = { at: Date.now(), root: st?.root ?? null, dir: !st && (there || (await pathKind(folder, { on })) === "dir") };
    cache.set(id, r);
    return r;
  }

  /** The space's terminal folders as repo roots and plain folders. */
  async folderRoots(sp) {
    const repos = [], plain = [];
    for (const dir of termFolders(sp)) {
      const r = await this.folderKind(dir, sp.machine ?? null);
      if (r.root) { if (!repos.includes(r.root)) repos.push(r.root); } else if (r.dir) plain.push(dir);
    }
    return { repos, plain };
  }

  /** The space's git repos: every root but the plain ones. */
  repos() { return this.stores.filter((st) => !st.plain); }

  /** The repos Review covers: every repo, on this computer or the space's machine. */
  reviewed() { return this.repos(); }

  /** The active space's machine, null for this computer. */
  machine() { return this.space()?.machine ?? null; }

  snapshotView() {
    const { stores, files, sel, current, history, indexTexts, error, status, redo, opened, search } = this;
    return { stores, files, sel, current, history, indexTexts, error, status, redo, opened, search, searchFocus: false, cur: null, anchor: null, hx: 0, deferred: new Set(),
      treeCur: null, treeEdit: null, treeDel: null, treeFocus: false };
  }

  // ---- capture (leader only) -----------------------------------------------

  /** Renews or takes the capture lease; true while this copy holds it. */
  async leader() {
    const path = LEADER_FILE(), text = await readTextFile(path), now = Date.now();
    const lease = text ? JSON.parse(text) : null;
    if (lease && lease.id !== this.id && now - lease.at < LEASE_MS) return false;
    try { await writeTextFile(path, JSON.stringify({ id: this.id, at: now }), text); return true; }
    catch { return false; } // another copy renewed or took it first
  }

  /** Every 500 ms: agent status is cheap, and a snapshot must land before the first edit. */
  async lead(cx) {
    if (this.leading) return;
    this.leading = true;
    try {
      this.isLeader = await this.leader();
      if (!this.isLeader) return;
      this.journal ??= new Journal(log);
      await this.journal.drain();
      await drainOutbox((t) => agents().some((a) => a.address === t && ACTIVE.has(a.status)),
        (t, text) => hc(["send", t, text]), log);
      for (const sp of reviewSpaces()) {
        // W1: capture follows every repo of the space's workspace. Its repos are looked up again
        // every 5 s (cached stores are reused), never while an agent is starting a turn.
        const g = (this.groups ??= new Map()).get(sp.id) ?? { active: false, by: null, at: 0, caps: [] };
        this.groups.set(sp.id, g);
        const working = agents().filter((a) => a.space === sp.id && ACTIVE.has(a.status)), active = working.length > 0;
        // Another machine: nothing is looked up there for a space that isn't shown and has no agent
        // working (every call there costs about 200 ms). Captures already made finish their last pass.
        if (sp.machine && !active && !g.active && !sp.active) continue;
        if (!g.at || (active === g.active && Date.now() - g.at > 5000)) {
          g.at = Date.now();
          const { repos } = await this.folderRoots(sp);
          const { roots } = await spaceRoots(sp, repos);
          const caps = [];
          for (const root of roots) {
            let c = this.captures.get(`${sp.id}|${root}`);
            if (!c) {
              const store = await this.openStore(root, sp.machine ?? null);
              if (!store) continue;
              log(`${sp.name}: capturing ${store.root}${store.on ? ` on ${store.on}` : ""}`);
              // after: a capture on another machine checks its saved state once (a pass may be left over).
              c = { capture: new Capture(store), space: sp.id, active: g.active, busy: false, by: g.by, after: !!store.on };
              this.captures.set(`${sp.id}|${root}`, c);
            }
            caps.push(c);
          }
          for (const [k, c] of this.captures) if (c.space === sp.id && !caps.includes(c)) { this.captures.delete(k); log(`${sp.name}: stopped capturing ${c.capture.store.root}`); }
          g.caps = caps;
          if (!caps.length && !this.noRepo?.has(sp.id)) { (this.noRepo ??= new Set()).add(sp.id); log(`${sp.name}: no repo in ${JSON.stringify(agentFolders(sp))}`); }
        }
        // Credit captured edits to the working agent when it is a lone Claude: its hook delivers
        // rejection feedback even for edits made through Bash. Kept until the next turn starts,
        // so the last pass after the agent stops is credited too.
        if (active) g.by = working.length === 1 && working[0].app === "claude-code" ? working[0].address : null;
        for (const c of g.caps) c.by = g.by;
        if (active !== g.active) {
          g.active = active; log(`${sp.name}: agent ${active ? "working" : "stopped"} (${g.caps.map((c) => c.capture.store.root).join(", ")})`);
          for (const c of g.caps) { c.active = active; if (!active) c.after = true; }
          // Every repo's snapshot at once: a turn waits for the slowest, not the sum.
          if (active) await Promise.all(g.caps.map((c) => this.collect(c, cx, true)));
          cx.notify();
        }
      }
    } catch (e) { this.error = `capture: ${e.message ?? e}`; log(`lead error ${e.message ?? e}`); cx.notify(); }
    finally { this.leading = false; }
  }

  async collectAll(cx) {
    if (!this.isLeader) return;
    const now = Date.now();
    // On another machine: a pass only while an agent works and once after, at most every REMOTE.captureMs.
    const due = (c) => !c.capture.store.on || ((c.active || c.after) && now - (c.at ?? 0) >= REMOTE.captureMs);
    // Grouped by machine: a machine's hook events are applied before its captures' passes, so the
    // two never write a review index at once (the journal adds `by` to what capture already took).
    const byOn = new Map([[null, []]]);
    for (const c of this.captures.values()) {
      if (!due(c)) continue;
      c.at = now;
      const on = c.capture.store.on ?? null;
      if (!byOn.has(on)) byOn.set(on, []);
      byOn.get(on).push(c);
    }
    const journals = this.journalsDue(now);
    for (const on of journals) if (!byOn.has(on)) byOn.set(on, []);
    await Promise.all([...byOn].map(async ([on, caps]) => {
      if (on && journals.has(on)) await this.drainMachine(on, cx);
      await Promise.all(caps.map((c) => this.collect(c, cx)));
    }));
    // Each repo's index once: branch parking and committed changes (store.reconcile). On another
    // machine every REMOTE.reconcileMs, and only for a space that's shown or has an agent working.
    const seen = new Set();
    for (const c of this.captures.values()) {
      const st = c.capture.store, id = idOf(st);
      if (seen.has(id)) continue;
      seen.add(id);
      if (st.on) {
        if (!(c.active || spaces().find((s) => s.id === c.space)?.active) || now - (st.reconciledAt ?? 0) < REMOTE.reconcileMs) continue;
        st.reconciledAt = now;
      }
      await st.reconcile(spaceOfAgent).catch((e) => log(`reconcile ${st.root}: ${e.message ?? e}`));
    }
  }

  /**
   * Machines whose Claude hook events are due: those with a space that has a Wingman panel and an
   * agent, while such a space is shown or an agent there works, and once after. At most every
   * REMOTE.journalMs (REMOTE.journalIdleMs while the hook isn't installed there); an idle hidden
   * machine costs nothing.
   */
  journalsDue(now) {
    const out = new Set(), want = new Map();
    for (const sp of reviewSpaces()) {
      if (!sp.machine) continue;
      const here = agents().filter((a) => a.space === sp.id);
      if (!here.length) continue;
      want.set(sp.machine, want.get(sp.machine) || sp.active || here.some((a) => ACTIVE.has(a.status)));
    }
    this.journals ??= new Map();
    for (const [on, live] of want) {
      const j = this.journals.get(on) ?? { at: 0, after: false, busy: false };
      this.journals.set(on, j);
      if (live) j.after = true;
      else if (!j.after) continue;
      if (j.busy || now - j.at < (hookKnown(on) === false ? REMOTE.journalIdleMs : REMOTE.journalMs)) continue;
      if (!live) j.after = false; // the pass after the space was left or its agents stopped
      j.at = now;
      out.add(on);
    }
    for (const on of [...this.journals.keys()]) if (!want.has(on)) this.journals.delete(on);
    return out;
  }

  /** One pass over machine `on`'s hook events (journal.drainOn). */
  async drainMachine(on, cx) {
    const j = this.journals.get(on);
    if (!j || j.busy) return;
    j.busy = true;
    try {
      this.journal ??= new Journal(log);
      const r = await this.journal.drainOn(on);
      if (r.events) log(`hook events on ${on}: ${r.events} read, ${r.adopted} files added`);
    } catch (e) { log(`hook events on ${on}: ${e.message ?? e}`); }
    finally { j.busy = false; }
  }

  /**
   * One capture pass for a space. Starting: snapshot the working tree. While working,
   * and once after: adopt files that changed since that snapshot. The snapshot is kept
   * in capture.json, so a new leader or a reloaded pane carries on where it was.
   */
  async collect(c, cx, starting = false) {
    if (c.busy) return;
    c.busy = true;
    // On another machine a pass whose snapshot is the last one's adopts nothing new: skipped (c.last).
    const remote = !!c.capture.store.on;
    try {
      const st = await c.capture.state();
      if (!st.tree) {
        if (c.active) { const tree = await c.capture.snapshot(); await c.capture.setState({ tree, since: Date.now() }); c.last = tree; log(`snapshot ${tree}`); }
        else c.after = false;
      } else if (!starting) {
        const now = await c.capture.snapshot();
        if (!(remote && now === c.last)) {
          const added = await c.capture.adopt(st.tree, now, c.by, c.space);
          if (added) log(`adopted ${added} files${remote ? ` on ${c.capture.store.on}` : ""}`);
        }
        c.last = now;
        if (!c.active) { await c.capture.setState({ tree: null }); c.after = false; }
      }
    } catch (e) { this.error = `capture: ${e.message ?? e}`; log(`error ${e.message ?? e}`); cx.notify(); }
    finally { c.busy = false; }
  }

  close() {
    this.scroll?.release(); this.searchScroll?.release(); this.treeScroll?.release(); for (const i of [this.findInput, this.replaceInput, this.lineInput, this.quickInput, this.pathInput, this.treeInput, ...(this.searchInputs ?? [])]) i?.release();
    // The copy is going: its texts, highlighting, undo steps and file lists are let go now, not
    // whenever the runtime drops the instance (a task still waiting would keep it, and all of this).
    for (const m of [this.views, this.tokens, this.trees, this.ftrees, this.captures]) m?.clear();
    this.files = []; this.committed = []; this.history = []; this.redo = []; this.qo = null;
  }

  // ---- loading -------------------------------------------------------------

  async withTokens(f, cx) {
    // What's on disk for this state: edits change memory first, and a save writes the difference.
    f.diskC = f.Ctext; f.diskB = f.Btext;
    if (!f.error) {
      f.oldTok = await this.tok(f.Btext, f.rel, cx);
      f.newTok = await this.tok(f.Ctext ?? "", f.rel, cx);
    }
    return f;
  }

  async reloadAll(cx) {
    if (this.mode === "changes") return this.loadChanges(cx);
    try {
      const files = [], texts = {};
      for (const st of this.reviewed()) {
        // Only this branch's changes, made by this space's agents (store.shows).
        const [stamp, branch] = await Promise.all([st.stamp(), st.branch()]);
        texts[st.root] = stamp;
        if (st.on) await this.markRemote(st, stamp);
        for (const f of await st.files((e) => shows(e, branch, this.spaceId, spaceOfAgent))) files.push(await this.withTokens(f, cx));
      }
      const kept = [];
      for (const nf of files) kept.push(await this.keepEdits(nf, cx));
      // Opened files without changes stay open: plain ones as they are, others reread as plain.
      for (const old of this.files) {
        if (kept.some((k) => k.key === old.key) || !(old.plain || this.opened.includes(old.key))) continue;
        kept.push(old.plain || this.dirty(old) ? old : await this.loadPlain(old.store, old.rel, cx));
      }
      this.files = kept; this.indexTexts = texts; this.status = null;
      this.settle(); cx.notify();
      // The review changed: the tree's counts and status letters follow.
      if (this.mode === "edit" && (this.treeOn || this.nvim())) this.refreshTrees(cx);
    } catch (e) { this.error = String(e.message ?? e); cx.notify(); }
  }

  /** A reloaded file, unless this pane holds unsaved edits to it: a disk change under them
   *  is merged into them (mergeInto). */
  async keepEdits(nf, cx) {
    const old = this.files.find((x) => x.key === nf.key);
    if (!old || !this.dirty(old)) return nf;
    if ((nf.Ctext === old.diskC && nf.Btext === old.diskB) || this.sameConflict(old, nf.Ctext, nf.Btext)) return old;
    const next = await this.mergeInto(old, nf, cx), now = this.files.find((x) => x.key === nf.key);
    // Typed into while merging: keep the newer edits and merge again on the next pass.
    if (now !== old) { this.deferred.add(norm(nf.path)); return now; }
    this.adoptMerge(old, next);
    return next;
  }

  /** The disk change behind an open conflict banner is already known. */
  sameConflict(f, c, b) { return !!f.conflict && f.conflict.nf.Ctext === c && f.conflict.nf.Btext === b; }

  /**
   * Q44: a write to a file with unsaved edits merges into them, three-way from what was on disk.
   * Overlapping lines go to the agent when autosave is on; with it off, both outcomes are kept
   * and the banner picks one. A deleted file always asks.
   */
  async mergeInto(f, nf, cx) {
    if (nf.Ctext === null || f.Ctext === null) return { ...f, conflict: { nf, ours: { Ctext: f.Ctext, Btext: f.Btext }, theirs: null } };
    const both = (favor) => Promise.all([merge3(f.diskC, f.Ctext, nf.Ctext, favor), merge3(f.diskB, f.Btext, nf.Btext, favor)]);
    const [c, b] = await both(this.settings.autosave ? "theirs" : null);
    if (!c.conflicts && !b.conflicts) return this.merged(nf, c.text, b.text, cx);
    const [[oc, ob], [tc, tb]] = await Promise.all([both("ours"), both("theirs")]);
    return { ...f, conflict: { nf, ours: { Ctext: oc.text, Btext: ob.text }, theirs: { Ctext: tc.text, Btext: tb.text } } };
  }

  /** The state for merged texts over what's on disk now (`nf`); unsaved where they differ. */
  async merged(nf, Ctext, Btext, cx) {
    const B = splitLines(Btext), C = splitLines(Ctext ?? "");
    return { ...nf, Btext, Ctext, B, C, hunks: await diffHunks(Btext, Ctext ?? ""), edited: true, conflict: null,
      oldTok: await this.tok(Btext, nf.rel, cx), newTok: await this.tok(Ctext ?? "", nf.rel, cx), diskC: nf.Ctext, diskB: nf.Btext };
  }

  /** Puts a merge result in place: the cursor follows its line, and edit undo for the file is dropped
   *  (it would put back text from before the agent's write). */
  adoptMerge(f, next) {
    if (next.Ctext !== f.Ctext || next.Btext !== f.Btext) {
      if (this.sel === f.key) for (const k of ["cur", "anchor"]) if (this[k]) this[k] = { ...this[k], line: mapLine(this[k].line, f.Ctext ?? "", next.Ctext ?? "") };
      this.history = this.history.filter((e) => !(e.edit && e.key === f.key)); this.redo = this.redo.filter((e) => e.key !== f.key);
    }
    this.replace(f, next); this.settle();
  }

  dirty(f) { return !!f && !f.error && (f.Ctext !== f.diskC || f.Btext !== f.diskB); }

  async reloadOne(f, cx) {
    if (f.plain) {
      const next = await this.loadPlain(f.store, f.rel, cx);
      this.replace(f, next); this.settle(); cx.notify(); return;
    }
    const entry = (await f.store.index())[f.rel];
    const i = this.files.findIndex((x) => x.key === f.key);
    if (!entry || i < 0) return this.reloadAll(cx);
    this.files[i] = await this.withTokens(await f.store.load(f.rel, entry), cx);
    this.settle(); cx.notify();
  }

  // Watch events: our own writes match memory and are skipped; anything else reloads that file.
  // While writes are queued, events wait so a half-written state is never read back.
  onWatch(touched, cx) {
    if (this.mode === "changes") return; // the Changes view polls git itself (refreshChanges)
    if (touched === "all") this.deferred.add("*");
    else for (const n of touched) this.deferred.add(n);
    if (!this.writing) cx.spawn(async (cx) => this.drain(cx));
  }

  async drain(cx) {
    if (this.mode === "changes") { this.deferred.clear(); return; }
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.deferred.size && !this.writing) {
        const pending = this.deferred; this.deferred = new Set();
        let indexChanged = false;
        for (const st of this.reviewed()) if (!st.on && (await st.stamp()) !== this.indexTexts[st.root]) indexChanged = true;
        // Another machine isn't watched: one hash call per machine, at most every REMOTE.watchMs.
        const away = await this.remoteChanged();
        if (away.stores.size) indexChanged = true;
        if (pending.has("*") || indexChanged) { await this.reloadAll(cx); continue; }
        for (const f of this.files) {
          if (f.error || !(f.store?.on ? away.files.has(f.key) : pending.has(norm(f.path)))) continue;
          // Both sides: accepting only moves the baseline, so a baseline changed elsewhere
          // (another pane, capture, a reset) must be noticed even when the file itself is unchanged.
          // A plain (opened, unchanged) file has no baseline on disk: it is the file itself.
          const on = f.store?.on ?? null;
          const [c, b0] = await Promise.all([readTextFile(f.path, { on }), f.plain ? null : readTextFile(f.basePath, { on })]), b = f.plain ? c : b0;
          if (on && c === f.diskC && (b ?? "") === f.diskB) this.sameAsRead(f);
          if ((c === f.diskC && (b ?? "") === f.diskB) || this.sameConflict(f, c, b ?? "")) continue;
          if (!this.dirty(f)) { await this.reloadOne(f, cx); continue; }
          const next = await this.mergeInto(f, { ...f, Ctext: c, Btext: b ?? "" }, cx);
          // Typed into while merging: merge again from the newer edits.
          if (!this.files.includes(f)) { this.deferred.add(norm(f.path)); continue; }
          this.adoptMerge(f, next); cx.notify();
        }
      }
    } finally { this.draining = false; }
  }

  // ---- another machine: noticing outside changes without watching -------------------

  /** Records what Review last read of a store on another machine (its index and HEAD), as hashes. */
  async markRemote(st, stamp) {
    const [i, h] = stamp.split("\0");
    (this.remoteMarks ??= new Map()).set(idOf(st), { [`${st.dir}/index.json`]: i === "null" ? null : await sha256Hex(i), [`${st.gitDir}/HEAD`]: h === "null" ? null : await sha256Hex(h) });
  }

  /** A text's SHA-256, cached for the few texts asked about again and again. */
  async hashText(text) {
    if (text == null) return null;
    const cache = (this.hashes ??= new Map());
    if (cache.has(text)) return cache.get(text);
    const h = await sha256Hex(text);
    cache.set(text, h);
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return h;
  }

  /** A remote file reread as memory has it, though its hash differs (a BOM, bytes that aren't
   *  UTF-8): its last hashes count as unchanged from now on. */
  sameAsRead(f) {
    const p = this.lastPrints?.get(f.store.on) ?? {};
    (this.okPrints ??= new Map()).set(f.key, [p[f.path], f.plain ? undefined : p[f.basePath]]);
  }

  /**
   * Another machine's changes, without watching: for each machine of the shown repos, at most every
   * REMOTE.watchMs, one call hashes each store's index and HEAD and each open file (and its
   * baseline). Returns the stores whose index or HEAD isn't what Review last read, and the keys of
   * files whose text isn't what memory holds as on disk.
   */
  async remoteChanged() {
    const out = { stores: new Set(), files: new Set() }, now = Date.now(), at = (this.printsAt ??= new Map());
    const ons = new Set(this.reviewed().filter((st) => st.on).map((st) => st.on));
    for (const f of this.files) if (f.store?.on && !f.error) ons.add(f.store.on);
    for (const on of ons) {
      if (now - (at.get(on) ?? 0) < REMOTE.watchMs) continue;
      at.set(on, now);
      const stores = this.reviewed().filter((st) => st.on === on && this.remoteMarks?.has(idOf(st)));
      const files = this.files.filter((f) => f.store?.on === on && !f.error && f.Ctext !== undefined);
      const paths = [...stores.flatMap((st) => [`${st.dir}/index.json`, `${st.gitDir}/HEAD`]), ...files.flatMap((f) => (f.plain ? [f.path] : [f.path, f.basePath]))];
      if (!paths.length) continue;
      const p = await fingerprints([...new Set(paths)], { on });
      (this.lastPrints ??= new Map()).set(on, p);
      for (const st of stores) {
        const m = this.remoteMarks.get(idOf(st));
        if (Object.entries(m).some(([k, h]) => k in p && p[k] !== h)) out.stores.add(st);
      }
      for (const f of files) {
        const ok = this.okPrints?.get(f.key);
        if (ok && ok[0] === p[f.path] && (f.plain || ok[1] === p[f.basePath])) continue;
        const differs = async (path, text) => path in p && p[path] !== (await this.hashText(text));
        if ((await differs(f.path, f.diskC ?? null)) || (!f.plain && (await differs(f.basePath, f.diskB ?? "")))) out.files.add(f.key);
      }
    }
    return out;
  }

  // Highlighting cached by content, so a reload re-tokenizes only text that changed. Each key is a
  // copy of a whole text, so the cache is capped by text size too (TOK_CHARS), not only by count:
  // Herdr's one memory limit is shared by every copy of every mod.
  async tok(text, rel, cx) {
    const key = `${languageOf(rel)}\0${text}`;
    if (!this.tokens.has(key)) {
      const lines = await highlight(text, languageOf(rel), cx);
      if (this.tokens.has(key)) return this.tokens.get(key); // another call made it meanwhile
      this.tokens.set(key, lines);
      this.tokChars = (this.tokChars ?? 0) + key.length;
      while (this.tokens.size > 1 && (this.tokens.size > 40 || this.tokChars > TOK_CHARS)) {
        const old = this.tokens.keys().next().value;
        this.tokens.delete(old); this.tokChars -= old.length;
      }
    }
    return this.tokens.get(key);
  }

  // ---- selection -----------------------------------------------------------

  // A file stays in view while it's being edited, even once it has no changes left.
  shown(f) { return f.hunks.length || (f.edited && f.key === this.sel) || this.dirty(f); }
  /** The tabs: changed files, plus in the Edit view the files opened from the tree. */
  visible() {
    if (this.mode === "changes") return [...this.files, ...(this.committed ?? [])];
    const changed = (f) => !f.plain && (f.error || this.shown(f));
    return this.files.filter((f) => changed(f) || (this.mode === "edit" && this.opened.includes(f.key)));
  }
  file() { return this.visible().find((f) => f.key === this.sel && !f.error); }

  replace(f, state) {
    const i = this.files.findIndex((x) => x.key === f.key);
    if (i >= 0) this.files[i] = state;
  }

  /** Keeps the selection on a file that still has hunks, preferring the next one. */
  settle() {
    const vis = this.visible();
    if (!vis.some((f) => f.key === this.sel)) {
      const at = this.files.findIndex((f) => f.key === this.sel);
      const next = this.files.slice(at + 1).find((f) => vis.includes(f)) ?? vis[vis.length - 1];
      this.sel = next?.key ?? null; this.current = 0;
    }
    const f = this.file();
    this.current = f ? Math.max(0, Math.min(this.current, f.hunks.length - 1)) : 0;
    if (!f) this.cur = this.anchor = null;
    else if (this.cur) { this.cur = this.clampPos(f, this.cur); if (this.anchor) this.anchor = this.clampPos(f, this.anchor); }
    if (this.sel) this.showTab(this.sel); // no-op when its tab is already on screen
  }

  rowsOf(f) {
    const w = this.wrapCols();
    if (f._rowsFor !== f.hunks || f._rowsC !== f.C || f._rowsW !== w) {
      const rows = buildRows(f.B, f.C, f.hunks);
      f._rows = w ? this.wrapRows(f, rows, w) : rows; f._rowsFor = f.hunks; f._rowsC = f.C; f._rowsW = w;
      f._lineRow = [];
      f._rows.forEach((r, i) => { if (r.side === "new" && !r.cont) f._lineRow[r.line] = i; });
    }
    return f._rows;
  }

  /** E5: with line wrap on, the text columns a row holds (0: wrap off). */
  wrapCols() {
    return this.settings.wordWrap ? Math.max(20, Math.floor(((this.viewW ?? 600) - GUTTER - 16) / this.cw())) : 0;
  }

  /** E5: a long line's row becomes one row per segment ({ seg, segs }; later ones have `cont`). */
  wrapRows(f, rows, w) {
    const out = [];
    for (const r of rows) {
      if (r.kind === "@") { out.push(r); continue; }
      const segs = segments(body((r.side === "old" ? f.B : f.C)[r.line]), w);
      if (segs.length === 1) out.push(r);
      else segs.forEach((seg, i) => out.push({ ...r, seg, segs, cont: i > 0 }));
    }
    return out;
  }

  /** The row showing position p of the current file (its segment's row when wrapped). */
  rowOfPos(f, p) {
    this.rowsOf(f);
    const i = f._lineRow[p.line];
    if (i == null) return null;
    const r = f._rows[i];
    return r.segs ? i + segmentOf(r.segs, p.col) : i;
  }

  toggleWrap(cx) {
    this.settings = { ...this.settings, wordWrap: !this.settings.wordWrap };
    this.hx = 0; this.selA = this.selB = null;
    const next = this.settings;
    cx.spawn(async () => { try { await saveSettings({ ...(await loadSettings()), wordWrap: next.wordWrap }); } catch (e) { this.error = String(e.message ?? e); } });
    this.showCursor(); cx.notify();
  }

  reveal() {
    const f = this.file();
    if (!f) return;
    const at = this.rowsOf(f).findIndex((r) => r.hunk === this.current);
    if (at >= 0) this.scrollTo(at - Math.floor(this.viewRows() / 2));
  }

  // ---- file tab strip -------------------------------------------------------
  // The pane scrolls the strip itself: a clipped row shifted left by a pixel offset. The wheel
  // moves it by its real pixel distance (smooth, unlike a list's jump-to-item handle), and the
  // selected tab is brought into view by working out its position from the tab widths.

  /** A tab's width, estimated from its text; the same widths place tabs and find them again. */
  tabWidth(x) {
    const tag = this.tabTag(x);
    const repo = this.stores.length > 1 ? base(x.store.root).length * 6.2 + 6 : 0;
    return Math.ceil(26 + base(x.rel).length * 7.4 + repo + tag.length * 6.2 + 6 + (this.dirty(x) ? 12 : 0) + (this.closable(x) ? 16 : 0));
  }

  tabTag(x) { return x.error ? (x.error === "binary file" ? "binary" : "error") : x.created ? "new" : x.Ctext === null ? "deleted" : x.hunks.length ? String(x.hunks.length) : ""; }

  /** Opened files close; changed files stay until reviewed (Q48). */
  closable(x) { return this.mode === "edit" && this.opened.includes(x.key) && !x.hunks.length; }

  tabMax() {
    const total = this.visible().reduce((w, x) => w + this.tabWidth(x), 0);
    return Math.max(0, total - (this.tabViewW ?? 0));
  }

  setTabOffset(px) { this.tabOffset = Math.max(0, Math.min(px, this.tabMax())); }

  /** Shifts the strip just enough to show `key`'s tab. */
  showTab(key) {
    if (!this.tabViewW) return; // not laid out yet; the size callback reveals it
    let x0 = 0;
    for (const x of this.visible()) {
      const w = this.tabWidth(x);
      if (x.key === key) {
        const off = this.tabOffset ?? 0, view = this.tabViewW ?? 0;
        if (x0 < off) this.setTabOffset(x0);
        else if (x0 + w > off + view) this.setTabOffset(x0 + w - view);
        return;
      }
      x0 += w;
    }
  }

  /** Either wheel axis, in pixels (lines count as 20 px). */
  tabWheel(ev, cx) {
    const d = ev.delta_lines ? (ev.delta_lines.x || ev.delta_lines.y) * 20 : ev.delta.x || ev.delta.y;
    if (!d) return;
    this.setTabOffset((this.tabOffset ?? 0) - d);
    cx.notify();
    cx.stop_propagation();
  }

  tab(x, t) {
    return h_flex().id(`file-${x.key}`).flex_none().w(this.tabWidth(x)).h_full().pr(4).items_center()
      .on_click((_e, cx) => { this.treeFocus = false; this.pick(x.key, cx); })
      .child(h_flex().w_full().h(26).px(10).gap(6).items_center().rounded(6).overflow_hidden().cursor_pointer()
        .when(x.key === this.sel, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
        .when(this.stores.length > 1, (e) => e.child(div().text_size(10).text_color(t.dim).whitespace_nowrap().child(base(x.store.root))))
        .child(div().text_size(12).whitespace_nowrap().child(base(x.rel)))
        .when(this.dirty(x), (e) => e.child(div().text_size(10).text_color(t.accent).child("●")))
        .child(div().text_size(10).whitespace_nowrap().text_color(x.error ? t.ansi1 : t.muted).child(this.tabTag(x)))
        .when(this.closable(x), (e) => e.child(div().id(`close-${x.key}`).px(3).rounded(3).text_size(11).text_color(t.dim)
          .hover((st) => st.bg(t.raised).text_color(t.foreground)).child("×")
          .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(x.key, cx); }))));
  }

  // ---- Edit view: opened files and the file tree (Q48) ---------------------------

  /** A file opened from the tree that has no changes: its own baseline, kept in memory only. */
  async loadPlain(store, rel, cx) {
    const path = `${store.root}/${rel}`, key = `${store.root}|${rel}`, f = { rel, path, basePath: null, store, key, plain: true, created: false, by: null, as: null, hunks: [] };
    let text = null, error = null;
    try { text = await readTextFile(path, { on: store.on ?? null }); } catch (e) { error = String(e.message ?? e); }
    if (!error && text === null) error = "file not found";
    // Binary: a NUL, or text that isn't UTF-8 (many replacement characters near the start).
    if (!error && (text.includes("\0") || (text.slice(0, 8000).match(/\uFFFD/g)?.length ?? 0) > 8)) error = "binary file";
    if (error) return { ...f, error };
    const C = splitLines(text);
    return this.withTokens({ ...f, Btext: text, Ctext: text, B: C, C }, cx);
  }

  async openFile(store, rel, cx, at = null) {
    const key = `${store.root}|${rel}`, space = this.spaceId, rk = `${idOf(store)}|${rel}`;
    this.recent = [rk, ...this.recent.filter((k) => k !== rk)].slice(0, 30);
    // Neovim's Edit view is the tree alone: the file goes straight to Neovim, at its first change.
    if (this.treeOnly()) {
      if (store.on) { this.error = NVIM_NOTE; cx.notify(); return; }
      const f = this.files.find((x) => x.key === key);
      this.treeSel = key; this.revealInTree(key, cx); cx.notify();
      try { await openInNvim(space, store.root, `${store.root}/${rel}`, at?.line ?? f?.hunks[0]?.n ?? 0); }
      catch (e) { this.error = String(e.message ?? e); cx.notify(); }
      return;
    }
    if (!this.files.some((f) => f.key === key)) {
      const f = await this.loadPlain(store, rel, cx);
      if (this.spaceId !== space || this.files.some((x) => x.key === key)) return;
      this.files.push(f);
    }
    if (!this.opened.includes(key)) this.opened.push(key);
    this.pick(key, cx);
    const f = this.file();
    if (f && at && f.key === key) { this.cur = this.clampPos(f, at); this.anchor = null; this.showCursor(); cx.notify(); }
    if (f && this.nvim()) this.toNvim(f, at?.line ?? f.hunks[0]?.n ?? 0, cx);
  }

  // ---- Quick Open (ctrl-p) ------------------------------------------------------

  openQuick(cx) {
    if (!this.repos().length) return;
    this.refreshTrees(cx);
    this.qo = { sel: 0, items: [] };
    this.quickInput.set_value(""); this.rankQuick();
    this.quickInput.focus(); cx.notify();
  }

  closeQuick(cx) { this.qo = null; this.inBar = null; this.handle.focus(); cx.notify(); }

  moveQuick(by, cx) {
    if (!this.qo?.items.length) return;
    const n = this.qo.items.length;
    this.qo.sel = (this.qo.sel + by + n) % n; cx.notify();
  }

  /** Every file of the space's repos, recent and changed ones first (the order an empty query shows). */
  quickItems() {
    const seen = new Set(), out = [];
    const add = (store, rel) => { const k = `${store.root}|${rel}`; if (!seen.has(k)) { seen.add(k); out.push({ key: k, store, rel }); } };
    const byKey = new Map(this.files.map((f) => [f.key, f]));
    // Plain roots (folders outside git) aren't searched.
    // Recent keys carry the root's id (rootId), so a file of the same path on another machine isn't one of them.
    for (const k of this.recent) { const f = byKey.get(k); if (f && !f.store.on) { if (!f.store.plain) add(f.store, f.rel); } else { const st = this.repos().find((s) => k.startsWith(idOf(s) + "|")); if (st) add(st, k.slice(idOf(st).length + 1)); } }
    for (const f of this.files) if (!f.plain && !f.error && f.hunks.length) add(f.store, f.rel);
    const head = out.length;
    for (const st of this.repos()) for (const rel of this.trees.get(idOf(st))?.paths ?? []) add(st, rel);
    return { all: out, head };
  }

  /** Tab: the box takes the highlighted file's path, keeping any :line already typed. */
  completeQuick(cx) {
    const it = this.qo?.items[this.qo.sel];
    if (!it) return;
    const at = /(:\d*(?::\d*)?)\s*$/.exec(this.quickInput.value())?.[1] ?? "";
    this.quickInput.set_value(it.rel + at);
    this.rankQuick(); cx.notify();
  }

  rankQuick() {
    if (!this.qo) return;
    const { name } = parseQuery(this.quickInput.value()), { all, head } = this.quickItems();
    this.qo.items = name ? rank(all, name) : all.slice(0, Math.max(head, 15)).map((it) => ({ ...it, pos: [] }));
    this.qo.sel = 0;
  }

  chooseQuick(i, cx) {
    const q = parseQuery(this.quickInput.value()), it = this.qo?.items[i];
    // ":12" alone: a line in the current file.
    if (!q.name && q.at) {
      const f = this.file();
      this.closeQuick(cx);
      if (f) { this.cur = this.clampPos(f, q.at); this.anchor = null; this.showCursor(); if (this.nvim()) this.toNvim(f, q.at.line, cx); cx.notify(); }
      return;
    }
    if (!it) return;
    this.closeQuick(cx);
    const changed = this.files.find((f) => f.key === it.key && !f.plain && f.hunks.length);
    if ((this.view === "review" && !changed) || this.view === "changes") return this.handOff("edit", cx, q.at, it.key);
    if (this.mode === "review" && !changed) this.setMode("edit", cx);
    cx.spawn(async (cx) => this.openFile(it.store, it.rel, cx, q.at));
  }

  quickOpen(t) {
    const items = this.qo.items, multi = this.repos().length > 1, counts = new Map(this.files.map((f) => [f.key, f.hunks.length]));
    const label = (it) => {
      const cut = it.rel.lastIndexOf("/") + 1, name = it.rel.slice(cut), dir = it.rel.slice(0, Math.max(0, cut - 1)), hit = new Set(it.pos);
      // The file name with its matched letters in the accent color.
      const parts = [];
      for (let i = 0; i < name.length; ) {
        const on = hit.has(cut + i); let j = i;
        while (j < name.length && hit.has(cut + j) === on) j++;
        parts.push(div().when(on, (e) => e.text_color(t.accent).font_semibold()).child(name.slice(i, j)));
        i = j;
      }
      return h_flex().min_w(0).gap(8).items_center()
        .child(h_flex().flex_none().text_size(13).children(parts))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child((multi ? base(it.store.root) + (dir ? "/" : "") : "") + dir));
    };
    return div().absolute().top(44).left(0).right(0).flex().justify_center().child(
      v_flex().w(620).max_w_full().max_h(440).p(6).gap(4).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .child(Input.new(this.quickInput))
        .child(v_flex().id("quick-list").overflow_y_scrollbar().children(items.map((it, i) =>
          h_flex().id(`quick-${it.key}`).h(26).flex_none().px(8).gap(8).items_center().rounded(4).cursor_pointer()
            .when(i === this.qo.sel, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.chooseQuick(i, cx))
            .child(div().flex_1().min_w(0).child(label(it)))
            .when(!!counts.get(it.key), (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi3).child(String(counts.get(it.key))))))))
        .when(!items.length, (e) => e.child(div().px(8).py(6).text_size(12).text_color(t.dim).child(this.trees.size ? "No matching files" : "Loading files…"))));
  }

  nvim() { return this.settings.editor === "nvim"; }

  /** E9: the current file in the external editor chosen in Settings, at the cursor, else at the current change. Unsaved edits are saved first. */
  toVSCode(cx) {
    const f = this.file();
    if (!f || f.Ctext === null) return;
    if (f.store?.on) { this.error = EDITOR_NOTE; cx.notify(); return; }
    if (this.dirty(f) && !f.conflict) this.save(cx, f);
    const at = this.cur ?? { line: f.hunks[this.current]?.n ?? 0, col: 0 };
    cx.spawn(async (cx) => {
      try { await openInEditor(this.settings.externalEditor, f.path, at.line, at.col, this.settings.externalCommand); }
      catch (e) { this.error = String(e.message ?? e); cx.notify(); }
    });
  }
  treeOnly() { return this.mode === "edit" && this.nvim(); }

  /** Opens `f` at `line` in the space's Neovim (N1). */
  toNvim(f, line, cx) {
    if (!f || f.Ctext === null) return;
    if (f.store?.on) { this.error = NVIM_NOTE; cx.notify(); return; }
    const space = this.spaceId;
    cx.spawn(async (cx) => {
      try { await openInNvim(space, f.store.root, f.path, line); }
      catch (e) { this.error = String(e.message ?? e); cx.notify(); }
    });
  }

  /** Closing saves unsaved edits when autosave is on (Q46); without it they must be saved first. */
  closeTab(key, cx) {
    const f = this.files.find((x) => x.key === key);
    if (f && this.dirty(f)) {
      if (!this.settings.autosave || f.conflict) { this.error = `${base(f.rel)} has unsaved edits: save them first (${this.kl("save")})`; cx.notify(); return; }
      this.save(cx, f);
    }
    this.opened = this.opened.filter((k) => k !== key);
    if (f?.plain) this.files = this.files.filter((x) => x.key !== key);
    if (this.sel === key) { this.cur = this.anchor = null; this.hx = 0; }
    this.error = null; this.settle(); cx.notify();
  }

  // ---- W1 workspace: adding and removing repos -------------------------------------
  // The repo strip is the tree's repo headers: each repo's name, change count and ×, with
  // "+ Add repo…" under them. Picking a folder that isn't a repo lists the repos inside it.
  // A main clone picked while the workspace's worktrees share a branch is offered as a new
  // worktree beside them. Removing asks first, and offers to delete a worktree too.

  space() { return spaces().find((s) => s.id === this.spaceId) ?? null; }
  hasRepo(root) { return this.stores.some((st) => norm(st.root) === norm(root) || norm(st.asked ?? "") === norm(root)); }

  /** The workspace's worktrees' shared branch and the folder beside them for `repo`, or null. */
  async worktreeOffer(repo) {
    const infos = await Promise.all(this.repos().map(async (st) => ({ st, info: await repoInfo(st.root, st.on ?? null).catch(() => null) })));
    const linked = infos.filter((x) => x.info?.linked);
    const branch = sharedBranch(linked.map((x) => x.info.branch)), dest = worktreeDest(linked.map((x) => x.st.root), repo);
    return branch && dest ? { branch, dest } : null;
  }

  /** Adds a repo to this space by hand: a repo, a parent folder of repos, or a main clone as a worktree.
   *  The folder picker is this computer's: a space on another machine takes a typed path there. */
  openFolder(cx) {
    if (!this.spaceId) return;
    if (this.machine()) { this.ws = { kind: "path" }; this.pathInput.set_value(""); this.pathInput.focus(); cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const dir = await pickFolder({ prompt: "Add a repo to this space" });
        if (!dir) return;
        this.wsBusy = "Looking…"; cx.notify();
        const st = await Store.open(dir).catch(() => null);
        if (!st) {
          const repos = await scanRepos(dir);
          if (!repos.length) throw new Error(`${dir} is not a git repo and holds none`);
          const offer = await this.worktreeOffer("x");
          this.ws = { kind: "pick", parent: dir, offer, asWorktrees: !!offer, repos: repos.map((path) => ({ path, on: false, has: this.hasRepo(path) })) };
          return;
        }
        if (this.hasRepo(st.root)) throw new Error(`${base(st.root)} is already in this space`);
        const info = await repoInfo(st.root), offer = info && !info.linked ? await this.worktreeOffer(base(st.root)) : null;
        if (offer) { this.ws = { kind: "worktree", root: st.root, ...offer }; return; }
        await this.addRepos([st.root], cx);
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.wsBusy = null; cx.notify(); }
    });
  }

  /** Space on another machine: the typed path's repo, or the repos inside it to pick from; a main
   *  clone is offered as a worktree beside the space's others, as here. */
  addPath(cx) {
    const on = this.machine(), dir = remotePath(this.pathInput.value().trim());
    if (!on || !dir || this.wsBusy) return;
    cx.spawn(async (cx) => {
      try {
        this.wsBusy = "Looking…"; cx.notify();
        const st = await Store.open(dir, on).catch(() => null);
        if (!st) {
          const repos = await scanRepos(dir, on);
          if (!repos.length) throw new Error(`${dir} on ${on} is not a git repo and holds none`);
          const offer = await this.worktreeOffer("x");
          this.ws = { kind: "pick", parent: dir, offer, asWorktrees: !!offer, on, repos: repos.map((path) => ({ path, on: false, has: this.hasRepo(path) })) };
          return;
        }
        if (this.hasRepo(st.root)) throw new Error(`${base(st.root)} is already in this space`);
        const info = await repoInfo(st.root, on), offer = info && !info.linked ? await this.worktreeOffer(base(st.root)) : null;
        if (offer) { this.ws = { kind: "worktree", root: st.root, on, ...offer }; return; }
        await this.addRepos([st.root], cx);
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.wsBusy = null; cx.notify(); }
    });
  }

  /** Adds repo folders to the space: to its workspace file (made when this makes two) and its repo map.
   *  On another machine, to Wingman's own workspace file only (workspace.js). */
  async addRepos(roots, cx) {
    const sp = this.space();
    if (!sp) return;
    for (const root of roots) {
      await addFolder(sp, root, this.repos().map((st) => st.asked ?? st.root));
      // The capture leader writes the same file: retry when it wrote first.
      if (!sp.machine) for (let i = 0; ; i++) { try { await addSpaceRepos([[sp.id, root]]); break; } catch (e) { if (i >= 2) throw e; } }
      this.misses?.delete(rootId(root, sp.machine ?? null));
    }
    this.ws = null; this.error = null; cx.notify();
    await this.follow(cx, true);
  }

  /** The pick panel's or worktree offer's confirm: makes worktrees where asked, then adds. */
  confirmAdd(cx) {
    const ws = this.ws;
    if (!ws || this.wsBusy) return;
    cx.spawn(async (cx) => {
      try {
        const roots = [];
        const items = ws.kind === "worktree" ? [{ path: ws.root }] : ws.repos.filter((r) => r.on && !r.has);
        const on = this.machine();
        for (const r of items) {
          const info = await repoInfo(r.path, on);
          const offer = ws.kind === "worktree" ? ws : ws.asWorktrees && ws.offer && info && !info.linked ? { branch: ws.offer.branch, dest: ws.offer.dest.replace(/[^/]+$/, base(r.path)) } : null;
          if (offer) {
            this.wsBusy = `Making a worktree for ${base(r.path)} on ${offer.branch}…`; cx.notify();
            await addWorktree(r.path, offer.dest, offer.branch, on);
            roots.push(offer.dest);
          } else roots.push(r.path);
        }
        this.wsBusy = "Adding…"; cx.notify();
        await this.addRepos(roots, cx);
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.wsBusy = null; cx.notify(); }
    });
  }

  /** × on a repo header: asks first (open changes come back when it's added again). */
  askRemove(st, cx) {
    if (this.files.some((f) => f.store === st && this.dirty(f))) { this.error = `${this.repoName(st)} has unsaved edits: save or undo them first`; cx.notify(); return; }
    const open = this.files.filter((f) => f.store === st).reduce((n, f) => n + (f.plain ? 0 : f.hunks.length), 0);
    this.ws = { kind: "remove", st, open, linked: null };
    cx.notify();
    if (!st.plain) cx.spawn(async (cx) => { const info = await repoInfo(st.root, st.on ?? null).catch(() => null); if (this.ws?.st === st) { this.ws.linked = !!info?.linked; cx.notify(); } });
  }

  confirmRemove(deleteWorktree, cx) {
    const ws = this.ws, sp = this.space();
    if (ws?.kind !== "remove" || !sp || this.wsBusy) return;
    cx.spawn(async (cx) => {
      try {
        if (deleteWorktree) { this.wsBusy = `Deleting the worktree ${ws.st.root}…`; cx.notify(); await removeWorktree(ws.st.root, ws.st.on ?? null); }
        await removeFolder(sp, ws.st.asked ?? ws.st.root);
        if (ws.st.asked && norm(ws.st.asked) !== norm(ws.st.root)) await removeFolder(sp, ws.st.root);
        this.ws = null; this.error = null;
        await this.follow(cx, true);
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.wsBusy = null; cx.notify(); }
    });
  }

  repoName(st) { return st.label ?? base(st.root); }

  /** Collapses or expands a root in the tree. Kept across reloads (per pane copy); repoOpen
   *  remembers plain roots opened by hand, which otherwise start collapsed beside a repo. */
  toggleRepo(st, cx) {
    const shut = (this.repoShut ??= new Set()), open = (this.repoOpen ??= new Set()), was = this.rootShut(st), id = idOf(st);
    if (was) { shut.delete(id); open.add(id); } else { shut.add(id); open.delete(id); }
    try { localStorage.setItem("repoShut", JSON.stringify([...shut])); localStorage.setItem("repoOpen", JSON.stringify([...open])); } catch {}
    if (was && st.plain) this.loadFolder(st, this.rootTree(st), "", cx);
    cx.notify();
  }

  /** The add, pick, worktree and remove panels, under the tree (or the status line without one). */
  workspacePanel(t) {
    const ws = this.ws;
    if (!ws && !this.wsBusy) return null;
    const box = v_flex().id("ws-panel").mx(8).my(6).p(8).gap(6).rounded(6).bg(t.raised).text_size(11);
    const actions = (...btns) => h_flex().gap(6).flex_wrap().children(btns.filter(Boolean));
    const cancel = this.button("ws-cancel", "Cancel", t.background, (cx) => { this.ws = null; cx.notify(); });
    if (this.wsBusy) return box.child(div().text_color(t.muted).child(this.wsBusy));
    if (ws.kind === "path") {
      return box.child(div().text_color(t.muted).child(`A repo, or a folder of repos, on ${this.machine() ?? "the space's machine"}`))
        .child(Input.new(this.pathInput))
        .child(actions(this.button("ws-path-add", "Add", t.accent + "55", (cx) => this.addPath(cx)), cancel));
    }
    if (ws.kind === "pick") {
      const n = ws.repos.filter((r) => r.on && !r.has).length;
      return box.child(div().text_color(t.muted).child(`Repos in ${ws.parent}`))
        .children(ws.repos.map((r, i) => h_flex().id(`ws-pick-${i}`).gap(6).items_center().cursor_pointer()
          .when(!r.has, (e) => e.on_click((_e, cx) => { r.on = !r.on; cx.notify(); }))
          .child(div().w(12).text_color(r.has ? t.dim : t.foreground).child(r.has ? "✓" : r.on ? "☑" : "☐"))
          .child(div().flex_1().min_w(0).truncate().text_color(r.has ? t.dim : t.foreground).child(base(r.path) + (r.has ? " (in this space)" : "")))))
        .when(!!ws.offer, (e) => e.child(h_flex().id("ws-as-wt").gap(6).items_center().cursor_pointer().on_click((_e, cx) => { ws.asWorktrees = !ws.asWorktrees; cx.notify(); })
          .child(div().w(12).child(ws.asWorktrees ? "☑" : "☐"))
          .child(div().flex_1().min_w(0).text_color(t.muted).child(`Main clones as new worktrees on ${ws.offer.branch}, beside the others`))))
        .child(actions(n ? this.button("ws-add", `Add ${n} repo${n === 1 ? "" : "s"}`, t.accent + "55", (cx) => this.confirmAdd(cx)) : null, cancel));
    }
    if (ws.kind === "worktree") {
      return box.child(div().text_color(t.foreground).child(`${base(ws.root)} is a main clone. This space's worktrees are on ${ws.branch}.`))
        .child(div().text_color(t.muted).child(`A new worktree goes in ${ws.dest}`))
        .child(actions(this.button("ws-wt", `Add a worktree on ${ws.branch}`, t.accent + "55", (cx) => this.confirmAdd(cx)),
          this.button("ws-clone", "Add the clone itself", t.background, (cx) => cx.spawn(async (cx) => { try { await this.addRepos([ws.root], cx); } catch (e) { this.error = String(e.message ?? e); cx.notify(); } })),
          cancel));
    }
    if (ws.kind === "remove") {
      const name = this.repoName(ws.st);
      return box.child(div().text_color(t.foreground).child(`Remove ${name} from this space?`))
        .when(ws.open > 0, (e) => e.child(div().text_color(t.ansi3).child(`It has ${ws.open} change${ws.open === 1 ? "" : "s"} to review. They come back if you add it again.`)))
        .when(!!ws.linked, (e) => e.child(div().text_color(t.muted).child("It's a worktree. Deleting it needs it to have no uncommitted or untracked files.")))
        .child(actions(this.button("ws-remove", "Remove", t.ansi1 + "40", (cx) => this.confirmRemove(false, cx)),
          ws.linked ? this.button("ws-remove-wt", "Remove and delete the worktree", t.ansi1 + "88", (cx) => this.confirmRemove(true, cx)) : null,
          cancel));
    }
    return null;
  }

  setMode(mode, cx) {
    if (this.view && mode !== this.view) return this.handOff(mode, cx);
    if (mode === this.mode) return;
    if (this.settings.autosave) this.saveAll(cx); // leaving a view saves (Q46)
    this.mode = mode;
    if (mode === "edit" && (this.treeOn || this.nvim())) this.refreshTrees(cx);
    this.settle(); this.handle.focus(); cx.notify();
  }

  /**
   * ctrl-shift-r: Review → Edit → Changes → Review. A pane copy has no Changes view, so it
   * flips Review and Edit; a panel copy skips Changes when the layout has no Changes block.
   */
  nextView() {
    if (!this.view) return this.mode === "review" ? "edit" : "review";
    const order = ["review", "edit", "changes"].filter((v) => v === this.view || hasView(v));
    return order[(order.indexOf(this.view) + 1) % order.length];
  }

  /** Panel split: shows the other view's copy and hands it the current file and line (`extra`: more for it, e.g. { search }). */
  handOff(view, cx, at = null, key = null, extra = null) {
    const f = key || extra ? null : this.file();
    if (this.settings.autosave) this.saveAll(cx);
    at ??= f ? this.cur ?? (f.hunks[this.current] ? { line: f.hunks[this.current].n, col: 0 } : null) : null;
    if (!showView(view)) { this.error = `This layout has no Wingman ${view === "edit" ? "Edit" : view === "changes" ? "Changes" : "Review"} panel`; cx.notify(); return; }
    setShared(GOTO, { view, space: this.spaceId, key: key ?? f?.openKey ?? f?.key ?? null, at, ...(extra ?? {}), stamp: Date.now() });
  }

  /** Panel split: what the other copy handed over (GOTO) and save requests from Review (SAVE). */
  takeShared(cx) {
    const g = this.view && shared(GOTO);
    if (g && g.view === this.view && g.stamp > this.gotoSeen) {
      this.gotoSeen = g.stamp;
      if (g.space === this.spaceId) {
        this.handle.focus();
        const i = g.key?.indexOf("|") ?? -1, store = i > 0 && this.stores.find((st) => st.root === g.key.slice(0, i));
        if (g.search && this.view === "edit") this.showSearch(g.search.query, cx);
        else if (store && this.view === "edit") cx.spawn(async (cx) => this.openFile(store, g.key.slice(i + 1), cx, g.at));
        else if (store && this.visible().some((f) => f.key === g.key)) {
          this.pick(g.key, cx);
          const f = this.file(), line = g.at?.line ?? 0;
          if (f?.hunks.length) { let h = 0; f.hunks.forEach((x, j) => { if (x.n <= line) h = j; }); this.current = h; this.reveal(); }
        }
        cx.notify();
      }
    }
    // Another copy renamed or deleted something: its tabs and tree follow here too.
    const fo = shared(FILEOP);
    if (fo && fo.stamp > this.fileopSeen) { this.fileopSeen = fo.stamp; if (fo.copy !== this.id) this.applyFileOp(fo, cx, false); }
    const r = shared(SAVE);
    if (r && r.stamp > this.saveSeen) {
      this.saveSeen = r.stamp;
      if (this.settings.autosave) for (const f of this.files) if (r.keys.includes(f.key) && this.dirty(f) && !f.conflict) this.save(cx, f);
    }
  }

  /** Panel split: this copy's files with unsaved edits, for Review to check (renewed every 10 s while any). */
  publishDirty() {
    const keys = this.files.filter((f) => this.dirty(f)).map((f) => f.key).sort(), sig = keys.join("\n"), now = Date.now();
    if (sig === this.dirtySig && (!keys.length || now - this.dirtyAt < 10000)) return;
    this.dirtySig = sig; this.dirtyAt = now;
    const all = { ...(shared(DIRTY) ?? {}) };
    for (const [id, v] of Object.entries(all)) if (now - (v?.at ?? 0) > DIRTY_FRESH) delete all[id];
    if (keys.length) all[this.id] = { keys, at: now }; else if (!(this.id in all)) return; else delete all[this.id];
    setShared(DIRTY, all);
  }

  /** Files among `keys` that another copy holds unsaved edits to. */
  heldElsewhere(keys) {
    const now = Date.now(), held = new Set();
    for (const [id, v] of Object.entries(shared(DIRTY) ?? {}))
      if (id !== this.id && now - (v?.at ?? 0) <= DIRTY_FRESH) for (const k of v.keys ?? []) held.add(k);
    return keys.filter((k) => held.has(k));
  }

  // ---- G1/G2: the Changes view (props.view "changes") ---------------------------

  initChanges(cx) {
    this.unchecked = new Set(); this.discardKey = null; this.commitNote = null; this.commitRoot = null; this.committing = false;
    this.commitInput = TextareaState.new({ placeholder: "Commit message (Ctrl+Enter commits the checked files)", rows: 3 });
    this.commitInput.on("submit", (e, cx) => { if (e?.secondary) this.commit(cx); });
    this.commitInput.on("change", (_e, cx) => cx.notify());
    this.commitInput.on("focus", () => { this.inBar = this.commitInput; this.treeFocus = false; });
    this.commitInput.on("blur", () => { if (this.inBar === this.commitInput) this.inBar = null; });
    cx.timer.every(2000, (cx) => this.refreshChanges(cx));
  }

  /** Review publishes its open change count per file, for the Changes view's tags. */
  publishReview() {
    if (this.view !== "review") return;
    const m = {};
    for (const f of this.files) if (!f.plain && !f.error) m[f.key] = f.hunks.length;
    const sig = JSON.stringify(m);
    if (sig === this.reviewSig) return;
    this.reviewSig = sig; setShared(REVIEW, m);
  }

  /** git in a store's repo, wherever the repo lives (git.js), on its machine. */
  git(st, args, opts = {}) { return git(args, { cwd: st.root, on: st.on ?? null, ...opts }); }

  /** A repo's `git status`, its HEAD and its files ({ out, head, list }). On another machine one call (STATUS_V2). */
  async statusOf(st) {
    if (st.on) {
      const s = await this.git(st, STATUS_V2);
      if (s.code !== 0) throw new Error(`git status in ${base(st.root)}: ${(s.stderr || s.stdout).trim()}`);
      return { out: s.stdout, ...parseStatusV2(s.stdout) };
    }
    const [s, head] = await Promise.all([this.git(st, STATUS), this.git(st, [...READ, "rev-parse", "-q", "--verify", "HEAD"])]);
    if (s.code !== 0) throw new Error(`git status in ${base(st.root)}: ${(s.stderr || s.stdout).trim()}`);
    return { out: s.stdout, head: head.code === 0 ? head.stdout.trim() : null, list: parseStatus(s.stdout) };
  }

  /**
   * What says a repo's listed files changed, beside its status: here the review index (each listed
   * file is reread too); on another machine, where every read is a call, one `git hash-object` of
   * the listed files on disk ("!" when that fails, e.g. a file went meanwhile: the status shows it).
   */
  async stampOf(st, list) {
    if (!st.on) return st.stamp();
    const rels = onDisk(list).slice(0, REMOTE.hashMax);
    if (!rels.length) return "";
    const r = await this.git(st, ["hash-object", "--no-filters", "--", ...rels]);
    return r.code === 0 ? r.stdout : "!";
  }

  /** Every uncommitted file in the space's repos, as HEAD (B) against the working tree (C). */
  async loadChanges(cx) {
    if (this.loadingChanges) return;
    this.loadingChanges = true;
    try {
      const files = [], committed = [], sig = [];
      for (const st of this.repos()) {
        const { out, head, list } = await this.statusOf(st), stamp = await this.stampOf(st, list);
        sig.push(idOf(st), head, out, stamp);
        const { ai, done } = await this.aiMarks(st), counts = await this.lineCounts(st, head);
        // Texts are fetched a few at a time on another machine (each read is a call), one by one here.
        const texts = await mapLimit(list, st.on ? REMOTE.parallel : 1, ({ rel, xy }) => this.changeTexts(st, rel, xy, !!head));
        for (const t of texts) {
          const f = await this.tokened(t, cx);
          files.push({ ...f, ai: ai.has(f.rel), ...this.countsOf(f, counts.get(f.rel)) });
        }
        if (head) committed.push(...(await this.loadCommitted(st, head, done, cx)));
      }
      this.files = files; this.committed = committed; this.changeSig = sig.join("\0"); this.status = null;
      if (this.discardKey && !files.some((f) => f.key === this.discardKey)) this.discardKey = null;
      this.settle(); cx.notify();
    } catch (e) { this.error = String(e.message ?? e); cx.notify(); }
    finally { this.loadingChanges = false; }
  }

  /** A changed file's HEAD text (B), working-tree text (C) and hunks, read where the repo lives; not yet highlighted. */
  async changeTexts(st, rel, xy, hasHead) {
    const path = `${st.root}/${rel}`, key = `${st.root}|${rel}`;
    const f = { rel, path, basePath: null, store: st, key, xy, letter: statusLetter(xy), plain: false, created: false, by: null, as: null, hunks: [] };
    try {
      const show = hasHead ? await this.git(st, [...READ, "show", `HEAD:${rel}`]) : { code: 1, stdout: "" };
      const inHead = show.code === 0, Btext = inHead ? show.stdout : "", Ctext = await readTextFile(path, { on: st.on ?? null });
      if (Btext.includes("\0") || Ctext?.includes("\0")) return { ...f, inHead, error: "binary file" };
      // The diff runs here, on temp copies (merge.js), wherever the texts came from.
      const hunks = await diffHunks(Btext, Ctext ?? "");
      return { ...f, inHead, created: !inHead, Btext, Ctext, B: splitLines(Btext), C: splitLines(Ctext ?? ""), hunks, toTok: true };
    } catch (e) { return { ...f, error: String(e.message ?? e) }; }
  }

  /** changeTexts' result highlighted (an error stays as it is). */
  async tokened(t, cx) {
    if (!t.toTok) return t;
    const { toTok, ...f } = t;
    try { return await this.withTokens(f, cx); }
    catch (e) { return { rel: f.rel, path: f.path, basePath: null, store: f.store, key: f.key, xy: f.xy, letter: f.letter, plain: false, created: false, by: null, as: null, hunks: [], error: String(e.message ?? e) }; }
  }

  /** D3: line counts of a repo's uncommitted changes against HEAD (staged plus unstaged with no commits yet). */
  async lineCounts(st, head) {
    const runs = head ? [NUMSTAT] : NUMSTAT_NO_HEAD;
    const outs = await Promise.all(runs.map((args) => this.git(st, args)));
    return parseNumstat(...outs.map((r) => (r.code === 0 ? r.stdout : "")));
  }

  /** { add, del } for a Changes row: git's counts, or an untracked file's lines; none for binary files. */
  countsOf(f, c) {
    if (f.error || c?.binary) return {};
    if (c) return { add: c.add, del: c.del };
    return f.xy === "??" || (f.created && f.Ctext != null) ? { add: countLines(f.Ctext), del: 0 } : {};
  }

  /** Which files an agent of this space changed on this branch: `ai` (still in review), `done` (committed). */
  async aiMarks(st) {
    const [text, branch] = await Promise.all([st.read(`${st.dir}/index.json`), st.branch()]);
    let index = {};
    try { index = text ? JSON.parse(text) : {}; } catch {}
    const mine = (e) => shows(e, branch, this.spaceId, spaceOfAgent), ai = new Set(), done = new Set();
    for (const [rel, e] of Object.entries(index.files ?? {})) if (mine(e)) ai.add(rel);
    for (const [k, e] of Object.entries(index.done ?? {})) if (k.startsWith(`${branch}|`) && mine({ ...e, branch })) done.add(k.slice(branch.length + 1));
    return { ai, done };
  }

  /** Where this branch starts: its merge base with the remote's default branch (else main or master). */
  async branchBase(st, head) {
    const cached = (this.bases ??= new Map()).get(idOf(st));
    if (cached?.head === head) return cached.base;
    let base = null;
    for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
      const r = await this.git(st, [...READ, "merge-base", "HEAD", ref]);
      if (r.code === 0 && r.stdout.trim() !== head) { base = r.stdout.trim(); break; }
      if (r.code === 0) break; // HEAD is that branch's tip: nothing committed on top of it
    }
    this.bases.set(idOf(st), { head, base });
    return base;
  }

  /** The files committed on this branch (its base against HEAD), read-only, with AI marks. */
  async loadCommitted(st, head, done, cx) {
    const base = await this.branchBase(st, head);
    if (!base) return [];
    const [r, n] = await Promise.all([this.git(st, [...READ, "diff", "--name-status", "-z", "--no-renames", base, "HEAD"]),
      this.git(st, [...READ, "diff", "--numstat", "-z", "--no-renames", base, "HEAD"])]);
    if (r.code !== 0) return [];
    const counts = parseNumstat(n.code === 0 ? n.stdout : "");
    const parts = r.stdout.split("\0").filter(Boolean), items = [];
    for (let i = 0; i + 1 < parts.length && items.length < MAX_FILES; i += 2) items.push([parts[i], parts[i + 1]]);
    // Blobs a few at a time on another machine (each is a call), one by one here; highlighting after, in order.
    const texts = await mapLimit(items, st.on ? REMOTE.parallel : 1, async ([status, rel]) => {
      const letter = status[0] === "A" ? "A" : status[0] === "D" ? "D" : "M";
      const f = { rel, path: `${st.root}/${rel}`, basePath: null, store: st, key: `${st.root}|${rel}#committed`, openKey: `${st.root}|${rel}`,
        committed: true, letter, ai: done.has(rel), plain: false, created: letter === "A", by: null, as: null, hunks: [] };
      try {
        const [b, c] = await Promise.all([st.blobAt(base, rel), st.blobAt("HEAD", rel)]);
        if ((b ?? "").includes("\0") || (c ?? "").includes("\0")) return { ...f, error: "binary file" };
        const hunks = await diffHunks(b ?? "", c ?? "");
        const k = counts.get(rel);
        return { f, t: { ...f, ...(k && !k.binary ? { add: k.add, del: k.del } : {}), Btext: b ?? "", Ctext: c, B: splitLines(b ?? ""), C: splitLines(c ?? ""), hunks } };
      } catch (e) { return { ...f, error: String(e.message ?? e) }; }
    });
    const out = [];
    for (const x of texts) {
      if (!x.t) { out.push(x); continue; }
      try { out.push(await this.withTokens(x.t, cx)); } catch (e) { out.push({ ...x.f, error: String(e.message ?? e) }); }
    }
    return out;
  }

  /** Every 2 s (5 s on another machine): reloads when git status or HEAD changed, or a listed file's text did. */
  async refreshChanges(cx) {
    // One check at a time: WSL git on a Windows drive takes over a second per status.
    if (this.refreshing || this.loadingChanges || this.committing || !this.repos().length) return;
    const remote = this.repos().some((st) => st.on);
    if (remote && Date.now() - (this.changesAt ?? 0) < REMOTE.changesMs) return;
    this.refreshing = true;
    try {
      const sig = [];
      for (const st of this.repos()) { const { out, head, list } = await this.statusOf(st); sig.push(idOf(st), head, out, await this.stampOf(st, list)); }
      let stale = sig.join("\0") !== this.changeSig;
      // Another machine's files are covered by stampOf's hashes.
      for (const f of this.files) { if (stale) break; if (!f.error && !f.store?.on && (await readTextFile(f.path)) !== f.Ctext) stale = true; }
      if (stale) await this.loadChanges(cx);
    } catch (e) { this.error = String(e.message ?? e); cx.notify(); }
    finally { this.refreshing = false; if (remote) this.changesAt = Date.now(); }
  }

  /** Puts a file back as HEAD has it (asked first by the button). Unsaved edits in Edit block it. */
  discard(f, cx) {
    this.discardKey = null;
    if (this.heldElsewhere([f.key]).length) { this.error = `${base(f.rel)} has unsaved edits in Edit: save or discard them there first`; cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        for (const args of discardCommands(f.rel, f.inHead)) {
          const r = await this.git(f.store, args);
          if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
        }
        this.error = null; this.commitNote = `Discarded ${f.rel}`;
      } catch (e) { this.error = String(e.message ?? e); }
      await this.loadChanges(cx);
    });
    cx.notify();
  }

  /** The repo the commit box commits to: the one picked, else the first with changes. */
  commitStore() {
    const withChanges = this.repos().filter((st) => this.files.some((f) => f.store === st));
    return withChanges.find((st) => st.root === this.commitRoot) ?? withChanges[0] ?? null;
  }

  checkedIn(st) { return this.files.filter((f) => f.store === st && !this.unchecked.has(f.key)); }

  /** Commits the checked files of the commit repo, only them, with the message. */
  commit(cx) {
    const st = this.commitStore();
    if (!st || this.committing) return;
    let cmds;
    try { cmds = commitCommands(this.checkedIn(st).map((f) => f.rel), this.commitInput.value()); }
    catch (e) { this.error = String(e.message ?? e); cx.notify(); return; }
    const held = this.heldElsewhere(this.checkedIn(st).map((f) => f.key));
    if (held.length) { this.error = `Unsaved edits in Edit: ${held.map((k) => base(k.slice(k.indexOf("|") + 1))).join(", ")}. Save or discard them first`; cx.notify(); return; }
    this.committing = true; this.error = null; this.commitNote = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const args of cmds) {
          const r = await this.git(st, args, { timeout: 120000 });
          if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
        }
        this.commitNote = `Committed ${cmds[1].length - 4} file${cmds[1].length === 5 ? "" : "s"} to ${base(st.root)}`;
        this.commitInput.set_value(""); this.unchecked.clear();
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.committing = false; }
      await this.loadChanges(cx); cx.notify();
    });
  }

  renderChanges(t) {
    const review = shared(REVIEW), st = this.commitStore(), multi = this.repos().length > 1;
    const checked = st ? this.checkedIn(st) : [], open = checked.filter((f) => (review?.[f.key] ?? 0) > 0).length;
    const box = (on) => div().w(14).h(14).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent : t.background)
      .flex().items_center().justify_center().text_size(10).text_color(t.background).child(on ? "✓" : "");
    const letterColor = { A: t.ansi2, D: t.ansi1, "!": t.ansi3, M: t.ansi4 };
    const row = (f) => {
      const cut = f.rel.lastIndexOf("/") + 1, tag = f.committed ? null : reviewTag(f.key, review), on = !this.unchecked.has(f.key);
      return h_flex().id(`chg-${f.key}`).h(26).flex_none().px(8).gap(6).items_center().rounded(5).cursor_pointer()
        .when(f.key === this.sel, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (!f.error) this.pick(f.key, cx); else { this.error = `${f.rel}: ${f.error}`; cx.notify(); } })
        .when(!f.committed, (e) => e.child(div().id(`chk-${f.key}`).on_click((_e, cx) => { cx.stop_propagation(); if (on) this.unchecked.add(f.key); else this.unchecked.delete(f.key); cx.notify(); }).child(box(on))))
        .when(!!f.committed, (e) => e.child(div().w(14).flex_none()))
        .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(letterColor[f.letter] ?? t.muted).child(f.letter))
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().flex_none().text_size(12.5).when(!!f.error, (e) => e.text_color(t.dim)).child(f.rel.slice(cut)))
          .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child((multi ? base(f.store.root) + (cut ? "/" : "") : "") + f.rel.slice(0, Math.max(0, cut - 1)))))
        .when(f.add != null, (e) => e.child(h_flex().flex_none().gap(4).text_size(10)
          .child(div().text_color(t.ansi2).child(`+${f.add}`)).child(div().text_color(t.ansi1).child(`−${f.del}`))))
        .when(!!f.ai, (e) => e.child(div().flex_none().px(4).rounded(3).bg(t.accent + "33").text_size(9.5).text_color(t.accent).child("AI")))
        .when(!!tag, (e) => e.child(div().flex_none().text_size(10).text_color(tag === "reviewed" ? t.dim : t.ansi3).child(tag)));
    };
    const done = this.committed ?? [];
    const adds = this.files.reduce((n, f) => n + (f.add ?? 0), 0), dels = this.files.reduce((n, f) => n + (f.del ?? 0), 0);
    const all = this.files.length > 0 && this.files.every((f) => !this.unchecked.has(f.key));
    return v_flex().w(320).flex_none().h_full().border_r(1).border_color(t.border)
      .child(h_flex().h(36).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().id("chk-all").cursor_pointer().on_click((_e, cx) => { if (all) for (const f of this.files) this.unchecked.add(f.key); else this.unchecked.clear(); cx.notify(); }).child(box(all)))
        .child(div().flex_1().text_size(12).text_color(t.muted).child(`${this.files.length} changed file${this.files.length === 1 ? "" : "s"}`))
        .when(adds + dels > 0, (e) => e.child(h_flex().flex_none().gap(4).text_size(11)
          .child(div().text_color(t.ansi2).child(`+${adds}`)).child(div().text_color(t.ansi1).child(`−${dels}`)))))
      .child(v_flex().id("chg-list").flex_1().min_h(0).p(4).overflow_y_scrollbar().children(this.files.map(row))
        .when(done.length > 0, (e) => e.child(div().px(8).pt(10).pb(4).text_size(11).font_semibold().text_color(t.muted)
          .child(`Committed on this branch · ${done.length} file${done.length === 1 ? "" : "s"}${done.some((f) => f.ai) ? ` · ${done.filter((f) => f.ai).length} by AI` : ""}`))
          .children(done.map(row))))
      .child(v_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
        .when(multi && !!st, (e) => e.child(h_flex().gap(4).flex_wrap().children(this.repos().filter((s) => this.files.some((f) => f.store === s)).map((s) =>
          div().id(`repo-${s.root}`).h(22).px(8).flex().items_center().rounded(5).text_size(11).cursor_pointer()
            .bg(s === st ? t.accent + "77" : t.raised).on_click((_e, cx) => { this.commitRoot = s.root; cx.notify(); }).child(base(s.root))))))
        .child(Textarea.new(this.commitInput).h(72).px(8).py(6).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12))
        .when(open > 0, (e) => e.child(div().text_size(11).text_color(t.ansi3).child(`${open} checked file${open === 1 ? " has" : "s have"} changes still to review`)))
        .when(!!this.commitNote, (e) => e.child(div().text_size(11).text_color(t.dim).child(this.commitNote)))
        .child(this.button("commit", this.committing ? "Committing…" : `Commit ${checked.length} file${checked.length === 1 ? "" : "s"}${multi && st ? ` to ${base(st.root)}` : ""}`, checked.length && !this.committing ? t.accent + "88" : t.raised, (cx) => this.commit(cx)).h(28).justify_center()));
  }

  /** ctrl-b: shows or hides the tree, switching to the Edit view first if needed. */
  toggleTree(cx) {
    if (this.mode !== "edit") { this.treeOn = true; return this.setMode("edit", cx); }
    this.treeOn = !this.treeOn;
    if (this.treeOn) this.refreshTrees(cx);
    cx.notify();
  }

  // ---- D1: the Explorer tree ------------------------------------------------------
  // One lazy tree per root (filetree.js). A repo's folders come from its file list and one
  // `git status` (ignored paths), never from disk, except inside an ignored folder. A plain root
  // is listed from disk a folder at a time (fsx.listDir: about 1 s per call on a Windows drive).

  /** A root's tree state, kept per copy across spaces (as the open folders were). */
  rootTree(st) {
    const m = (this.ftrees ??= new Map());
    let R = m.get(idOf(st));
    if (!R || R.plain !== !!st.plain) {
      R = { plain: !!st.plain, tree: createTree(), ver: 0, index: null, marks: null, match: null, statOut: null, listedAt: new Map(), listSig: new Map(), errors: new Map(), pending: new Set() };
      m.set(idOf(st), R);
    }
    return R;
  }

  /** Whether a repo folder's entries come from disk: inside an ignored folder, or unknown to git. */
  onDisk(R, rel) { return !!rel && (!!R.match?.(rel) || !R.index?.has(rel)); }

  /** Fills a folder's listing: from the repo's index when it can, else a disk listing (queued). */
  loadFolder(st, R, rel, cx, refresh = false) {
    if (!st.plain) {
      if (!R.index) return; // the index fills it when it arrives
      if (!this.onDisk(R, rel)) { this.fillIndexed(R, rel); return; }
    }
    if (refresh || !R.tree.entries.has(rel)) this.queueList(st, rel, cx);
  }

  /** Disk listings run one at a time, never as a burst of slow calls. */
  queueList(st, rel, cx) {
    const jobs = (this.listJobs ??= []), R = this.rootTree(st);
    if (!R.pending.has(rel)) { R.pending.add(rel); jobs.push({ st, rel }); }
    if (this.listing) return;
    this.listing = true;
    cx.spawn(async (cx) => {
      try {
        while (jobs.length) {
          const { st, rel } = jobs.shift(), R = this.rootTree(st);
          let res, error = null;
          try { res = await listDir(pjoin(st.root, rel), { limit: PER_FOLDER, on: st.on ?? null }); }
          catch (e) { res = { entries: [], more: false }; error = String(e.message ?? e); }
          R.pending.delete(rel); R.listedAt.set(rel, Date.now());
          if (rel && !R.tree.open.has(rel)) continue; // closed meanwhile
          const sig = JSON.stringify([res, error]);
          if (R.listSig.get(rel) === sig && R.tree.entries.has(rel)) continue;
          R.listSig.set(rel, sig);
          if (error) R.errors.set(rel, error); else R.errors.delete(rel);
          setFolder(R.tree, rel, res.entries, res.more); R.ver++;
          cx.notify();
        }
      } finally { this.listing = false; }
    });
  }

  toggleDir(st, rel, cx) {
    const R = this.rootTree(st);
    toggle(R.tree, rel); R.ver++;
    // Opening a disk-listed folder lists it again (its old listing shows meanwhile).
    if (R.tree.open.has(rel)) this.loadFolder(st, R, rel, cx, true);
    cx.notify();
  }

  /** Opens the folders above a file, loading those that have no listing yet. */
  revealInTree(key, cx) {
    const i = key.indexOf("|"), root = key.slice(0, i), rel = key.slice(i + 1), st = this.stores.find((x) => x.root === root);
    if (!st) return;
    const R = this.rootTree(st), was = R.tree.open.size, need = reveal(R.tree, rel);
    if (R.tree.open.size !== was) R.ver++;
    for (const d of need) this.loadFolder(st, R, d, cx);
  }

  /** Whether a root's header is collapsed: by the user, or a plain root by default beside a repo. */
  rootShut(st) {
    if (this.repoShut?.has(idOf(st))) return true;
    return !!st.plain && !this.repoOpen?.has(idOf(st)) && this.stores.some((x) => !x.plain);
  }

  /** The plain root's refresh button: lists its loaded folders again, one at a time. */
  refreshPlain(st, cx) {
    const R = this.rootTree(st);
    for (const rel of loaded(R.tree)) this.queueList(st, rel, cx);
    if (!R.tree.entries.has("")) this.queueList(st, "", cx);
  }

  /**
   * Each repo's file list (tracked and untracked, for the tree and Quick Open) and one status call
   * (letters and ignored paths), where the repo lives. A folder index is rebuilt only when either
   * output changed, and the view redraws only then. Plain roots: the root's first listing, then
   * their stalest open folder every 30 s at most, one per pass.
   */
  refreshTrees(cx, force = false) {
    // force: right after a file operation, remote roots too, and again after a pass already running.
    if (force) for (const st of this.stores) { const R = this.rootTree(st); R.passAt = R.listAt = 0; }
    if (this.treeBusy) { if (force) this.treeAgain = true; return; }
    this.treeBusy = true;
    cx.spawn(async (cx) => {
      let changed = false;
      // Outside the Edit view (Quick Open in Review or Changes) only the repos' file lists are
      // needed: no status, folder index or plain root listings, which only the tree shows.
      const edit = this.mode === "edit", at = edit ? "passAt" : "listAt";
      try {
        for (const st of this.stores) {
          const R = this.rootTree(st);
          // A root on another machine: one pass at most every 10 s (a remote call is about 200 ms).
          if (st.on) {
            if (Date.now() - (R[at] ?? 0) < REMOTE.treeMs) continue;
            R[at] = Date.now();
          }
          if (st.plain && !edit) continue;
          if (st.plain) {
            if (this.rootShut(st)) continue;
            if (!R.tree.entries.has("")) { this.queueList(st, "", cx); continue; }
            if (this.listJobs?.length) continue;
            const stale = loaded(R.tree).map((rel) => [rel, R.listedAt.get(rel) ?? 0]).sort((a, b) => a[1] - b[1])[0];
            if (stale && Date.now() - stale[1] > 30000) this.queueList(st, stale[0], cx);
            continue;
          }
          const [r, s] = await Promise.all([this.git(st, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]), edit ? this.git(st, STATUS_TREE) : null]);
          if (r.code !== 0) {
            const error = (r.stderr || r.stdout).trim();
            if (this.trees.get(idOf(st))?.error !== error) { this.trees.set(idOf(st), { error }); changed = true; }
            continue;
          }
          if (this.trees.get(idOf(st))?.list !== r.stdout) {
            const paths = [...new Set(r.stdout.split("\0").filter(Boolean))];
            this.trees.set(idOf(st), { list: r.stdout, paths });
            if (!edit) changed = true;
          }
          if (!edit) continue;
          const out = s.code === 0 ? s.stdout : "";
          if (R.statOut !== out) {
            const { marks, ignored } = parseTreeStatus(out);
            R.statOut = out; R.marks = marks; R.ignored = ignored; R.match = ignoredMatcher(ignored); changed = true;
          }
          const tr = this.trees.get(idOf(st));
          if (R.indexFor === tr && R.indexIgnored === R.ignored) continue;
          R.indexFor = tr; R.indexIgnored = R.ignored; R.index = folderIndex(tr.paths, R.ignored); changed = true;
          for (const m of R.made ?? []) if (R.index.has(m)) R.made.delete(m); // git lists files in it now
          for (const rel of ["", ...R.tree.open]) {
            if (!this.onDisk(R, rel)) this.fillIndexed(R, rel);
            else if (!R.tree.entries.has(rel)) this.queueList(st, rel, cx);
          }
          R.ver++;
        }
      } catch (e) { log(`tree: ${e.message ?? e}`); }
      finally {
        this.treeBusy = false;
        if (changed) { if (this.qo) this.rankQuick(); cx.notify(); }
        if (this.treeAgain) { this.treeAgain = false; this.refreshTrees(cx, true); }
      }
    });
  }

  /** Change counts and unsaved marks per file and folder of one root (folder keys without a trailing "/"). */
  treeCounts(st) {
    const counts = new Map(), add = (rel, n, dirty) => {
      const c = counts.get(rel) ?? { n: 0, dirty: false };
      c.n += n; c.dirty ||= dirty; counts.set(rel, c);
    };
    for (const f of this.files) if (f.store === st && !f.error) {
      const n = f.hunks.length, d = this.dirty(f);
      if (!n && !d) continue;
      add(f.rel, n, d);
      for (let i = f.rel.lastIndexOf("/"); i > 0; i = f.rel.lastIndexOf("/", i - 1)) add(f.rel.slice(0, i), n, d);
    }
    return counts;
  }

  /** A root's visible rows, rebuilt only when its tree, status or counts changed. */
  rootRows(st, R) {
    const counts = this.treeCounts(st), sig = JSON.stringify([...counts]), c = R.rowsCache;
    if (c && c.ver === R.ver && c.marks === R.marks && c.sig === sig) return c.rows;
    const rows = treeRows(R.tree, { marks: R.marks ?? new Map(), ignored: R.match ?? (() => false), counts });
    R.rowsCache = { ver: R.ver, marks: R.marks, sig, rows };
    return rows;
  }

  renderTree(t, full = false) {
    const multi = this.stores.length > 1, out = [], picked = full ? this.treeSel : this.sel;
    const note = (id, text, color = t.dim, depth = 0) => div().id(id).pl(10 + depth * 12).pr(10).py(4).text_size(11).text_color(color).child(text);
    const letterColor = { A: t.ansi2, M: t.ansi4, D: t.ansi1, U: t.ansi1 };
    if (full && this.error) out.push(note("tree-error", this.error, t.ansi1));
    if (!this.stores.length) out.push(note("tree-none", "No repo in this space yet"));
    let scrollAt = null; // the row a file operation asked to bring into view (treeScrollTo)
    for (const st of this.stores) {
      const R = this.rootTree(st), shut = this.rootShut(st), id = idOf(st);
      const ed = this.treeEdit?.id === id ? this.treeEdit : null, del = this.treeDel?.id === id ? this.treeDel : null;
      const editRows = (depth) => {
        if (this.treeScrollTo === "edit") scrollAt = out.length;
        out.push(h_flex().id(`tree-edit-${id}`).min_h(24).flex_none().pl(8 + depth * 12).pr(8).gap(4).items_center()
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(ed.isDir ? "▸" : ""))
          .child(div().flex_1().min_w(0).child(Input.new(this.treeInput))));
        if (ed.error) out.push(note(`tree-edit-err-${id}`, ed.error, t.ansi1, depth));
        else if (ed.busy) out.push(note(`tree-edit-busy-${id}`, "Working…", t.dim, depth));
      };
      // A plain root always has a header, for its refresh button.
      if (multi || st.plain) {
        const n = st.plain ? 0 : this.files.filter((f) => f.store === st && !f.plain).reduce((k, f) => k + f.hunks.length, 0);
        out.push(h_flex().id(`tree-repo-${st.root}`).pl(8).pr(6).pt(8).pb(2).gap(4).items_center().text_size(11).cursor_pointer()
          .on_click((_e, cx) => this.toggleRepo(st, cx))
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openTreeMenu(st, "", true, cx); })
          .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(shut ? "▸" : "▾"))
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.muted).child(this.repoName(st)))
          .when(n > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi3).child(String(n))))
          .when(!!st.plain && !shut, (e) => e.child(div().id(`tree-repo-r-${st.root}`).flex_none().w(16).h(16).flex().items_center().justify_center().rounded(3).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); this.refreshPlain(st, cx); }).child("⟳")))
          .child(div().id(`tree-repo-x-${st.root}`).flex_none().w(16).h(16).flex().items_center().justify_center().rounded(3).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); this.askRemove(st, cx); }).child("×")));
        if (shut) continue;
      }
      const tr = st.plain ? null : this.trees.get(idOf(st));
      if (tr?.error) { out.push(note(`tree-err-${st.root}`, tr.error, t.ansi1)); continue; }
      if (R.errors.get("")) { out.push(note(`tree-err-${st.root}`, R.errors.get(""), t.ansi1)); continue; }
      if (st.plain ? !R.tree.entries.has("") : !R.index) { out.push(note(`tree-load-${st.root}`, "Loading…")); continue; }
      if (ed && ed.kind !== "rename" && ed.dir === "") editRows(0);
      for (const row of this.rootRows(st, R)) {
        const k = `${st.root}|${row.rel}`;
        if (row.more) { out.push(note(`tree-more-${k}`, "… more files not shown", t.dim, row.depth)); continue; }
        if (ed?.kind === "rename" && row.rel === ed.rel) { editRows(row.depth); continue; }
        const gone = !row.dir && (row.deleted || row.mark === "D"), cur = this.treeFocus && this.treeCur?.id === id && this.treeCur.rel === row.rel;
        if (this.treeScrollTo === k) scrollAt = out.length;
        out.push(h_flex().id(`tree-${k}`).h(22).flex_none().pl(8 + row.depth * 12).pr(8).gap(4).items_center().cursor_pointer()
          .when(!row.dir && k === picked, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .when(cur, (e) => e.bg(t.selected).rounded(3).border_1().border_color(t.accent + "aa"))
          .on_click((_e, cx) => { this.selectTreeRow(st, row, cx); if (row.dir) this.toggleDir(st, row.rel, cx); else cx.spawn(async (cx) => this.openFile(st, row.rel, cx)); })
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openTreeMenu(st, row.rel, row.dir, cx); })
          .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(row.dir ? (row.open ? "▾" : "▸") : ""))
          .child(div().flex_1().min_w(0).truncate().text_size(12)
            .text_color(row.ignored || gone ? t.dim : row.dir ? t.muted : t.foreground)
            .when(row.ignored, (e) => e.opacity(0.7)).when(gone, (e) => e.line_through()).child(row.name))
          .when(!!row.dirty, (e) => e.child(div().flex_none().text_size(10).text_color(t.accent).child("●")))
          .when(!!row.n, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi3).child(String(row.n))))
          .when(!!row.mark, (e) => e.child(div().w(10).flex_none().text_size(10).font_semibold().text_color(letterColor[row.mark] ?? t.muted).child(row.mark))));
        if (del && row.rel === del.rel) out.push(this.deleteBox(del, row.depth, t));
        if (ed && ed.kind !== "rename" && row.dir && row.rel === ed.dir) editRows(row.depth + 1);
        if (row.dir && row.open && R.errors.get(row.rel)) out.push(note(`tree-err-${k}`, R.errors.get(row.rel), t.ansi1, row.depth + 1));
        else if (row.dir && row.loading) out.push(note(`tree-load-${k}`, "Loading…", t.dim, row.depth + 1));
      }
    }
    // A request is consumed after layout; a failed one only leaves the tree where it was.
    if (scrollAt != null) { try { this.treeScroll.scroll_to_item(scrollAt); } catch {} this.treeScrollTo = null; }
    out.push(div().id("tree-open-folder").mx(8).mt(6).px(6).h(22).flex().items_center().rounded(4).text_size(11).text_color(t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.openFolder(cx)).child("+ Add repo…"));
    const panel = this.workspacePanel(t);
    if (panel) out.push(panel);
    // Its width and border come from the left column around it (renderLeft).
    // A right-click on the tree's empty space, with one root: that root's menu (New File… at its top).
    return v_flex().id("file-tree").flex_1().min_h(0).py(4).overflow_y_scrollbar().track_scroll(this.treeScroll)
      .on_mouse_down("right", (_e, cx) => { if (this.stores.length === 1) this.openTreeMenu(this.stores[0], "", true, cx); })
      .children(out);
  }

  // ---- Explorer file operations (fileops.js names and targets, fsx.js file-system calls) --------
  // A right-click on a tree row or root header opens the menu. A click on a row selects it and gives
  // the tree the keyboard (treeFocus), where F2 renames and Delete deletes; a click in the editor, a
  // tab or any input takes the keyboard back, so Delete in a file still deletes text. New File…, New
  // Folder… and Rename… show a name box in the tree (treeEdit), Delete a confirm under the row
  // (treeDel). Afterwards the folders and the repo's file list are read again at once, open folders
  // stay open, tabs of renamed or deleted files follow, and the other copies are told (FILEOP).

  /** A tree item: a row, or a root header (rel ""). `id` names its root across spaces (idOf). */
  treeItem(st, rel, dir) { return { id: idOf(st), rel, dir: !!dir, root: !rel }; }

  /** The root of a tree item, while it's still one of this space's. */
  itemStore(it) { return (it && this.stores.find((s) => idOf(s) === it.id)) ?? null; }

  /** A left click on a row: it's selected, and the tree has the keyboard. Open name boxes and confirms close. */
  selectTreeRow(st, row, cx) {
    this.treeCur = this.treeItem(st, row.rel, row.dir); this.treeFocus = true; this.searchFocus = false;
    this.treeDel = null;
    if (this.treeEdit && !this.treeEdit.busy) this.endTreeEdit(cx, false);
    this.handle.focus(); cx.notify();
  }

  /** The right-click menu for a row or root header (the popup copy sends its command back: treeMenuCmd). */
  openTreeMenu(st, rel, dir, cx) {
    if (this.treeEdit?.busy) return;
    const it = this.treeItem(st, rel, dir), local = !st.on;
    if (!it.root) this.treeCur = it;
    this.treeFocus = true; this.searchFocus = false; this.treeDel = null; this.menuItem = it;
    if (this.treeEdit) this.endTreeEdit(cx, false);
    this.handle.focus();
    setShared(TREE_MENU, { copy: this.id, stamp: Date.now() });
    const items = [
      { cmd: "treeNewFile", label: "New File…", key: "" },
      { cmd: "treeNewFolder", label: "New Folder…", key: "" },
      ...(local ? [{ cmd: "treeReveal", label: onWindows() ? "Reveal in File Explorer" : "Reveal in file manager", key: "" }] : []),
      ...(local && !dir ? [{ cmd: "treeExternal", label: `Open in ${editorName(this.settings.externalEditor)}`, key: "" }] : []),
      { cmd: "treeCopyPath", label: "Copy Path", key: "" },
      { cmd: "treeCopyRel", label: "Copy Relative Path", key: "" },
      ...(it.root ? [{ cmd: "treeRefresh", label: "Refresh", key: "" }]
        : [{ cmd: "treeRename", label: "Rename…", key: this.kl("renameItem") }, { cmd: "treeDelete", label: "Delete", key: this.kl("deleteItem") }]),
    ];
    openOverlay({ mod: "wingman", props: { form: "menu", items }, kind: "popup", at: "pointer", width: 260, height: items.length * 30 + 12 });
    cx.notify();
  }

  /** A tree menu command. Every shown copy gets it; only the copy that opened the menu acts. */
  treeMenuCmd(c, cx) {
    const it = this.menuItem;
    if (shared(TREE_MENU)?.copy !== this.id || !it) return;
    this.menuItem = null;
    const st = this.itemStore(it);
    if (!st) return;
    const copied = (text) => cx.write_to_clipboard(text);
    ({
      treeNewFile: () => this.startTreeEdit("newFile", it, cx),
      treeNewFolder: () => this.startTreeEdit("newFolder", it, cx),
      treeRename: () => this.startTreeEdit("rename", it, cx),
      treeDelete: () => this.askTreeDelete(it, cx),
      treeCopyPath: () => copied(copyPaths(st.root, it.rel, windowsRoot(st.root, st.on ?? null)).path),
      treeCopyRel: () => copied(copyPaths(st.root, it.rel, windowsRoot(st.root, st.on ?? null)).relative),
      treeReveal: () => this.revealItem(st, it, cx),
      treeExternal: () => this.externalItem(st, it, cx),
      treeRefresh: () => this.refreshRoot(st, cx),
    })[c]?.();
    cx.notify();
  }

  /** Shows the error line (the tree's own in the Neovim layout). */
  treeNote(msg, cx) { this.error = msg; cx.notify(); }

  /** Files at `rel` or under it with unsaved edits, in this copy or another: why it can't be renamed or deleted, or null. */
  unsavedUnder(st, rel) {
    const top = `${st.root}|${rel}`, hit = (k) => k === top || k.startsWith(`${top}/`), keys = new Set();
    for (const f of this.files) if (f.store === st && hit(f.key) && (this.dirty(f) || f.conflict)) keys.add(f.key);
    const now = Date.now();
    for (const [id, v] of Object.entries(shared(DIRTY) ?? {}))
      if (id !== this.id && now - (v?.at ?? 0) <= DIRTY_FRESH) for (const k of v.keys ?? []) if (hit(k)) keys.add(k);
    if (!keys.size) return null;
    const names = [...keys].map((k) => k.slice(k.indexOf("|") + 1));
    return `Unsaved edits in ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}: save or discard them first`;
  }

  /** Opens a root and a folder in it (and the folders above), so a name box inside it shows. */
  openTreeFolder(st, dir, cx) {
    if (this.rootShut(st)) this.toggleRepo(st, cx);
    if (!dir) return;
    const R = this.rootTree(st), need = reveal(R.tree, `${dir}/x`);
    R.ver++;
    for (const d of need) this.loadFolder(st, R, d, cx);
  }

  /** New File…, New Folder… (in the item's folder, or beside a file) or Rename… of the item: the name box. */
  startTreeEdit(kind, it, cx) {
    const st = this.itemStore(it);
    if (!st || this.treeEdit?.busy || this.mode !== "edit") return;
    this.treeDel = null;
    if (kind === "rename") {
      const why = checkRel(it.rel) ?? this.unsavedUnder(st, it.rel);
      if (why) return this.treeNote(why, cx);
    } else this.openTreeFolder(st, it.dir ? it.rel : parentOf(it.rel), cx);
    const name = kind === "rename" ? nameOf(it.rel) : "", isDir = kind === "newFolder" || (kind === "rename" && it.dir);
    this.treeEdit = { kind, id: it.id, dir: kind === "rename" ? null : it.dir ? it.rel : parentOf(it.rel), rel: kind === "rename" ? it.rel : null,
      isDir, name, sel: kind === "rename" ? stemEnd(name, it.dir) : 0, error: null, busy: false };
    this.treeCur = kind === "rename" ? it : this.treeCur;
    this.treeFocus = true; this.treeScrollTo = "edit"; this.error = null;
    this.treeInput.set_value(name);
    this.focusTreeInput(true);
    cx.notify();
  }

  /** Puts the keyboard in the name box; `select`: Rename's name before its extension is selected (while untouched). */
  focusTreeInput(select = false) {
    const e = this.treeEdit;
    if (!e) return;
    this.treeInput.focus();
    if (select && e.sel && this.treeInput.value() === e.name) this.treeInput.set_selected_range({ start: 0, end: e.sel });
  }

  /** Closes the name box; the tree keeps the keyboard unless `keep` is false. */
  endTreeEdit(cx, keep = true) {
    this.treeEdit = null;
    if (this.inBar === this.treeInput) this.inBar = null;
    if (keep) { this.treeFocus = true; this.handle.focus(); }
    cx.notify();
  }

  /** Enter in the name box: checks the name (shown under the box, which stays), then creates or renames. */
  commitTreeEdit(cx) {
    const e = this.treeEdit, st = this.itemStore(e);
    if (!e || e.busy) return;
    if (!st) return this.endTreeEdit(cx);
    const name = this.treeInput.value(), windows = windowsRoot(st.root, st.on ?? null), on = st.on ?? null;
    let t;
    if (e.kind === "rename") {
      t = renameTarget({ root: st.root, rel: e.rel, name, isDir: e.isDir, windows });
      if (!t.error && t.same) return this.endTreeEdit(cx);
      if (!t.error) { const why = this.unsavedUnder(st, e.rel); if (why) t = { error: why }; }
    } else t = newTarget({ root: st.root, dir: e.dir, name, kind: e.kind === "newFolder" ? "dir" : "file", windows });
    if (t.error) { e.error = t.error; cx.notify(); return; }
    e.busy = true; e.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (e.kind === "newFile") await createFile(t.path, st.root, { on });
        else if (e.kind === "newFolder") await createDir(t.path, st.root, { on });
        else await movePath(t.fromPath, t.path, st.root, { on });
      } catch (err) {
        e.busy = false; e.error = String(err.message ?? err);
        if (this.treeEdit === e) this.treeInput.focus();
        cx.notify(); return;
      }
      if (this.treeEdit === e) this.endTreeEdit(cx);
      this.treeCur = this.treeItem(st, t.rel, e.isDir);
      if (e.kind === "rename") {
        const made = [];
        for (let p = parentOf(t.rel); p && !within(parentOf(e.rel), p) ; p = parentOf(p)) made.unshift(p);
        this.afterFileOp(st, { from: e.rel, to: t.rel, isDir: e.isDir, made: e.isDir ? [...made, t.rel] : made }, cx);
      } else this.afterFileOp(st, { added: t.rel, isDir: e.kind === "newFolder", made: t.made }, cx);
      // A new file opens with the cursor in it, as VS Code does: the editor has the keyboard.
      if (e.kind === "newFile") { await this.openFile(st, t.rel, cx, { line: 0, col: 0 }); if (this.sel === `${st.root}|${t.rel}`) this.treeFocus = false; }
      cx.notify();
    });
  }

  /** Delete (menu or key): the confirm under the row, naming the item and, for a folder, its file count when the repo's file list knows it. */
  askTreeDelete(it, cx) {
    const st = this.itemStore(it);
    if (!st || this.treeEdit?.busy || this.mode !== "edit") return;
    const why = checkRel(it.rel) ?? this.unsavedUnder(st, it.rel);
    if (why) return this.treeNote(why, cx);
    let count = null;
    if (it.dir && !st.plain) {
      const R = this.rootTree(st), tr = this.trees.get(idOf(st)), p = `${it.rel}/`;
      // Ignored files aren't in the list: a folder holding any says "everything in it".
      const hidden = !R.index?.has(it.rel) || R.match?.(it.rel) || (R.ignored ?? []).some((x) => x.startsWith(p));
      if (tr?.paths && !hidden) count = countUnder(tr.paths, it.rel) - [...(R.marks ?? [])].filter(([x, l]) => l === "D" && x.startsWith(p)).length;
    }
    if (this.treeEdit) this.endTreeEdit(cx, false);
    this.treeDel = { ...it, count, busy: false, error: null };
    this.treeCur = it; this.treeFocus = true; this.treeScrollTo = `${st.root}|${it.rel}`; this.error = null;
    this.handle.focus(); cx.notify();
  }

  /** The delete confirm, under the row it names. */
  deleteBox(d, depth, t) {
    return v_flex().id("tree-del").ml(8 + depth * 12).mr(8).my(4).p(8).gap(6).rounded(6).bg(t.raised).text_size(11)
      .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
      .child(div().text_color(t.foreground).child(deleteQuestion({ rel: d.rel, isDir: d.dir, count: d.count })))
      .when(!!d.error, (e) => e.child(div().text_color(t.ansi1).child(d.error)))
      .child(h_flex().gap(6)
        .child(this.button("tree-del-yes", d.busy ? "Deleting…" : "Delete", t.ansi1 + "88", (cx) => this.confirmTreeDelete(cx)))
        .child(this.button("tree-del-no", "Cancel", t.background, (cx) => { this.treeDel = null; cx.notify(); })));
  }

  /** The confirm's Delete (or Enter): deletes permanently, then the tree and tabs follow. */
  confirmTreeDelete(cx) {
    const d = this.treeDel, st = this.itemStore(d);
    if (!st || d.busy) return;
    const why = this.unsavedUnder(st, d.rel); // edits made since the confirm opened
    if (why) { d.error = why; cx.notify(); return; }
    d.busy = true; d.error = null; cx.notify();
    const path = under(st.root, d.rel), on = st.on ?? null;
    cx.spawn(async (cx) => {
      try { if (d.dir) await deleteTree(path, st.root, { on }); else await deleteFile(path, st.root, { on }); }
      catch (e) { if (e.code !== "missing") { d.busy = false; d.error = String(e.message ?? e); cx.notify(); return; } }
      if (this.treeDel === d) this.treeDel = null;
      this.treeCur = null;
      this.afterFileOp(st, { removed: d.rel, isDir: d.dir }, cx);
      cx.notify();
    });
  }

  /** Keys while the tree has the keyboard. True: handled. A key that isn't the tree's or a pane action gives the keyboard back. */
  treeKey(e, cx) {
    const k = e.keystroke;
    if (!(this.mode === "edit" && (this.treeOn || this.treeOnly()) && this.search.left !== "search")) { this.treeFocus = false; return false; }
    if (!keystrokeOf(e)) return false; // a modifier alone
    const id = this.kIdx.tree.get(k);
    if (id) { this.runAction(id, cx); return true; }
    if (k === "enter" && this.treeDel) { this.confirmTreeDelete(cx); return true; }
    if (k === "escape") { if (this.treeDel) this.treeDel = null; else this.treeFocus = false; cx.notify(); return true; }
    if (!this.kIdx.pane.has(k)) { this.treeFocus = false; cx.notify(); }
    return false;
  }

  /** Reveal in File Explorer / Finder / the file manager (this computer's roots only). */
  revealItem(st, it, cx) {
    if (st.on) return;
    cx.spawn(async (cx) => {
      try { await revealPath(under(st.root, it.rel), it.dir); }
      catch (e) { this.error = String(e.message ?? e); cx.notify(); }
    });
  }

  /** Open in the external editor from the tree (this computer's files); unsaved edits are saved first. */
  externalItem(st, it, cx) {
    if (st.on || it.dir) return;
    const f = this.files.find((x) => x.key === `${st.root}|${it.rel}`);
    if (f && this.dirty(f) && !f.conflict) this.save(cx, f);
    cx.spawn(async (cx) => {
      try { await openInEditor(this.settings.externalEditor, under(st.root, it.rel), 0, 0, this.settings.externalCommand); }
      catch (e) { this.error = String(e.message ?? e); cx.notify(); }
    });
  }

  /** A root header's Refresh: its file list and status, and every folder listed from disk, again now. */
  refreshRoot(st, cx) {
    if (st.plain) return this.refreshPlain(st, cx);
    const R = this.rootTree(st);
    for (const rel of loaded(R.tree)) if (this.onDisk(R, rel)) this.queueList(st, rel, cx);
    this.refreshTrees(cx, true);
  }

  /** A repo folder's listing from git's file list, plus folders made here that git can't list yet (empty ones). */
  fillIndexed(R, rel) {
    let list = R.index?.get(rel) ?? [];
    if (R.made?.size) {
      const have = new Set(list.map((e) => e.name)), extra = [];
      for (const m of R.made) if (parentOf(m) === rel && m !== rel && !have.has(nameOf(m))) extra.push({ name: nameOf(m), dir: true });
      if (extra.length) list = [...list, ...extra];
    }
    setFolder(R.tree, rel, list); R.ver++;
  }

  /** After this copy's file operation: here (applyFileOp), then the other copies (FILEOP). */
  afterFileOp(st, op, cx) {
    const full = { ...op, root: st.root, on: st.on ?? null };
    this.applyFileOp(full, cx, true);
    setShared(FILEOP, { ...full, copy: this.id, stamp: Date.now() });
  }

  /**
   * What a file operation means for this copy. op: { root, on, added | removed | from+to, isDir, made }.
   * The tree: open folders follow a renamed folder, a deleted one's listings go, the affected folders
   * and the repo's file list are read again now, and (mine) the new or renamed item is revealed.
   * Tabs: an opened file that was renamed reopens at its new path, one that was deleted closes, and
   * undo steps for them are dropped. A file under review is left to Review, as git sees it: the old
   * path deleted, the new one added.
   */
  applyFileOp(op, cx, mine) {
    const st = this.stores.find((s) => s.root === op.root && (s.on ?? null) === (op.on ?? null));
    if (!st) return;
    const R = this.rootTree(st), gone = op.removed ?? op.from ?? null, to = op.to ?? null, now = op.added ?? to;
    const follow = (set) => { for (const k of [...set]) if (within(k, gone)) { set.delete(k); const n = to != null ? remap(k, gone, to) : null; if (n) set.add(n); } };
    if (gone != null) {
      follow(R.tree.open);
      for (const k of [...R.tree.entries.keys()]) if (k && within(k, gone)) R.tree.entries.delete(k);
      if (R.made) follow(R.made);
      R.ver++;
    }
    if (!st.plain && op.made?.length) { R.made ??= new Set(); for (const m of op.made) R.made.add(m); }
    // The folders that changed: listed again from disk, or refilled from the index (with made folders).
    const dirs = new Set([gone != null ? parentOf(gone) : null, now != null ? parentOf(now) : null, ...(op.made ?? []).map(parentOf)].filter((d) => d != null));
    for (const d of dirs) {
      if (d && !R.tree.open.has(d)) continue;
      if (st.plain || this.onDisk(R, d)) this.queueList(st, d, cx);
      else if (R.index) this.fillIndexed(R, d);
    }
    if (this.mode === "edit") this.refreshTrees(cx, true);
    if (mine && now != null) { const k = `${st.root}|${now}`; this.revealInTree(k, cx); this.treeScrollTo = k; }
    if (gone != null) this.followTabs(st, gone, to, cx);
    cx.notify();
  }

  /** Tabs after `gone` (a file or folder) was deleted, or renamed to `to`. */
  followTabs(st, gone, to, cx) {
    const rid = `${idOf(st)}|`;
    this.recent = (this.recent ?? []).filter((k) => !(k.startsWith(rid) && within(k.slice(rid.length), gone)));
    const hit = this.files.filter((f) => f.store === st && within(f.rel, gone));
    if (!hit.length) return;
    const keys = new Set(hit.map((f) => f.key)), plain = hit.filter((f) => f.plain), reopen = [];
    for (const f of hit) if (to != null && (this.opened.includes(f.key) || this.sel === f.key)) reopen.push({ rel: remap(f.rel, gone, to), sel: this.sel === f.key });
    this.files = this.files.filter((f) => !plain.includes(f));
    this.opened = this.opened.filter((k) => !plain.some((f) => f.key === k));
    const touches = (h) => (h.key && keys.has(h.key)) || h.snaps?.some((s) => keys.has(s.key));
    this.history = this.history.filter((h) => !touches(h)); this.redo = this.redo.filter((h) => !touches(h));
    if (keys.has(this.sel)) { this.cur = this.anchor = null; this.hx = 0; this.selA = this.selB = null; }
    // Review's files reread from disk: a deleted or renamed file under review shows as deleted there.
    if (hit.some((f) => !f.plain)) { this.deferred.add("*"); if (!this.writing) cx.spawn(async (cx) => this.drain(cx)); }
    this.error = null; this.settle();
    if (this.mode !== "edit" || !reopen.length) return;
    cx.spawn(async (cx) => {
      for (const r of reopen) {
        const key = `${st.root}|${r.rel}`;
        if (!this.files.some((f) => f.key === key)) { const g = await this.loadPlain(st, r.rel, cx); if (!this.files.some((f) => f.key === key)) this.files.push(g); }
        if (!this.opened.includes(key)) this.opened.push(key);
        if (r.sel) this.pick(key, cx);
      }
      this.settle(); cx.notify();
    });
  }

  // ---- scrolling -------------------------------------------------------------
  // The pane scrolls the list itself, in whole rows, so it always knows which row is at
  // the top: the list reports no scroll position, and its rows can't take mouse handlers,
  // so this is what lets a pointer position map to a row (clicks, drags, the menu).

  viewRows() { return Math.max(1, Math.floor((this.viewH ?? 400) / ROW)); }

  /**
   * scroll_to_item only moves the list when the row is off screen, bringing it to the nearest
   * edge. So scrolling up asks for the new top row (above the view: lands at the top), and
   * scrolling down asks for the new bottom row (below the view: lands at the bottom). The list
   * is a whole number of rows tall, so either way the top lands exactly on a row.
   */
  scrollTo(top) {
    const f = this.file(), n = f ? this.rowsOf(f).length : 0, rows = this.viewRows(), cur = this.top ?? 0;
    const next = Math.max(0, Math.min(Math.round(top), Math.max(0, n - rows)));
    if (next < cur) this.scroll.scroll_to_item(next, "top");
    else if (next > cur) this.scroll.scroll_to_item(Math.min(n - 1, next + rows - 1), "top");
    this.top = next;
  }

  /** Keeps row `i` on screen, moving as little as possible. */
  ensureVisible(i) {
    const top = this.top ?? 0, rows = this.viewRows();
    if (i < top) this.scrollTo(i);
    else if (i >= top + rows) this.scrollTo(i - rows + 1);
  }

  /** The row under a y position in the diff, or -1. The scrollbar can also move the list, so
   *  the first row the list last drew wins over the pane's own idea of the top. */
  rowAt(y) {
    const f = this.file();
    if (!f) return -1;
    if (this.drawnTop != null && this.drawnTop !== this.top) this.top = this.drawnTop;
    const i = (this.top ?? 0) + Math.floor(y / ROW);
    return i >= 0 && i < this.rowsOf(f).length ? i : -1;
  }

  wheel(ev, cx) {
    // Sideways (Shift+wheel, or a sideways swipe) scrolls long lines.
    const dx = ev.delta_lines ? ev.delta_lines.x * 3 * this.cw() : ev.delta.x;
    const sideways = ev.modifiers?.shift ? (ev.delta_lines ? ev.delta_lines.y * 3 * this.cw() : ev.delta.y) : dx;
    if (ev.modifiers?.shift || Math.abs(dx) > Math.abs(ev.delta_lines?.y ?? ev.delta.y)) {
      if (this.wrapCols()) return; // wrapped lines don't scroll sideways
      this.hx = Math.max(0, this.hx - sideways); cx.notify(); cx.stop_propagation(); return;
    }
    const lines = ev.delta_lines?.y ?? ev.delta.y / ROW;
    this.wheelAcc = (this.wheelAcc ?? 0) - lines;
    const step = Math.trunc(this.wheelAcc);
    if (!step) return;
    this.wheelAcc -= step;
    this.scrollTo((this.top ?? 0) + step);
    if (this.dragging && this.dragY != null) this.dragTo(this.dragY);
    cx.notify();
    cx.stop_propagation();
  }

  // ---- pointer: click, Shift+click, drag, right-click ------------------------

  pointerDown(ev, cx) {
    this.handle.focus(); this.searchFocus = false; this.treeFocus = false;
    // A click in the editor closes the tree's name box or delete confirm (nothing is done).
    if (this.treeEdit && !this.treeEdit.busy) this.treeEdit = null;
    if (this.treeDel && !this.treeDel.busy) this.treeDel = null;
    const f = this.file(), x = ev.local_position?.x ?? -1, y = ev.local_position?.y ?? -1, i = this.rowAt(y);
    if (!f || i < 0) return;
    const r = this.rowsOf(f)[i];
    if (r.kind === "@") return this.mode === "changes" ? undefined : this.rowButton(r.hunk, x, cx);
    // The text: place the cursor, select words or lines, or start a text drag (Q42).
    if (x >= GUTTER && this.editable(f)) return this.textDown(f, r, x, y, ev, cx);
    this.anchor = null; // the line numbers: line selection, as before
    const sel = this.lineSel(f), shift = !!ev.modifiers?.shift;
    this.dragging = true; this.dragY = y; this.downRow = i;
    // A press inside the selection deselects on release, unless it turns into a drag.
    this.pendingDeselect = !shift && !!sel && i >= sel[0] && i <= sel[1];
    if (!this.pendingDeselect) this.select(i, shift, cx);
  }

  /** While the button is held: extend the selection to the row under the pointer, scrolling
   *  a row at a time near the top and bottom edges. */
  pointerMove(ev, cx) {
    if (!this.dragging) return;
    this.dragY = ev.local_position.y; this.dragX = ev.local_position.x;
    if (this.dragY < ROW) this.scrollTo((this.top ?? 0) - 1);
    else if (this.dragY > (this.viewH ?? 400) - ROW) this.scrollTo((this.top ?? 0) + 1);
    this.dragTo(this.dragY);
    cx.notify();
  }

  dragTo(y) {
    const f = this.file(), n = f ? this.rowsOf(f).length : 0;
    const i = Math.max(0, Math.min((this.top ?? 0) + Math.floor(y / ROW), n - 1));
    if (this.tdrag) {
      const r = this.rowsOf(f)[i];
      if (r?.side === "new") this.cur = this.posAt(f, r, this.dragX ?? GUTTER);
      return;
    }
    if (this.pendingDeselect) {
      if (i === this.downRow) return;
      // Dragging from inside the selection starts a new one at the pressed line.
      this.pendingDeselect = false;
      this.selA = this.downRow; this.selFor = this.rowsOf(f);
    }
    if (this.selA != null) this.selB = i;
  }

  // A release outside the diff isn't reported, so leaving it ends the drag too (and is
  // never a deselecting click).
  pointerUp(cx, released = true) {
    if (released && this.pendingDeselect) this.clearSelection(cx);
    this.pendingDeselect = false; this.dragging = false; this.tdrag = false;
  }

  /** A hunk's button row: which button the x position falls on. */
  rowButton(i, x, cx) {
    if (x >= GUTTER + BTN_GAP && x < GUTTER + BTN_GAP + BTN_W) this.hunk("reject", i, cx);
    else if (x >= GUTTER + 2 * BTN_GAP + BTN_W && x < GUTTER + 2 * (BTN_GAP + BTN_W)) this.hunk("accept", i, cx);
    else if (x >= GUTTER + 3 * BTN_GAP + 2 * BTN_W && x < GUTTER + 3 * (BTN_GAP + BTN_W)) this.askPrompt(i, cx);
    else { this.current = i; cx.notify(); }
  }

  step(by, cx) {
    const f = this.file();
    if (!f) return;
    if (!f.hunks.length) return;
    this.current = (this.current + by + f.hunks.length) % f.hunks.length;
    if (this.cur) { const h = f.hunks[this.current]; this.cur = this.clampPos(f, { line: h.n, col: 0 }); this.anchor = null; }
    this.reveal(); cx.notify();
  }

  stepFile(by, cx) {
    const vis = this.visible().filter((f) => !f.error);
    if (!vis.length) return;
    const at = vis.findIndex((f) => f.key === this.sel);
    this.pick(vis[(at + by + vis.length) % vis.length].key, cx);
  }

  pick(key, cx) {
    if (!this.visible().some((f) => f.key === key)) return;
    if (this.mode === "edit") this.revealInTree(key, cx);
    if (key !== this.sel) {
      const old = this.file();
      if (old && this.settings.autosave && this.dirty(old) && !old.conflict) this.save(cx, old);
      this.cur = this.anchor = null; this.hx = 0;
    }
    this.sel = key; this.current = 0; this.top = 0; this.showTab(key); this.handle.focus(); this.searchFocus = false; this.reveal(); cx.notify();
  }

  // ---- actions -------------------------------------------------------------

  /**
   * Applies model actions to files at once and queues their disk writes.
   * `plan` is a list of [file, action] where action(state) -> { state, write }.
   */
  run(plan, cx, feedback = []) {
    if (!plan.length || this.mode === "changes") return;
    if (plan.some(([f]) => f.conflict)) { this.error = "Pick Keep mine or Take agent's first"; cx.notify(); return; }
    // Panel split: another copy (Edit) holds unsaved edits to these files. Review acts on what's
    // on disk, so they're saved first (autosave on) or left to the user (off).
    const held = this.heldElsewhere(plan.map(([f]) => f.key));
    if (held.length) {
      const names = held.map((k) => base(k.slice(k.indexOf("|") + 1))).join(", ");
      if (this.settings.autosave) {
        setShared(SAVE, { keys: held, stamp: Date.now() });
        const paths = new Set(plan.filter(([f]) => held.includes(f.key)).map(([f]) => norm(f.path ?? "")));
        cx.timer.after(800, (cx) => this.onWatch(paths, cx));
        this.error = `Saving your edits to ${names} in Edit first: try again in a moment`;
      } else this.error = `${names} has unsaved edits in Edit: save or discard them there first`;
      cx.notify(); return;
    }
    const entry = { snaps: [], writes: [], feedback }, jobs = [], notes = [];
    for (const [f, action] of plan) {
      // Unsaved edits are saved first: the action's write expects memory and disk to agree.
      const saves = this.saveWrites(f), { state, write } = action(f), writes = [...saves, write];
      notes.push(...saves.map((w) => this.editNote(f, w)).filter(Boolean));
      Object.assign(state, { diskC: f.Ctext, diskB: f.Btext, conflict: null });
      state[write.target === "baseline" ? "diskB" : "diskC"] = write.after;
      entry.snaps.push(bare(f));
      this.files[this.files.indexOf(f)] = state;
      jobs.push([state, writes]);
    }
    this.history.push(entry); this.redo = []; capSteps(this.history);
    this.error = null; this.settle(); this.reveal(); cx.notify();
    this.enqueue(async () => {
      for (const [f, ws] of jobs) for (const w of ws) entry.writes.push(await f.store.apply(f, w));
      for (const m of feedback) await this.noteToClaude(m, () => queueFeedback(m.terminal, m.text, { on: m.on }));
      await this.sendEditNotes(notes);
    }, cx);
  }

  undo(cx) {
    const entry = this.history.pop();
    if (!entry) return;
    if (entry.edit) return this.swapEdit(entry, this.redo, cx);
    this.redo = [];
    for (const snap of entry.snaps) {
      const i = this.files.findIndex((f) => f.key === snap.key);
      if (i >= 0) this.files[i] = snap;
    }
    this.sel = entry.snaps[0].key; this.error = null; this.settle(); this.reveal(); cx.notify();
    this.enqueue(async () => {
      await entry.snaps[0].store.undo(entry.writes);
      for (const m of entry.feedback) await this.noteToClaude(m, () => withdrawFeedback(m.terminal, m.text, { on: m.on }));
    }, cx);
  }

  /**
   * Sends (or withdraws) a note for Claude. On this computer a failure fails the job, as it always
   * did; on another machine it only shows in the status line, since the review's own writes are done.
   */
  async noteToClaude(m, send) {
    if (!m.on) return send();
    try { return await send(); }
    catch (e) { this.status = hookKnown(m.on) === false ? NOTES_NOTE(m.on) : `Note to Claude on ${m.on} not sent: ${e.message ?? e}`; return false; }
  }

  /** Undo or redo of an edit: memory only. What's on disk stays, so the file shows as unsaved. */
  swapEdit(entry, other, cx) {
    const now = this.files.find((x) => x.key === entry.key);
    if (!now) return;
    other.push({ edit: true, key: entry.key, state: bare(now), cur: this.cur, at: 0 }); capSteps(other);
    this.replace(now, { ...entry.state, diskC: now.diskC, diskB: now.diskB, conflict: now.conflict, edited: true });
    this.sel = entry.key; this.cur = entry.cur; this.anchor = null;
    this.settle(); this.showCursor(); this.retokenize(cx); cx.notify();
  }

  redoEdit(cx) {
    const entry = this.redo.pop();
    if (entry) this.swapEdit(entry, this.history, cx);
  }

  enqueue(job, cx) {
    this.writing++;
    // Each job runs in its own spawned task: a handler's cx is dead after the handler
    // returns, so the queue must never hold one across an await.
    const prev = this.queue;
    this.queue = new Promise((done) => cx.spawn(async (cx) => {
      try { await prev; await job(); }
      catch (e) {
        // Disk no longer matches memory: drop undo (it would act on stale state) and reread everything.
        this.error = String(e.message ?? e); this.history = []; this.deferred.add("*");
      } finally {
        this.writing--; done();
        if (!this.writing && this.deferred.size) await this.drain(cx);
        cx.notify();
      }
    }));
  }

  // ---- notes, reasons and prompts -----------------------------------------

  /**
   * The factual note for the agent that made a rejected change (O3: can be turned off).
   * It keeps the agent's picture of the file right; intent is left to the user's own reason.
   */
  rejected(f, what) {
    if (!f.by || !this.settings.autoNote) return [];
    // These notes reach Claude through its hook; on another machine, through the hook installed there.
    const on = f.store?.on ?? null;
    if (on && hookKnown(on) === false) { this.status = NOTES_NOTE(on); return []; }
    return [{ terminal: f.by, text: `Code review: the user rejected ${what} in ${f.as ?? agentPath(f.path, f.by)}. The original lines are back on disk.`, on }];
  }

  /** The agent to ask about a file: the one that made the change, else the space's only agent. */
  target(f) {
    if (f.by && terminals().some((t) => t.address === f.by && t.state === "live")) return f.by;
    const here = agents().filter((a) => a.space === this.spaceId);
    return here.length === 1 ? here[0].address : null;
  }

  where(h) {
    return !h.nc ? `the removal at line ${h.n + 1}` : h.nc === 1 ? `line ${h.n + 1}` : `lines ${h.n + 1}-${h.n + h.nc}`;
  }

  /** O1: a reason for the last rejection, sent along as its own note. */
  askReason(cx) {
    const r = this.lastReject;
    if (!r) { this.error = "Nothing rejected yet to comment on"; cx.notify(); return; }
    if (r.remote) { this.status = REASON_NOTE(r.remote); cx.notify(); return; }
    this.openForm({ form: "reason", terminal: r.terminal, file: r.file, where: r.where, quote: r.quote, on: r.on ?? null });
  }

  /**
   * O2: an instruction typed into the agent's terminal as the user's message: about the
   * selected lines when there is a selection, else about hunk `i`.
   */
  askPrompt(i, cx) {
    const f = this.file();
    if (!f) return;
    const terminal = this.target(f);
    if (!terminal) { this.error = "No agent to send to: none made this change, and the space doesn't have exactly one"; cx.notify(); return; }
    const file = f.as ?? agentPath(f.path, terminal), sel = this.selection(f);
    if (sel) return this.openForm({ form: "prompt", terminal, file, ...this.quote(f, sel) });
    if (!f.hunks[i]) return;
    this.current = i;
    this.openForm({ form: "prompt", terminal, file, where: this.where(f.hunks[i]) });
  }

  // ---- line selection ------------------------------------------------------
  // Whole lines only: Herdr's rows have no text selection, and its Editor doesn't report one.

  /** [first, last] rows of the line selection, or null. Cleared when the rows change. */
  lineSel(f) {
    if (this.selA == null || this.selFor !== this.rowsOf(f)) return null;
    return [Math.min(this.selA, this.selB), Math.max(this.selA, this.selB)];
  }

  /** The rows Comment, Accept and Reject act on: the line selection, else the lines a text
   *  selection covers (a selection ending at the start of a line leaves that line out). */
  selection(f) {
    const ls = this.lineSel(f);
    if (ls || !this.hasTextSel()) return ls;
    this.rowsOf(f);
    const [a, b] = this.ordered();
    const last = b.col === 0 && b.line > a.line ? b.line - 1 : b.line;
    const ra = f._lineRow[a.line], rb = f._lineRow[last];
    return ra == null || rb == null ? null : [ra, rb];
  }

  select(i, extend, cx) {
    const f = this.file();
    if (!f) return;
    const rows = this.rowsOf(f);
    i = Math.max(0, Math.min(i, rows.length - 1));
    if (extend && this.lineSel(f)) this.selB = i;
    else { this.selA = this.selB = i; this.selFor = rows; }
    this.ensureVisible(i);
    cx.notify();
  }

  /** Shift+Up/Down: grow or shrink the selection from its moving end (or start at the current hunk). */
  extend(by, cx) {
    const f = this.file();
    if (!f) return;
    if (!this.lineSel(f)) {
      const at = this.rowsOf(f).findIndex((r) => r.hunk === this.current && r.kind !== "@");
      return this.select(Math.max(0, at), false, cx);
    }
    this.select(this.selB + by, true, cx);
  }

  clearSelection(cx) { this.selA = this.selB = null; this.anchor = null; cx.notify(); }

  /** The changed lines in the selection: baseline indexes of removed lines, current indexes of added. */
  picks(f, sel) {
    const pick = { old: new Set(), new: new Set() }, rows = this.rowsOf(f).slice(sel[0], sel[1] + 1);
    for (const r of rows) { if (r.kind === "-") pick.old.add(r.line); else if (r.kind === "+") pick.new.add(r.line); }
    return { pick, rows, any: pick.old.size + pick.new.size > 0 };
  }

  /**
   * Accept or reject only the selected changed lines. Unselected changes in the same hunks stay
   * pending. Returns false when there is no selection with changes, so callers fall back to the hunk.
   */
  selectionAction(how, cx, withReason = false) {
    const f = this.file(), sel = f && this.selection(f);
    if (!sel) return false;
    const { pick, rows, any } = this.picks(f, sel);
    if (!any) { this.error = "The selection has no changed lines"; cx.notify(); return true; }
    const where = `your change at ${this.quoteRows(f, rows).where}`;
    if (how === "reject") this.noteReject(f, where, rows.filter((r) => r.kind === "+" || r.kind === "-"));
    this.selA = this.selB = null; this.anchor = null;
    this.run([[f, (s) => partialAt(s, how, pick)]], cx, how === "reject" ? this.rejected(f, where) : []);
    if (withReason) this.askReason(cx);
    return true;
  }

  /** Keys and menu: the selected lines when there are any, else the current hunk. */
  decide(how, cx, withReason = false) {
    if (this.selectionAction(how, cx, withReason)) return;
    this.hunk(how, this.current, cx);
    if (withReason && how === "reject") this.askReason(cx);
  }

  /**
   * The selected lines as the agent should read them: where they are (current file's line
   * numbers, with removed lines noted) and the code itself, capped at 40 lines.
   */
  quote(f, [a, b]) { return this.quoteRows(f, this.rowsOf(f).slice(a, b + 1)); }

  quoteRows(f, picked) {
    const rows = picked.filter((r) => r.kind !== "@" && !r.cont);
    const text = (r) => ((r.side === "old" ? f.B : f.C)[r.line] ?? "").replace(/\r?\n$/, "");
    const nums = rows.filter((r) => r.side === "new").map((r) => r.num);
    const removed = rows.filter((r) => r.kind === "-").length;
    const span = nums.length ? (nums[0] === nums[nums.length - 1] ? `line ${nums[0]}` : `lines ${nums[0]}-${nums[nums.length - 1]}`) : `removed lines`;
    const where = removed && nums.length ? `${span} (with ${removed} removed line${removed > 1 ? "s" : ""})` : span;
    const shown = rows.slice(0, 40).map((r) => `${r.kind === " " ? " " : r.kind} ${text(r)}`);
    if (rows.length > 40) shown.push(`… ${rows.length - 40} more lines`);
    return { where, quote: shown.join("\n") };
  }

  openForm(p) {
    openOverlay({ mod: "wingman", props: p, kind: "dialog", width: 560, height: p.quote ? 430 : 290 });
  }

  openSettings() {
    // A space on another machine adds the "Claude hook on <machine>" section.
    const machine = this.machine();
    openOverlay({ mod: "wingman", props: { form: "settings", ...(machine ? { machine } : {}) }, kind: "dialog", width: 460, height: 690 + (machine ? 150 : 0) });
  }

  /** Every 250 ms (Q46). Herdr has no blur event, so focus is polled: the pane losing the
   *  keyboard, or the window losing focus, saves every file with unsaved edits. With a delay
   *  set, a pause in typing that long saves too. */
  autosave(cx) {
    if (!this.handle || !this.settings.autosave) return;
    let active = true;
    try { active = window.is_window_active(); } catch {}
    const focused = (this.handle.is_focused() || !!this.inBar) && active, lost = this.wasFocused && !focused;
    this.wasFocused = focused;
    const delay = this.settings.autosaveDelay, idle = delay > 0 && this.typedAt && Date.now() - this.typedAt >= delay * 1000;
    if (lost || idle) this.saveAll(cx);
  }

  saveAll(cx) {
    for (const f of this.files) if (this.dirty(f) && !f.conflict) this.save(cx, f);
  }


  hunk(how, i, cx) {
    const f = this.file();
    if (!f || !f.hunks[i]) return;
    this.current = i;
    const where = `your change at ${this.where(f.hunks[i])}`;
    // The hunk's own lines, captured before it goes, for the reason popup's preview.
    if (how === "reject") this.noteReject(f, where, this.rowsOf(f).filter((r) => r.hunk === i));
    this.run([[f, (s) => (how === "accept" ? acceptAt(s, i) : rejectAt(s, i))]], cx, how === "reject" ? this.rejected(f, where) : []);
  }

  /** Remembers the rejection a reason (ctrl-r) would explain. */
  noteReject(f, where, rows) {
    // A comment on a rejection goes through the Claude hook: on another machine, the one installed there.
    const on = f.store?.on ?? null;
    if (on && hookKnown(on) === false) { this.lastReject = { remote: on }; return; }
    const terminal = this.target(f);
    this.lastReject = terminal ? { terminal, file: f.as ?? agentPath(f.path, terminal), where, quote: this.quoteRows(f, rows).quote, on } : null;
  }

  wholeFile(how, cx) {
    const f = this.file();
    if (!f?.hunks.length) return;
    if (how === "reject") this.noteReject(f, "all your changes", this.rowsOf(f).filter((r) => r.kind === "+" || r.kind === "-"));
    this.run([[f, how === "accept" ? acceptAll : rejectAll]], cx, how === "reject" ? this.rejected(f, "all your changes") : []);
  }

  everything(how, cx) {
    const files = this.files.filter((f) => !f.error && f.hunks.length);
    if (how === "reject") this.lastReject = null; // one reason can't name several files
    this.run(files.map((f) => [f, how === "accept" ? acceptAll : rejectAll]), cx,
      how === "reject" ? files.flatMap((f) => this.rejected(f, "all your changes")) : []);
  }

  // ---- editing (Q40-Q43) ------------------------------------------------------
  // The diff rows are the editor: the cursor sits in the current file (context and added
  // lines), removed lines are read-only. Edits change memory at once; ctrl-s writes them.

  editable(f) { return !!f && !f.error && f.Ctext !== null; }

  /** Panel split: the Review copy keeps no unsaved text. */
  readOnly(cx) {
    this.error = `${this.mode === "changes" ? "Changes" : "Review"} is read-only: double-click a line to edit it in Edit`; cx.notify();
  }

  cw() { return this.charW ?? 7.2; }
  hasTextSel() { return !!(this.anchor && this.cur && cmp(this.anchor, this.cur)); }
  ordered() { return cmp(this.anchor, this.cur) <= 0 ? [this.anchor, this.cur] : [this.cur, this.anchor]; }

  clampPos(f, p) {
    const lines = linesOf(f), line = Math.max(0, Math.min(p.line, lines.length - 1));
    return { line, col: Math.max(0, Math.min(p.col, body(lines[line]).length)) };
  }

  /** The position under x on row `r` (a line of the current file). */
  posAt(f, r, x) {
    const text = body(linesOf(f)[r.line]), seg = r.seg;
    if (!seg) return { line: r.line, col: charAt(text, (x - GUTTER + this.hx) / this.cw()) };
    // A wrapped segment: its own columns; past its end stays on it (the last segment takes the line end).
    const v = (x - GUTTER) / this.cw() - seg.ind + visualCol(text, seg.from);
    return { line: r.line, col: Math.max(seg.from, Math.min(charAt(text, Math.max(0, v)), seg.to === text.length ? seg.to : seg.to - 1)) };
  }

  textDown(f, r, x, y, ev, cx) {
    if (r.hunk != null) this.current = r.hunk;
    // Editor "nvim": a click opens Neovim at that line; Wingman stays the review.
    if (this.nvim()) return this.toNvim(f, r.side === "new" ? r.line : r.hunk != null ? f.hunks[r.hunk].n : 0, cx);
    if (r.side !== "new") { cx.notify(); return; } // removed lines are read-only
    const p = this.posAt(f, r, x), lines = linesOf(f);
    this.selA = this.selB = null; this.goalX = null;
    if (ev.click_count === 2 && (this.view === "review" || this.mode === "changes")) return this.handOff("edit", cx, p);
    if (ev.click_count === 2) { [this.anchor, this.cur] = wordAt(lines, p); cx.notify(); return; }
    if (ev.click_count >= 3) {
      this.anchor = { line: p.line, col: 0 };
      this.cur = p.line + 1 < lines.length ? { line: p.line + 1, col: 0 } : { line: p.line, col: body(lines[p.line]).length };
      cx.notify(); return;
    }
    if (ev.modifiers?.shift && this.cur) this.anchor ??= this.cur; else this.anchor = p;
    this.cur = p;
    this.dragging = true; this.tdrag = true; this.dragY = y; this.dragX = x;
    cx.notify();
  }

  /** Keeps the cursor on screen: its row, and its column when lines are long. */
  showCursor() {
    const f = this.file();
    if (!f || !this.cur) return;
    const row = this.rowOfPos(f, this.cur);
    if (row != null) this.ensureVisible(row);
    if (this.wrapCols()) { this.hx = 0; return; }
    const x = visualCol(body(linesOf(f)[this.cur.line]), this.cur.col) * this.cw();
    const view = Math.max(60, (this.viewW ?? 600) - GUTTER - 40);
    if (x < this.hx) this.hx = Math.max(0, x - 60);
    else if (x > this.hx + view) this.hx = x - view + 60;
  }

  move(to, extend, cx) {
    const f = this.file();
    if (!f || !this.cur) return;
    if (extend) this.anchor ??= this.cur; else this.anchor = null;
    this.cur = this.clampPos(f, to); this.selA = this.selB = null; this.goalX = null;
    this.showCursor(); cx.notify();
  }

  /** Up/Down and PageUp/PageDown keep the column the cursor started from. */
  vertical(by, extend, cx) {
    const f = this.file(), lines = linesOf(f);
    if (this.wrapCols()) return this.verticalWrapped(f, lines, by, extend, cx);
    const goal = this.goalX ?? visualCol(body(lines[this.cur.line]), this.cur.col);
    const line = Math.max(0, Math.min(lines.length - 1, this.cur.line + by));
    this.move({ line, col: charAt(body(lines[line]), goal) }, extend, cx);
    this.goalX = goal;
  }

  /** E5: Up/Down move by screen row through wrapped lines, keeping the screen column. */
  verticalWrapped(f, lines, by, extend, cx) {
    const rows = this.rowsOf(f), i = this.rowOfPos(f, this.cur);
    if (i == null) return;
    const shown = (r, text) => (r.seg ? visualCol(text, r.seg.from) - r.seg.ind : 0); // display column at the row's left edge
    const goal = this.goalX ?? visualCol(body(lines[this.cur.line]), this.cur.col) - shown(rows[i], body(lines[this.cur.line]));
    let j = i;
    for (let n = Math.abs(by), d = Math.sign(by); n > 0; n--) {
      let k = j + d;
      while (k >= 0 && k < rows.length && rows[k].side !== "new") k += d;
      if (k < 0 || k >= rows.length) break;
      j = k;
    }
    const r = rows[j], text = body(lines[r.line]);
    let col = charAt(text, Math.max(0, goal + shown(r, text)));
    if (r.seg) col = Math.max(r.seg.from, Math.min(col, r.seg.to === text.length ? r.seg.to : r.seg.to - 1));
    this.move({ line: r.line, col }, extend, cx);
    this.goalX = goal;
  }

  /**
   * Replaces the text from `from` to `to` (default: the selection, else the cursor) with `text`.
   * Quick typing (`group`) is one undo step; anything else is its own.
   */
  type(text, cx, { from, to, group = false, select = false } = {}) {
    const f = this.file();
    if (!this.editable(f) || !this.cur) return;
    if (this.view === "review" || this.mode === "changes") return this.readOnly(cx);
    const sel = this.hasTextSel(), a = from ?? (sel ? this.anchor : this.cur), b = to ?? this.cur;
    const lang = languageOf(f.rel);
    const { state, cursor } = edit(f, a, b, text, (ls) => highlightLines(ls, lang));
    const last = this.history[this.history.length - 1], now = Date.now();
    if (group && last?.edit && last.group && last.key === f.key && now - last.at < 1000) last.at = now;
    else { this.history.push({ edit: true, key: f.key, state: bare(f), cur: this.cur, at: now, group }); capSteps(this.history); }
    this.redo = [];
    state.edited = true;
    this.replace(f, state);
    const start = cmp(a, b) <= 0 ? a : b;
    this.anchor = select ? start : null; this.cur = cursor;
    this.selA = this.selB = null; this.goalX = null; this.error = null;
    this.settle(); this.showCursor(); this.retokenize(cx); cx.notify();
  }

  /** Rewrites whole lines l1..l2 (indent, outdent) and keeps them selected. */
  editLines(l1, l2, fn, cx) {
    const f = this.file(), lines = linesOf(f);
    const text = lines.slice(l1, l2 + 1).map((l) => fn(body(l))).join("\n");
    this.type(text, cx, { from: { line: l1, col: 0 }, to: { line: l2, col: body(lines[l2]).length }, select: l2 > l1 });
  }

  /** Lines typed are highlighted one by one; the whole file again once typing pauses. */
  retokenize(cx) {
    const at = (this.typedAt = Date.now());
    cx.timer.after(500, (cx) => {
      const f = this.file();
      if (this.typedAt !== at || !f) return;
      cx.spawn(async (cx) => {
        const newTok = await this.tok(f.Ctext ?? "", f.rel, cx), oldTok = await this.tok(f.Btext, f.rel, cx);
        const g = this.files.find((x) => x.key === f.key);
        if (g && g.Ctext === f.Ctext && g.Btext === f.Btext) { g.newTok = newTok; g.oldTok = oldTok; cx.notify(); }
      });
    });
  }

  /** The text to copy: the text selection, else the selected lines, else the cursor's line. */
  copyText(f) {
    const lines = linesOf(f);
    if (this.hasTextSel()) return textBetween(lines, this.anchor, this.cur);
    const ls = this.lineSel(f);
    if (ls) return this.rowsOf(f).slice(ls[0], ls[1] + 1).filter((r) => r.kind !== "@" && !r.cont)
      .map((r) => body((r.side === "old" ? f.B : f.C)[r.line]) + "\n").join("");
    return this.cur ? body(lines[this.cur.line]) + "\n" : "";
  }

  /** Editing keys while the cursor is in the file. False lets the review keys have it. */
  editKey(e, f, cx) {
    const m = e.modifiers, ctrl = m.control || m.platform, shift = m.shift, lines = linesOf(f), c = this.cur;
    const sel = this.hasTextSel(), [sa, sb] = sel ? this.ordered() : [c, c];
    const lineEnd = (l) => ({ line: l, col: body(lines[l]).length });
    if (m.alt && !ctrl) return false;
    switch (e.key) {
      case "left":
        if (sel && !shift) return this.move(sa, false, cx), true;
        return this.move(ctrl ? wordMove(lines, c, -1) : c.col > 0 ? { line: c.line, col: c.col - 1 } : c.line > 0 ? lineEnd(c.line - 1) : c, shift, cx), true;
      case "right":
        if (sel && !shift) return this.move(sb, false, cx), true;
        return this.move(ctrl ? wordMove(lines, c, 1) : c.col < body(lines[c.line]).length ? { line: c.line, col: c.col + 1 } : c.line + 1 < lines.length ? { line: c.line + 1, col: 0 } : c, shift, cx), true;
      case "up": case "down":
        if (ctrl || (shift && this.lineSel(f))) return false; // ctrl-up/down: changes, ctrl-shift-up/down: files; Shift grows a line selection
        return this.vertical(e.key === "up" ? -1 : 1, shift, cx), true;
      case "pageup": case "pagedown":
        return this.vertical((e.key === "pageup" ? -1 : 1) * this.viewRows(), shift, cx), true;
      case "home": {
        if (ctrl) return this.move({ line: 0, col: 0 }, shift, cx), true;
        const ind = /^\s*/.exec(body(lines[c.line]))[0].length; // first press: after the indent
        return this.move({ line: c.line, col: c.col === ind ? 0 : ind }, shift, cx), true;
      }
      case "end":
        return this.move(ctrl ? lineEnd(lines.length - 1) : lineEnd(c.line), shift, cx), true;
      case "backspace":
        if (ctrl && shift) return false; // reject file
        if (sel) return this.type("", cx), true;
        if (c.line === 0 && c.col === 0) return true;
        if (!ctrl && this.settings.autoPairs && inEmptyPair(body(lines[c.line]), c.col))
          return this.type("", cx, { from: { line: c.line, col: c.col - 1 }, to: { line: c.line, col: c.col + 1 }, group: true }), true;
        return this.type("", cx, { from: ctrl ? wordMove(lines, c, -1) : c.col > 0 ? { line: c.line, col: c.col - 1 } : lineEnd(c.line - 1), to: c, group: !ctrl }), true;
      case "delete": {
        if (sel) return this.type("", cx), true;
        const end = c.col < body(lines[c.line]).length ? { line: c.line, col: c.col + 1 } : c.line + 1 < lines.length ? { line: c.line + 1, col: 0 } : c;
        return this.type("", cx, { from: c, to: ctrl ? wordMove(lines, c, 1) : end, group: !ctrl }), true;
      }
      case "enter": {
        if (ctrl || shift) return false; // ctrl-shift-enter: accept file
        const indent = /^\s*/.exec(body(lines[sa.line]).slice(0, sa.col))[0];
        // Between brackets, "{|}": the closer goes to its own line and the cursor to an indented one.
        const opens = (this.settings.autoPairs && betweenBrackets(body(lines[c.line]), c.col))
          || (this.settings.autoTags && tagKind(f.rel) && betweenTags(body(lines[c.line]), c.col));
        if (!sel && opens) {
          const inner = indent + indentUnit(lines);
          this.type("\n" + inner + "\n" + indent, cx);
          this.cur = { line: c.line + 1, col: inner.length }; this.showCursor(); cx.notify();
          return true;
        }
        return this.type("\n" + indent, cx), true;
      }
      case "tab": {
        if (ctrl) return false;
        const unit = indentUnit(lines);
        if (shift) return this.editLines(sa.line, sb.line, (t) => t.replace(unit === "\t" ? /^\t/ : new RegExp(`^ {1,${unit.length}}`), ""), cx), true;
        if (sel && sa.line !== sb.line) return this.editLines(sa.line, sb.line, (t) => (t ? unit + t : t), cx), true;
        return this.type(unit, cx, { group: true }), true;
      }
      case "escape":
        if (!sel) return false;
        this.anchor = null; cx.notify(); return true;
    }
    if (ctrl && !m.alt) return false; // ctrl keys are actions (keymap.js)
    // Typed characters; Ctrl+Alt is AltGr on Windows keyboards.
    if (e.key_char && !m.platform && (!m.control || m.alt) && !/[\r\n]/.test(e.key_char)) {
      if (!sel && this.settings.autoTags && this.autoTag(e.key_char, f, lines, cx)) return true;
      if (this.settings.autoPairs && this.autoPair(e.key_char, lines, sel, sa, sb, cx)) return true;
      this.type(e.key_char, cx, { group: true });
      return true;
    }
    return false;
  }

  /** E3: a line operation on the lines the cursor or selection covers, as one undo step. */
  lineOp(name, cx) {
    const f = this.file();
    if (!this.editable(f) || !this.cur) return;
    const lines = linesOf(f), anchor = this.hasTextSel() ? this.anchor : null, cur = this.cur;
    const [l1, l2] = lineSpan(anchor, cur);
    const op = {
      moveUp: () => moveLines(lines, l1, l2, -1, anchor, cur),
      moveDown: () => moveLines(lines, l1, l2, 1, anchor, cur),
      copyUp: () => copyLines(lines, l1, l2, -1, anchor, cur),
      copyDown: () => copyLines(lines, l1, l2, 1, anchor, cur),
      delete: () => deleteLines(lines, l1, l2, cur),
      join: () => joinLines(lines, l1, l2),
      comment: () => toggleComment(lines, l1, l2, commentFor(f.rel), anchor, cur),
    }[name]?.();
    if (!op) { if (name === "comment" && !commentFor(f.rel)) { this.error = `No comment syntax known for ${base(f.rel)}`; cx.notify(); } return; }
    this.type(op.text, cx, { from: op.from, to: op.to });
    const g = this.file();
    this.anchor = op.anchor && this.clampPos(g, op.anchor); this.cur = this.clampPos(g, op.cur);
    this.showCursor(); cx.notify();
  }

  /**
   * E2: a typed bracket or quote. With text selected it wraps the selection (kept selected);
   * otherwise it may step over the same closer or type the pair with the cursor between.
   * True when handled.
   */
  autoPair(ch, lines, sel, sa, sb, cx) {
    const close = PAIRS[ch];
    if (sel) {
      if (!close) return false;
      const inner = textBetween(lines, sa, sb);
      this.type(ch + inner + close, cx);
      this.anchor = { line: sa.line, col: sa.col + 1 };
      this.cur = sa.line === sb.line ? { line: sa.line, col: sb.col + 1 } : { line: sb.line, col: sb.col };
      this.showCursor(); cx.notify();
      return true;
    }
    const c = this.cur, d = typed(ch, body(lines[c.line]), c.col);
    if (d?.skip) return this.move({ line: c.line, col: c.col + 1 }, false, cx), true;
    if (!d?.insert) return false;
    this.type(d.insert, cx, { group: true });
    this.cur = { line: this.cur.line, col: this.cur.col - 1 }; this.showCursor(); cx.notify();
    return true;
  }

  /**
   * E4: in a file with tags, ">" ending an opening tag adds its closing tag after the cursor, and
   * "/" right after "<" completes the innermost open tag. True when handled.
   */
  autoTag(ch, f, lines, cx) {
    const kind = (ch === ">" || ch === "/") && tagKind(f.rel);
    if (!kind) return false;
    const c = this.cur, lo = Math.max(0, c.line - 50);
    const ls = lines.slice(lo, c.line + 1).map(body), at = c.line - lo;
    if (ch === ">") {
      const close = closingTag(ls, at, c.col, kind);
      if (!close) return false;
      this.type(">" + close, cx, { group: true });
      this.cur = { line: this.cur.line, col: this.cur.col - close.length }; this.showCursor(); cx.notify();
      return true;
    }
    const rest = completeClose(ls, at, c.col, kind);
    if (!rest) return false;
    this.type("/" + rest, cx, { group: true });
    return true;
  }

  // ---- find, replace, go to line (E6) ----------------------------------------

  initFind() {
    this.bar = null; // null, or { mode: "find" | "replace" | "line" }
    this.findOpts = { cased: false, word: false, regex: false };
    this.findInput = InputState.new({ placeholder: "Find" });
    this.replaceInput = InputState.new({ placeholder: "Replace" });
    this.lineInput = InputState.new({ placeholder: "Line, or line:column" });
    this.quickInput = InputState.new({ placeholder: "Search files by name (add :line to go to a line, or start with : for this file)" });
    // Add repo… for a space on another machine: a path there (the folder picker is this computer's).
    this.pathInput = InputState.new({ placeholder: "A folder on that machine, e.g. /home/me/repo" });
    this.pathInput.on("submit", (_e, cx) => this.addPath(cx));
    this.qo = null; this.recent = []; // Quick Open: null, or { sel, items }; recent: file keys, newest first
    this.initSearch();
    this.quickInput.on("change", (_e, cx) => { this.rankQuick(); cx.notify(); });
    this.quickInput.on("submit", (_e, cx) => this.chooseQuick(this.qo?.sel ?? 0, cx));
    for (const i of [this.findInput, this.replaceInput, this.lineInput, this.quickInput, this.pathInput]) {
      i.on("focus", () => { this.inBar = i; this.searchFocus = false; this.treeFocus = false; });
      i.on("blur", () => { if (this.inBar === i) this.inBar = null; });
    }
    // The tree's name box for New File…, New Folder… and Rename…: Enter does it, Esc cancels.
    this.treeInput = InputState.new({ placeholder: "" });
    this.treeInput.on("submit", (_e, cx) => this.commitTreeEdit(cx));
    this.treeInput.on("change", (_e, cx) => { if (this.treeEdit?.error) { this.treeEdit.error = null; cx.notify(); } });
    this.treeInput.on("focus", () => { this.inBar = this.treeInput; this.searchFocus = false; });
    this.treeInput.on("blur", () => { if (this.inBar === this.treeInput) this.inBar = null; });
    // Typing a query jumps to the first match from where the search started (VS Code's incremental find).
    this.findInput.on("change", (_e, cx) => { this.findFrom ??= this.cur; this.findStep(0, cx); });
    this.findInput.on("submit", (e, cx) => this.findStep(e?.shift ? -1 : 1, cx));
    this.replaceInput.on("submit", (e, cx) => (e?.secondary ? this.replaceAll(cx) : this.replaceOne(cx)));
    this.lineInput.on("submit", (_e, cx) => this.goToLine(cx));
  }

  openFind(mode, cx) {
    const f = this.file();
    if (!f) return;
    this.bar = { mode };
    if (mode === "line") { this.lineInput.set_value(""); this.lineInput.focus(); cx.notify(); return; }
    // A selection on one line becomes the query.
    if (this.hasTextSel()) {
      const [a, b] = this.ordered();
      if (a.line === b.line) this.findInput.set_value(textBetween(linesOf(f), a, b));
    }
    this.findFrom = null;
    (mode === "replace" && this.findInput.value() ? this.replaceInput : this.findInput).focus();
    cx.notify();
  }

  closeFind(cx) { this.bar = null; this.inBar = null; this.handle.focus(); cx.notify(); }

  findFlag(k, cx) { this.findOpts = { ...this.findOpts, [k]: !this.findOpts[k] }; this.findStep(0, cx); }

  /** The current file's matches, cached until the text, query or options change. */
  matches(f) {
    if (!this.bar || this.bar.mode === "line" || !f || f.Ctext === null) return { ms: [] };
    const q = this.findInput.value(), o = this.findOpts, key = `${q}\0${o.cased}${o.word}${o.regex}`;
    if (f._findC === f.C && f._findKey === key) return f._find;
    const c = compile(q, o), ms = c?.re ? findAll(linesOf(f).map(body), c.re) : [];
    const byLine = new Map();
    ms.forEach((m, i) => { if (!byLine.has(m.line)) byLine.set(m.line, []); byLine.get(m.line).push(i); });
    f._find = { ms, byLine, re: c?.re ?? null, error: c?.error ?? null }; f._findC = f.C; f._findKey = key;
    return f._find;
  }

  /** The match the text selection is exactly on, or -1. */
  onMatch(ms) {
    if (!this.hasTextSel()) return -1;
    const [a, b] = this.ordered();
    return ms.findIndex((m) => m.line === a.line && m.from === a.col && b.line === a.line && m.to === b.col);
  }

  /** Selects the next (1) or previous (-1) match, or for 0 the first one from where typing started. */
  findStep(dir, cx) {
    const f = this.file(), { ms } = this.matches(f);
    if (this.bar) this.bar.note = null;
    if (!f || !ms.length) { cx.notify(); return; }
    const p = this.hasTextSel() ? this.ordered()[0] : this.cur ?? { line: 0, col: 0 };
    const i = dir === 0 ? nextMatch(ms, this.findFrom ?? { line: 0, col: 0 }, true) : dir > 0 ? nextMatch(ms, p) : prevMatch(ms, p);
    const m = ms[i];
    this.anchor = { line: m.line, col: m.from }; this.cur = { line: m.line, col: m.to };
    this.showCursor(); cx.notify();
  }

  replaceOne(cx) {
    const f = this.file(), { ms, re } = this.matches(f);
    if (!this.editable(f) || !re) return;
    const i = this.onMatch(ms);
    if (i < 0) return this.findStep(1, cx);
    const m = ms[i], text = body(linesOf(f)[m.line]).slice(m.from, m.to);
    this.type(replacement(text, re, this.replaceInput.value(), this.findOpts.regex), cx, { from: { line: m.line, col: m.from }, to: { line: m.line, col: m.to } });
    this.findStep(1, cx);
  }

  /** Every match, last to first so earlier positions stay right, as one undo step. */
  replaceAll(cx) {
    const f = this.file(), { ms, re } = this.matches(f);
    if (!this.editable(f) || !re || !ms.length) return;
    if (this.view === "review" || this.mode === "changes") return this.readOnly(cx);
    const lines = linesOf(f), repl = this.replaceInput.value(), regex = this.findOpts.regex;
    const subs = ms.map((m) => replacement(body(lines[m.line]).slice(m.from, m.to), re, repl, regex));
    this.cur ??= { line: 0, col: 0 };
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      this.type(subs[i], cx, { from: { line: m.line, col: m.from }, to: { line: m.line, col: m.to }, group: true });
    }
    this.history[this.history.length - 1].at = 0; // later typing starts its own undo step
    if (this.bar) this.bar.note = `Replaced ${ms.length}`;
    cx.notify();
  }

  goToLine(cx) {
    const f = this.file(), p = parseLine(this.lineInput.value());
    if (!f || !p) return;
    this.cur = this.clampPos(f, p); this.anchor = null;
    this.closeFind(cx); this.showCursor(); cx.notify();
  }

  findBar(f, t) {
    const mode = this.bar.mode, chip = (id, label, on, flip) => div().id(id).h(22).px(6).flex().items_center().rounded(4).text_size(11).cursor_pointer()
      .bg(on ? t.accent + "77" : t.raised).hover((s) => s.opacity(0.85)).on_click((_e, cx) => flip(cx)).child(label);
    const box = (state, w) => div().w(w).flex_none().child(Input.new(state));
    if (mode === "line") return h_flex().px(8).py(4).gap(6).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(div().text_color(t.muted).child("Go to line")).child(box(this.lineInput, 180))
      .child(div().text_size(11).text_color(t.dim).child(`1-${linesOf(f).length} · Enter · Esc`))
      .child(div().flex_1()).child(this.button("find-close", "×", t.raised, (cx) => this.closeFind(cx)));
    const { ms, error } = this.matches(f), i = this.onMatch(ms), q = this.findInput.value();
    const count = error ? "Bad pattern" : this.bar.note ?? (!q ? "" : !ms.length ? "No results" : i >= 0 ? `${i + 1} of ${ms.length}` : `${ms.length} result${ms.length === 1 ? "" : "s"}`);
    return v_flex().px(8).py(4).gap(4).border_b(1).border_color(t.border).text_size(12)
      .child(h_flex().gap(6).items_center()
        .child(box(this.findInput, 240))
        .child(chip("find-cased", "Aa", this.findOpts.cased, (cx) => this.findFlag("cased", cx)))
        .child(chip("find-word", "W", this.findOpts.word, (cx) => this.findFlag("word", cx)))
        .child(chip("find-regex", ".*", this.findOpts.regex, (cx) => this.findFlag("regex", cx)))
        .child(div().min_w(70).text_size(11).text_color(error || (q && !ms.length) ? t.ansi1 : t.muted).child(count))
        .child(this.button("find-prev", "↑", t.raised, (cx) => this.findStep(-1, cx)))
        .child(this.button("find-next", "↓", t.raised, (cx) => this.findStep(1, cx)))
        .child(div().flex_1())
        .child(this.button("find-mode", mode === "replace" ? "Hide replace" : `Replace  ${this.kl("replace")}`, t.raised, (cx) => { this.bar = { mode: mode === "replace" ? "find" : "replace" }; cx.notify(); }))
        .child(this.button("find-close", "×", t.raised, (cx) => this.closeFind(cx))))
      .when(mode === "replace", (e) => e.child(h_flex().gap(6).items_center()
        .child(box(this.replaceInput, 240))
        .child(this.button("replace-one", "Replace", t.raised, (cx) => this.replaceOne(cx)))
        .child(this.button("replace-all", `All  ${this.kl("replaceAll")}`, t.raised, (cx) => this.replaceAll(cx)))
        .when(this.findOpts.regex, (e) => e.child(div().text_size(11).text_color(t.dim).child("$1, $2… insert groups")))));
  }

  // ---- Search view (ctrl-shift-f) ----------------------------------------------
  // The Edit tab's left column has two modes, Explorer (the tree) and Search: git grep over every
  // repo of the space (search.js), results grouped by file, and Replace All. Its state is per space
  // (this.search, kept by snapshotView); the boxes are this copy's, refilled on a space switch.

  initSearch() {
    this.searchInput = InputState.new({ placeholder: "Search" });
    this.sReplaceInput = InputState.new({ placeholder: "Replace" });
    this.includeInput = InputState.new({ placeholder: "e.g. src/**, *.ts" });
    this.excludeInput = InputState.new({ placeholder: "e.g. dist, *.min.js" });
    this.searchInputs = [this.searchInput, this.sReplaceInput, this.includeInput, this.excludeInput];
    const fields = [["query", this.searchInput], ["replace", this.sReplaceInput], ["include", this.includeInput], ["exclude", this.excludeInput]];
    for (const [k, i] of fields) {
      i.on("focus", () => { this.inBar = i; this.searchFocus = false; this.treeFocus = false; });
      i.on("blur", () => { if (this.inBar === i) this.inBar = null; });
      i.on("change", (_e, cx) => {
        const s = this.search, v = i.value();
        if (v === s[k]) return; // refilled on a space switch, or nothing changed
        s[k] = v; s.confirm = false; s.note = null;
        if (k === "replace") cx.notify(); else this.scheduleSearch(cx);
      });
    }
    for (const i of [this.searchInput, this.includeInput, this.excludeInput]) i.on("submit", (_e, cx) => this.runSearch(cx));
    this.sReplaceInput.on("submit", (e, cx) => { if (e?.secondary) this.askReplaceAll(cx); });
  }

  /** The boxes show the active space's search. */
  syncSearchInputs() {
    const s = this.search;
    if (!this.searchInput || !s) return;
    for (const [k, i] of [["query", this.searchInput], ["replace", this.sReplaceInput], ["include", this.includeInput], ["exclude", this.excludeInput]])
      if (i.value() !== s[k]) i.set_value(s[k]);
  }

  /** Whether the Search column is on screen. */
  searchShown() { return this.mode === "edit" && (this.treeOn || this.treeOnly()) && this.search?.left === "search"; }

  /** ctrl-shift-f: the Edit tab's Search, its box taking a one-line selection as the query. Other panel copies hand off. */
  openSearch(cx) {
    const f = this.file();
    let q = null;
    if (f && this.hasTextSel()) {
      const [a, b] = this.ordered();
      if (a.line === b.line) q = textBetween(linesOf(f), a, b);
    }
    if (this.view && this.view !== "edit") return this.handOff("edit", cx, null, null, { search: { query: q } });
    if (this.mode !== "edit") this.setMode("edit", cx);
    this.showSearch(q, cx);
  }

  showSearch(q, cx) {
    const s = this.search;
    s.left = "search"; this.treeOn = true; this.searchFocus = false;
    if (q) { s.query = q; s.note = null; this.searchInput.set_value(q); }
    this.searchInput.focus();
    if (q || (s.query && !s.results && !s.running)) this.runSearch(cx);
    cx.notify();
  }

  /** The left column's switch: "explorer" or "search". */
  setLeft(which, cx) {
    this.search.left = which; this.searchFocus = false;
    if (which === "search") this.searchInput.focus();
    else { this.handle.focus(); this.refreshTrees(cx); }
    cx.notify();
  }

  /** Typing searches 300 ms after the last key, from 2 characters; an empty box clears the results. */
  scheduleSearch(cx) {
    const s = this.search;
    if (!s.query) { s.seq++; s.results = null; s.running = false; s.sel = null; cx.notify(); return; }
    cx.notify();
    if (s.query.length < 2) return;
    const tick = (s.tick = (s.tick ?? 0) + 1);
    cx.timer.after(300, (cx) => { if (s.tick === tick && this.search === s) this.runSearch(cx); });
  }

  searchFlag(k, cx) {
    const s = this.search;
    s.opts = { ...s.opts, [k]: !s.opts[k] }; s.confirm = false; s.note = null;
    if (s.query) this.runSearch(cx); else cx.notify();
  }

  /** Searches every repo of the space, one after another; a newer search drops this one's results. */
  runSearch(cx) {
    const s = this.search, q = s.query, seq = ++s.seq;
    s.confirm = false;
    if (!q) { s.results = null; s.running = false; cx.notify(); return; }
    const opts = { query: q, ...s.opts, include: s.include, exclude: s.exclude }, repos = this.repos();
    try { grepArgs(opts); } catch (e) { s.results = { opts, files: [], total: 0, truncated: false, error: e.message }; s.running = false; cx.notify(); return; }
    if (!repos.length) { s.results = null; s.running = false; cx.notify(); return; }
    s.running = true; cx.notify();
    cx.spawn(async (cx) => {
      const files = [], errors = [];
      let total = 0, truncated = false;
      for (const st of repos) {
        if (total >= MAX_RESULTS) { truncated = true; break; }
        const r = await searchRepo(git, st.root, opts, { on: st.on ?? null, max: MAX_RESULTS - total });
        if (s.seq !== seq) return;
        if (r.error) { errors.push(repos.length > 1 ? `${this.repoName(st)}: ${r.error}` : r.error); continue; }
        for (const f of r.files) files.push({ key: `${st.root}|${f.rel}`, id: idOf(st), st, rel: f.rel, matches: f.matches });
        total += r.total; truncated ||= r.truncated;
      }
      s.results = { opts, files, total, truncated, error: errors[0] ?? null };
      s.running = false; s.collapsed = new Set(); s.shutVer++;
      cx.notify();
    });
  }

  /** The result rows, rebuilt when the results or the collapsed files change. */
  searchRows() {
    const s = this.search, r = s?.results;
    if (!r) return [];
    if (s._rowsFor !== r || s._rowsVer !== s.shutVer) { s._rows = resultRows(r.files, s.collapsed); s._rowsFor = r; s._rowsVer = s.shutVer; }
    return s._rows;
  }

  toggleResultFile(key, open, cx) {
    const s = this.search, shut = s.collapsed.has(key);
    if (open === !shut) return;
    if (shut) s.collapsed.delete(key); else s.collapsed.add(key);
    s.shutVer++; cx.notify();
  }

  /** Up/Down in the results; Up from the first row goes back to the search box. */
  moveResult(by, cx) {
    const s = this.search, rows = this.searchRows();
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.key === s.sel);
    i = i < 0 ? (by > 0 ? 0 : rows.length - 1) : i + by;
    if (i < 0) { this.searchFocus = false; this.searchInput.focus(); cx.notify(); return; }
    i = Math.min(i, rows.length - 1);
    s.sel = rows[i].key; this.searchScroll.scroll_to_item(i); cx.notify();
  }

  /** Left: to a match's file, then collapses it. Right: expands a file. */
  foldResult(open, cx) {
    const s = this.search, rows = this.searchRows(), row = rows.find((r) => r.key === s.sel);
    if (!row) return;
    if (row.kind === "match" && !open) {
      s.sel = `f|${row.file.key}`;
      const i = rows.findIndex((r) => r.key === s.sel);
      if (i >= 0) this.searchScroll.scroll_to_item(i);
      cx.notify(); return;
    }
    if (row.kind === "file") this.toggleResultFile(row.file.key, open, cx);
  }

  /** Enter in the results: a file row folds, a match opens and the editor takes the keyboard. */
  enterResult(cx) {
    const s = this.search, row = this.searchRows().find((r) => r.key === s.sel);
    if (!row) return;
    if (row.kind === "file") this.toggleResultFile(row.file.key, s.collapsed.has(row.file.key), cx);
    else this.openResult(row, cx, true);
  }

  /** A click: a file row folds, a match opens; the results keep the keyboard (Up/Down, Enter). */
  clickResult(key, cx) {
    const s = this.search, row = this.searchRows().find((r) => r.key === key);
    if (!row) return;
    s.sel = key;
    if (row.kind === "match") return this.openResult(row, cx, false);
    this.toggleResultFile(row.file.key, s.collapsed.has(row.file.key), cx);
    this.handle.focus(); this.searchFocus = true; cx.notify();
  }

  /** Opens a match's file at its line, as Quick Open's name:line:col does, with the match selected. */
  openResult(row, cx, toEditor) {
    const { file: rf, m } = row, st = this.stores.find((x) => idOf(x) === rf.id) ?? rf.st;
    const at = { line: m.line - 1, col: m.col }, key = `${st.root}|${rf.rel}`;
    cx.spawn(async (cx) => {
      await this.openFile(st, rf.rel, cx, at);
      const f = this.file();
      if (f && f.key === key && !this.treeOnly()) {
        // A long line's result text is a cut of it: find where the cut starts.
        const text = body(linesOf(f)[at.line] ?? ""), shift = Math.max(0, text.indexOf(m.text)), [a, b] = m.ranges[0] ?? [m.col, m.col];
        this.anchor = this.clampPos(f, { line: at.line, col: shift + a }); this.cur = this.clampPos(f, { line: at.line, col: shift + b });
        this.goalX = null; this.selA = this.selB = null; this.showCursor();
      }
      this.searchFocus = !toEditor;
      cx.notify();
    });
  }

  /** Keys while a Search box has the keyboard. Esc: back to the editor; Down (search box): into the results. */
  searchKey(k, cx, done) {
    if (k === "escape") { this.inBar = null; this.handle.focus(); cx.notify(); return done(); }
    if (k === "down" && this.inBar === this.searchInput && this.searchRows().length) {
      const s = this.search, rows = this.searchRows(), i = Math.max(0, rows.findIndex((r) => r.key === s.sel));
      this.inBar = null; this.searchFocus = true; this.handle.focus();
      s.sel = rows[i].key; this.searchScroll.scroll_to_item(i); cx.notify();
      return done();
    }
    const id = this.kIdx.find.get(k), flag = { findCase: "cased", findWord: "word", findRegex: "regex" }[id];
    if (flag) { this.searchFlag(flag, cx); return done(); }
    if (id === "replaceAll") { this.askReplaceAll(cx); return done(); }
    if (this.kIdx.pane.get(k) === "searchFiles") return done();
  }

  /** Keys while the results have the keyboard. True: handled (other keys never type into the editor). */
  resultsKey(k, cx) {
    if (!this.searchShown() || !this.searchRows().length) { this.searchFocus = false; return false; }
    const go = {
      up: () => this.moveResult(-1, cx), down: () => this.moveResult(1, cx), enter: () => this.enterResult(cx),
      left: () => this.foldResult(false, cx), right: () => this.foldResult(true, cx),
      escape: () => { this.searchFocus = false; cx.notify(); },
    }[k];
    if (go) { go(); return true; }
    const id = this.kIdx.pane.get(k);
    if (id) { this.searchFocus = false; this.runAction(id, cx); }
    return true;
  }

  /** The files Replace All can write: every result's file, on this computer or the space's machine. */
  replaceTargets() {
    return { files: this.search.results?.files ?? [] };
  }

  /** Replace All, first step: the confirm line. */
  askReplaceAll(cx) {
    const s = this.search;
    if (!s.results?.total || s.running || s.busy || !s.replace || !this.replaceTargets().files.length) return;
    s.confirm = true; s.note = null; cx.notify();
  }

  /** A file outside the review as Replace All reads it: its own baseline, like loadPlain. */
  async plainFile(st, rel) {
    const path = `${st.root}/${rel}`, text = await readTextFile(path, { on: st.on ?? null });
    if (typeof text !== "string") return null;
    const C = splitLines(text);
    return { rel, path, basePath: null, store: st, key: `${st.root}|${rel}`, plain: true, created: false, by: null, as: null, Btext: text, Ctext: text, B: C, C, hunks: [] };
  }

  /**
   * Replace All, confirmed. Each file is read again (a file under review with its baseline,
   * store.load), its matching lines are replaced as typed edits (searchview.replaceState: the review
   * rules for a user's edit apply), and it's written compare-and-swap like a save, with the same edit
   * note to the agent. A file changed since it was read is skipped and reported. Files with unsaved
   * edits in any copy block it. Afterwards open copies reload and the search runs again.
   */
  replaceAllFiles(cx) {
    const s = this.search, r = s.results, rep = s.replace;
    s.confirm = false;
    if (!r || s.running || s.busy) return;
    const { files } = this.replaceTargets();
    if (!files.length) return;
    const keys = files.map((f) => f.key);
    const held = [...new Set([...this.files.filter((f) => keys.includes(f.key) && this.dirty(f)).map((f) => f.key), ...this.heldElsewhere(keys)])];
    if (held.length) {
      s.note = { text: `Unsaved edits in ${held.map((k) => base(k.slice(k.indexOf("|") + 1))).join(", ")}: save or discard them first`, error: true };
      cx.notify(); return;
    }
    s.busy = true; s.note = { text: "Replacing…", error: false }; cx.notify();
    const out = { n: 0, files: 0, skipped: [] };
    this.enqueue(async () => {
      const notes = [], indexes = new Map();
      for (const rf of files) {
        const st = rf.st;
        try {
          if (!indexes.has(st)) indexes.set(st, await st.index());
          const entry = indexes.get(st)[rf.rel];
          const f = entry ? await st.load(rf.rel, entry) : await this.plainFile(st, rf.rel);
          if (typeof f?.Ctext !== "string") { out.skipped.push(`${base(rf.rel)} (deleted)`); continue; }
          const [p] = replacePlan([{ rel: rf.rel, matches: rf.matches }], { [rf.rel]: f.Ctext }, r.opts, rep);
          if (!p) continue;
          const res = replaceState(f, p.text);
          if (!res) { out.skipped.push(`${base(rf.rel)} (its line count would change)`); continue; }
          const applied = [];
          try { for (const w of res.writes) applied.push(await st.apply(f, w)); }
          catch (e) { if (applied.length) await st.undo(applied).catch(() => {}); throw e; } // file and baseline go together
          notes.push(...res.writes.map((w) => this.editNote(f, w)).filter(Boolean));
          this.deferred.add(norm(f.path)); // open copies reload once the queue is done
          out.n += p.count; out.files++;
        } catch (e) {
          const msg = String(e?.message ?? e);
          out.skipped.push(`${base(rf.rel)} (${/changed since it was read/.test(msg) ? "changed since it was read" : msg})`);
        }
      }
      try { await this.sendEditNotes(notes); } catch (e) { log(`replace notes: ${e.message ?? e}`); }
    }, cx);
    const queued = this.queue;
    cx.spawn(async (cx) => {
      await queued;
      s.busy = false;
      const parts = [`Replaced ${many(out.n, "occurrence")} in ${many(out.files, "file")}`];
      if (out.skipped.length) parts.push(`skipped ${out.skipped.join(", ")}`);
      s.note = { text: parts.join("; "), error: out.skipped.length > 0 };
      if (this.search === s) this.runSearch(cx); else cx.notify();
    });
  }

  /** The Edit tab's left column: the Explorer / Search switch over the tree or the Search view. */
  renderLeft(t, full = false) {
    const on = this.search.left === "search";
    const tab = (id, label, here) => div().id(`left-${id}`).h(22).px(8).flex().items_center().rounded(4).text_size(11.5).cursor_pointer()
      .text_color(here ? t.foreground : t.muted).when(here, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => this.setLeft(id, cx)).child(label);
    return v_flex().id("left-column").h_full().min_h(0)
      .when(full, (e) => e.flex_1().min_w(0)).when(!full, (e) => e.w(on ? 300 : 240).flex_none().border_r(1).border_color(t.border))
      .child(h_flex().h(30).flex_none().px(6).gap(2).items_center().border_b(1).border_color(t.border)
        .child(tab("explorer", "Explorer", !on))
        .child(tab("search", `Search  ${this.kl("searchFiles")}`, on)))
      .child(on ? this.renderSearch(t) : this.renderTree(t, full));
  }

  renderSearch(t) {
    const s = this.search, r = s.results, rows = this.searchRows(), multi = this.repos().length > 1;
    const chip = (id, label, on, flip) => div().id(id).h(22).px(6).flex().flex_none().items_center().rounded(4).text_size(11).cursor_pointer()
      .bg(on ? t.accent + "77" : t.raised).hover((st) => st.opacity(0.85)).on_click((_e, cx) => flip(cx)).child(label);
    const label = (text) => div().text_size(10.5).text_color(t.dim).child(text);
    const sum = summaryOf({ running: s.running, results: r, repos: this.repos().length, plain: this.stores.filter((x) => x.plain).length });
    const preview = !!s.replace && !!r?.total, { files: targets, remote } = this.replaceTargets();
    return v_flex().id("search-view").flex_1().min_h(0)
      .child(v_flex().flex_none().px(6).pt(6).pb(4).gap(4)
        .child(h_flex().gap(4).items_center()
          .child(div().id("search-more").w(16).h(22).flex().flex_none().items_center().justify_center().rounded(4).text_size(10).text_color(t.dim).cursor_pointer()
            .hover((st) => st.bg(t.hover)).on_click((_e, cx) => { s.more = !s.more; cx.notify(); }).child(s.more ? "▾" : "▸"))
          .child(div().flex_1().min_w(0).child(Input.new(this.searchInput)))
          .child(chip("search-cased", "Aa", s.opts.cased, (cx) => this.searchFlag("cased", cx)))
          .child(chip("search-word", "W", s.opts.word, (cx) => this.searchFlag("word", cx)))
          .child(chip("search-regex", ".*", s.opts.regex, (cx) => this.searchFlag("regex", cx))))
        .when(s.more, (e) => e.child(v_flex().pl(20).gap(4)
          .child(Input.new(this.sReplaceInput))
          .child(label("files to include")).child(Input.new(this.includeInput))
          .child(label("files to exclude")).child(Input.new(this.excludeInput)))))
      .child(h_flex().flex_none().min_h(24).px(8).gap(6).items_center()
        .child(div().flex_1().min_w(0).text_size(11).text_color(sum.error ? t.ansi1 : t.muted).child(sum.text))
        .when(preview && targets.length > 0 && !s.confirm && !s.busy && !s.running, (e) => e.child(this.button("search-replace-all", "Replace All", t.raised, (cx) => this.askReplaceAll(cx)).flex_none())))
      .when(!!s.confirm, (e) => e.child(v_flex().flex_none().mx(6).mb(4).p(8).gap(6).rounded(6).bg(t.raised).text_size(11)
        .child(div().text_color(t.foreground).child(`Replace ${many(occurrences(targets), "occurrence")} in ${many(targets.length, "file")}?`))
        .when(remote > 0, (e) => e.child(div().text_color(t.dim).child(`${many(remote, "file")} on another machine left out: saving there isn't built yet.`)))
        .child(h_flex().gap(6)
          .child(this.button("search-replace-yes", "Replace", t.ansi1 + "55", (cx) => this.replaceAllFiles(cx)))
          .child(this.button("search-replace-no", "Cancel", t.background, (cx) => { s.confirm = false; cx.notify(); })))))
      .when(preview && !targets.length, (e) => e.child(div().flex_none().px(8).pb(4).text_size(11).text_color(t.dim).child("Replace isn't available for files on other machines yet")))
      .when(!!s.note, (e) => e.child(div().flex_none().px(8).pb(4).text_size(11).text_color(s.note.error ? t.ansi1 : t.dim).child(s.note.text)))
      .child(div().id("search-results").flex_1().min_h(0).relative().overflow_hidden()
        .on_size_change((size, cx) => { if (Math.abs((this.searchH ?? 0) - size.height) > 0.5) { this.searchH = size.height; cx.notify(); } })
        .when(rows.length > 0, (e) => e
          .child(v_virtual_list("search-rows", rows.length, SROW, (i) => rows[i].key,
            (range) => rows.slice(range.start, range.end).map((row) => this.searchRow(row, t, multi, preview)))
            .w_full().h(Math.max(SROW, this.searchH ?? 300)).track_scroll(this.searchScroll)
            .on_item_click((key, cx) => this.clickResult(key, cx)))
          .child(Scrollbar.vertical("search-rows").viewport_from_layout().absolute().inset_0())));
  }

  /** One result row (inside the virtual list: no handlers here, clicks come through on_item_click). */
  searchRow(row, t, multi, preview) {
    const s = this.search, on = row.key === s.sel, selBg = this.searchFocus ? t.selected : t.hover;
    if (row.kind === "file") {
      const f = row.file, cut = f.rel.lastIndexOf("/") + 1;
      return h_flex().w_full().h(SROW).px(6).gap(4).items_center().whitespace_nowrap().cursor_pointer()
        .when(on, (e) => e.bg(selBg))
        .child(div().w(10).flex_none().text_size(10).text_color(t.dim).child(s.collapsed.has(f.key) ? "▸" : "▾"))
        .child(div().flex_none().text_size(12).child(f.rel.slice(cut)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child((multi ? this.repoName(f.st) + (cut ? "/" : "") : "") + f.rel.slice(0, Math.max(0, cut - 1))))
        .child(div().flex_none().px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(fmt(occurrences([f]))));
    }
    const m = row.m, pieces = matchPieces(m.text, m.ranges, preview ? { opts: s.results.opts, replace: s.replace } : null);
    return h_flex().w_full().h(SROW).pl(22).pr(6).items_center().overflow_hidden().whitespace_nowrap().text_size(12).cursor_pointer()
      .when(on, (e) => e.bg(selBg))
      .children(pieces.map((p) => {
        const d = div().flex_none().child(p.text);
        if (p.kind === "hit") return d.bg(t.ansi3 + "55").rounded(2);
        if (p.kind === "old") return d.bg(t.ansi1 + "40").text_color(t.ansi1).line_through();
        if (p.kind === "new") return d.bg(t.ansi2 + "40").text_color(t.ansi2);
        return d.text_color(t.muted);
      }));
  }

  // ---- bracket matching ---------------------------------------------------------

  /**
   * The bracket pair beside the cursor in the current file, or null (also while text is selected).
   * Worked out again only when the cursor, the text or its highlighting changed. Brackets in strings
   * and comments don't count, as the highlighter's tokens tell (brackets.tokenSkip).
   */
  bracketPair(f) {
    if (!f || f.error || f.Ctext === null || !this.cur || this.hasTextSel()) return null;
    const c = this.cur, m = this.bmMemo;
    if (m && m.C === f.C && m.tok === f.newTok && m.line === c.line && m.col === c.col) return m.pair;
    const lines = linesOf(f), skip = tokenSkip(f.newTok, lines);
    let pair = matchBracket(lines, c, { skip });
    if (pair && (skip(pair.open.line, pair.open.col) || skip(pair.close.line, pair.close.col))) pair = null; // a bracket in a string
    this.bmMemo = { C: f.C, tok: f.newTok, line: c.line, col: c.col, pair };
    return pair;
  }

  // ---- saving ---------------------------------------------------------------

  /** The writes that bring disk up to memory for `f`. */
  saveWrites(f) {
    if (!this.dirty(f)) return [];
    const w = [];
    if (f.Ctext !== f.diskC) w.push({ target: "current", before: f.diskC, after: f.Ctext });
    if (!f.plain && f.Btext !== f.diskB) w.push({ target: "baseline", before: f.diskB, after: f.Btext });
    return w;
  }

  save(cx, f = this.file()) {
    if (!f) return;
    if (f.conflict) { this.error = "The file changed on disk while you were editing: pick Keep mine or Take agent's first"; cx.notify(); return; }
    const writes = this.saveWrites(f);
    if (!writes.length) return;
    const notes = writes.map((w) => this.editNote(f, w)).filter(Boolean);
    this.replace(f, { ...f, diskC: f.Ctext, diskB: f.Btext });
    cx.notify();
    this.enqueue(async () => {
      let done = 0;
      try { for (const w of writes) { await f.store.apply(f, w); done++; } await this.sendEditNotes(notes); }
      catch (e) {
        // Memory still holds the edits: whatever didn't reach disk counts as unsaved again.
        const g = this.files.find((x) => x.key === f.key);
        if (g) for (const w of writes.slice(done)) g[w.target === "baseline" ? "diskB" : "diskC"] = w.before;
        throw e;
      }
    }, cx);
  }

  /** Q45: a passive note to the agent that changed a file, naming the lines a save changed. */
  editNote(f, w) {
    if (!f.by || !this.settings.editNote || w.target !== "current" || w.before === null || w.after === null) return null;
    const on = f.store?.on ?? null;
    if (on && hookKnown(on) === false) return null; // delivered by the Claude hook, not installed there
    const r = changedRanges(w.before, w.after);
    if (!r.length) return null;
    const at = r.slice(0, 6).map((h) => (!h.nc ? `lines removed at ${h.n + 1}` : h.nc === 1 ? `line ${h.n + 1}` : `lines ${h.n + 1}-${h.n + h.nc}`));
    if (r.length > 6) at.push(`${r.length - 6} more places`);
    return { key: f.key, terminal: f.by, path: f.as ?? agentPath(f.path, f.by), at: at.join(", "), on };
  }

  /** Queues edit notes. A file's earlier note the agent hasn't read yet is replaced, not repeated. */
  async sendEditNotes(notes) {
    for (const n of notes) {
      const prev = this.editNotes.get(n.key), earlier = !!prev && await this.noteToClaude(prev, () => withdrawFeedback(prev.terminal, prev.text, { on: prev.on }));
      const text = `Code review: the user edited ${n.path} (${n.at}${earlier ? ", plus earlier edits" : ""}). Read the file again before you change it.`;
      if ((await this.noteToClaude(n, () => queueFeedback(n.terminal, text, { on: n.on }))) === false) continue;
      this.editNotes.set(n.key, { terminal: n.terminal, text, on: n.on });
    }
  }

  /** Conflict banner: overlapping lines take mine or the agent's; the rest of both is kept. */
  resolve(how, cx) {
    const f = this.file(), k = f?.conflict;
    if (!k) return;
    if (!k[how]) { this.cur = this.anchor = null; cx.spawn(async (cx) => this.reloadOne({ ...f, conflict: null }, cx)); return; }
    cx.spawn(async (cx) => {
      const next = await this.merged(k.nf, k[how].Ctext, k[how].Btext, cx);
      if (this.files.includes(f)) { this.adoptMerge(f, next); cx.notify(); }
    });
  }

  // ---- input ---------------------------------------------------------------

  /** Each scope's key -> action lookup, rebuilt when the user's shortcuts change. */
  setKeymap(overrides) {
    this.keymap = resolve(overrides);
    this.kIdx = { edit: index(this.keymap, "edit"), pane: index(this.keymap, "pane"), find: index(this.keymap, "find"), tree: index(this.keymap, "tree") };
  }

  /** The first key bound to an action, for buttons and menus ("" when it has none). */
  kl(id) { return keyLabel(this.keymap.get(id)?.[0]); }

  /** Runs one action by id (a key, a "mod:wingman" binding, or a command). */
  runAction(id, cx) {
    const f = this.file();
    const go = {
      accept: () => this.decide("accept", cx), reject: () => this.decide("reject", cx),
      acceptFile: () => this.wholeFile("accept", cx), rejectFile: () => this.wholeFile("reject", cx),
      nextChange: () => this.step(1, cx), prevChange: () => this.step(-1, cx),
      comment: () => this.askPrompt(this.current, cx), reason: () => this.askReason(cx),
      nextFile: () => this.stepFile(1, cx), prevFile: () => this.stepFile(-1, cx),
      quickOpen: () => this.openQuick(cx), toggleView: () => this.setMode(this.nextView(), cx),
      toggleTree: () => this.toggleTree(cx), openInVSCode: () => this.toVSCode(cx), toggleWrap: () => this.toggleWrap(cx),
      openInNvim: () => { if (f) this.toNvim(f, this.cur?.line ?? f.hunks[this.current]?.n ?? 0, cx); },
      save: () => this.save(cx), undo: () => this.undo(cx), redo: () => this.redoEdit(cx),
      selectAll: () => this.clip("all", cx), copy: () => this.clip("copy", cx), cut: () => this.clip("cut", cx), paste: () => this.clip("paste", cx),
      moveLineUp: () => this.lineOp("moveUp", cx), moveLineDown: () => this.lineOp("moveDown", cx),
      copyLineUp: () => this.lineOp("copyUp", cx), copyLineDown: () => this.lineOp("copyDown", cx),
      deleteLine: () => this.lineOp("delete", cx), joinLines: () => this.lineOp("join", cx), toggleComment: () => this.lineOp("comment", cx),
      find: () => this.openFind("find", cx), replace: () => this.openFind("replace", cx), goToLine: () => this.openFind("line", cx),
      findNext: () => this.findStep(1, cx), findPrev: () => this.findStep(-1, cx),
      findCase: () => this.findFlag("cased", cx), findWord: () => this.findFlag("word", cx), findRegex: () => this.findFlag("regex", cx),
      replaceAll: () => this.replaceAll(cx), searchFiles: () => this.openSearch(cx),
      // Only while the tree has the keyboard: Delete in the editor deletes text.
      renameItem: () => { if (this.treeFocus && this.treeCur) this.startTreeEdit("rename", this.treeCur, cx); },
      deleteItem: () => { if (this.treeFocus && this.treeCur) this.askTreeDelete(this.treeCur, cx); },
    }[id];
    go?.();
  }

  /** Select all, copy, cut, paste: on the text cursor's file only. */
  clip(how, cx) {
    const f = this.file();
    if (!this.cur || !this.editable(f)) return;
    const lines = linesOf(f), c = this.cur, sel = this.hasTextSel(), lineEnd = (l) => ({ line: l, col: body(lines[l]).length });
    if (how === "all") { this.anchor = { line: 0, col: 0 }; this.cur = lineEnd(lines.length - 1); cx.notify(); return; }
    if (how === "paste") { const t = cx.read_from_clipboard(); if (t) this.type(t, cx); return; }
    cx.write_to_clipboard(this.copyText(f));
    if (how !== "cut") return;
    // Cut without a selection takes the whole line.
    if (sel) this.type("", cx);
    else if (c.line + 1 < lines.length) this.type("", cx, { from: { line: c.line, col: 0 }, to: { line: c.line + 1, col: 0 } });
    else this.type("", cx, { from: c.line > 0 ? lineEnd(c.line - 1) : { line: 0, col: 0 }, to: lineEnd(c.line) });
  }

  key(e, cx) {
    const f = this.file(), k = e.keystroke, done = () => cx.stop_propagation();
    // Quick Open has the keyboard: its own keys, and its key again moves down the list.
    if (this.inBar === this.quickInput) {
      const qk = { escape: () => this.closeQuick(cx), up: () => this.moveQuick(-1, cx), down: () => this.moveQuick(1, cx), tab: () => this.completeQuick(cx) }[k]
        ?? (this.kIdx.pane.get(k) === "quickOpen" ? () => this.moveQuick(1, cx) : null);
      if (qk) { qk(); done(); }
      return;
    }
    if (this.commitInput && this.inBar === this.commitInput) return; // the commit message box types its own keys
    if (this.inBar === this.pathInput) { if (k === "escape") { this.ws = null; this.inBar = null; this.handle.focus(); cx.notify(); done(); } return; }
    // The tree's name box: Esc cancels; Enter (submit) does it; every other key types.
    if (this.treeInput && this.inBar === this.treeInput) { if (k === "escape") { this.endTreeEdit(cx); done(); } return; }
    // A Search box has the keyboard (searchKey); then the results, after Down or a click (resultsKey).
    if (this.inBar && this.searchInputs?.includes(this.inBar)) return this.searchKey(k, cx, done);
    // The find bar has the keyboard: Esc, the bar's own actions, and switching between find, replace and line.
    if (this.inBar) {
      if (k === "escape") { this.closeFind(cx); return done(); }
      const id = this.kIdx.find.get(k) ?? (["find", "replace", "goToLine"].includes(this.kIdx.pane.get(k)) ? this.kIdx.pane.get(k) : null);
      if (id) { this.runAction(id, cx); done(); }
      return;
    }
    if (this.searchFocus && this.resultsKey(k, cx)) return done();
    if (this.treeFocus && this.treeKey(e, cx)) return done();
    if (this.cur && this.editable(f)) {
      const id = this.kIdx.edit.get(k);
      if (id) { this.runAction(id, cx); return done(); }
      if (this.editKey(e, f, cx)) return done();
    }
    const id = this.kIdx.pane.get(k);
    if (id) { this.runAction(id, cx); return done(); }
    const fixed = {
      "shift-down": () => this.extend(1, cx),
      "shift-up": () => this.extend(-1, cx),
      "escape": () => (this.selA == null && !this.anchor ? null : this.clearSelection(cx)),
    }[k];
    if (fixed) { fixed(); done(); }
  }

  // ---- popup form (O1 reason, O2 prompt) ----------------------------------

  initForm(cx) {
    this.form = props();
    if (this.form.form === "menu") return; // the right-click menu has no input
    if (this.form.form === "keys") {
      this.formHandle = cx.focus_handle(); this.formHandle.focus();
      this.keySearch = InputState.new({ placeholder: "Search shortcuts by action or key" });
      this.keySearch.on("change", (_e, cx) => cx.notify());
      cx.spawn(async (cx) => {
        this.overrides = await loadKeys(); this.km = resolve(this.overrides);
        this.herdr = herdrGlobal((await readTextFile(`${appHome()}/keys.json`)) ?? "{}"); cx.notify();
      });
      return;
    }
    if (this.form.form === "settings") {
      this.formHandle = cx.focus_handle(); this.formHandle.focus();
      // The custom editor command saves half a second after typing stops.
      this.extInput = InputState.new({ placeholder: "Command, e.g. idea --line {line} {path}" });
      this.extInput.on("change", (_e, cx) => {
        const v = this.extInput.value(); this.extTyped = v;
        cx.timer.after(500, (cx) => { if (this.extTyped === v && v !== (this.st?.externalCommand ?? "")) this.setSetting({ externalCommand: v }, cx); });
      });
      cx.spawn(async (cx) => { this.st = await loadSettings(); this.extInput.set_value?.(this.st.externalCommand ?? ""); cx.notify(); });
      if (this.form.machine) this.hookAction(null, cx);
      return;
    }
    this.text = "";
    // A text area: Enter adds a line, Ctrl+Enter sends (also caught on the form, in case the
    // text area doesn't report it as a submit).
    this.input = TextareaState.new({ placeholder: this.form.form === "reason" ? "Why it was rejected" : "What should the agent do here?", rows: 3 });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", (e, cx) => { if (e?.secondary) this.submitForm(cx); });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    this.formHandle = cx.focus_handle();
  }

  submitForm(cx) {
    const { form, terminal, file, where, overlay } = this.form, text = this.text.trim();
    if (!text) { closeOverlay(overlay); return; }
    if (this.sending) return;
    this.sending = true;
    // Write first, close after: closing ends this copy, and its unfinished work with it.
    // A reason is context for the agent's next step; a prompt is a message from the user.
    cx.spawn(async () => {
      try {
        if (form === "reason") await queueFeedback(terminal, `Code review: the user's comment on rejecting ${where} in ${file}: ${text}`, { on: this.form.on ?? null });
        else if (this.form.quote) await queuePrompt(terminal, `${text}\n\nRe: ${file}, ${where}:\n\`\`\`\n${this.form.quote}\n\`\`\``);
        else await queuePrompt(terminal, `${text} (re: ${file}, ${where})`);
      } catch (e) { log(`${form} for ${terminal} failed: ${e.message ?? e}`); }
      closeOverlay(overlay);
    });
  }

  renderForm() {
    const t = theme(), { form, terminal, file, where, overlay } = this.form;
    const title = form === "reason" ? "Comment last rejection" : "Comment";
    const hint = form === "reason"
      ? `Sent to ${terminal} with the next tool call or prompt.`
      : `Typed into ${terminal} as your message once it's idle.`;
    return v_flex().id("review-form").track_focus(this.formHandle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(overlay); cx.stop_propagation(); }
        else if (e.keystroke === "ctrl-enter" || e.keystroke === "cmd-enter") { this.submitForm(cx); cx.stop_propagation(); }
      })
      // Fixed parts keep their size; the text area takes what is left and scrolls inside,
      // so the footer and its button always stay in the popup.
      .size_full().min_h(0).p(18).gap(8).bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().items_center().child(div().flex_1().text_size(15).font_semibold().child(title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().flex_none().text_size(11.5).text_color(t.muted).truncate().child(`${file}, ${where}`))
      // Every quoted line (up to the 40 sent), scrolling inside a fixed-height box.
      .when(!!this.form.quote, (e) => e.child(v_flex().id("form-quote").h(130).flex_none().overflow_y_scrollbar().px(8).py(4).rounded(6).bg(t.background)
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.muted)
        // Long lines wrap inside the box rather than being cut off.
        .children(this.form.quote.split("\n").map((l, i) => div().id(`q${i}`).flex_none().w_full().min_w(0).whitespace_normal()
          .text_color(l.startsWith("+") ? t.ansi2 : l.startsWith("-") ? t.ansi1 : t.muted).child(l || " ")))))
      .child(div().flex_1().min_h(0).child(Textarea.new(this.input).size_full().px(10).py(6).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground)))
      .child(h_flex().flex_none().items_center().gap(8)
        .child(div().flex_1().text_size(11).text_color(t.dim).child(hint))
        .child(div().id("form-send").flex_none().whitespace_nowrap().h(30).px(14).flex().items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12.5).cursor_pointer()
          .on_click((_e, cx) => this.submitForm(cx)).child("Send  Ctrl+⏎")));
  }

  // ---- selection bar and right-click menu ----------------------------------

  /** Floats over the diff while lines are selected, saying what can be done with them. */
  selectionBar(f, sel, t) {
    const n = this.rowsOf(f).slice(sel[0], sel[1] + 1).filter((r) => r.kind !== "@" && !r.cont).length;
    return h_flex().absolute().bottom(12).left(0).right(0).justify_center()
      .child(h_flex().gap(8).px(10).py(5).items_center().rounded(8).bg(t.popover).border_1().border_color(t.accent).shadow_md().text_size(11.5)
        .child(div().text_color(t.muted).child(`${n} line${n === 1 ? "" : "s"} selected`))
        .when(this.mode !== "changes" && this.picks(f, sel).any, (e) => e
          .child(this.button("sel-reject", `Reject  ${this.kl("reject")}`, t.ansi1 + "55", (cx) => this.selectionAction("reject", cx)))
          .child(this.button("sel-accept", `Accept  ${this.kl("accept")}`, t.ansi2 + "55", (cx) => this.selectionAction("accept", cx))))
        .child(this.button("sel-prompt", `Comment  ${this.kl("comment")}`, t.ansi4 + "55", (cx) => this.askPrompt(this.current, cx)))
        .child(this.button("sel-clear", "Clear  Esc", t.raised, (cx) => this.clearSelection(cx))));
  }

  /**
   * Right-click opens a menu for the line under the pointer. It never changes the selection:
   * selecting is left-click only. A line in a hunk, or its button row, makes that hunk current.
   */
  openMenu(ev, cx) {
    const f = this.file(), i = this.rowAt(ev.local_position?.y ?? -1);
    if (!f || i < 0) return;
    this.handle.focus();
    const r = this.rowsOf(f)[i], inHunk = r.hunk != null, sel = this.selection(f), hasSel = !!sel;
    if (inHunk) this.current = r.hunk;
    // With changed lines selected, Accept/Reject act on those lines only; otherwise on the hunk.
    // The labels stay short; the selection bar shows when they act on selected lines.
    const selChanges = hasSel && this.picks(f, sel).any && this.mode !== "changes";
    const items = [
      { cmd: "prompt", label: "Comment", key: this.kl("comment") },
      ...((inHunk && this.mode !== "changes") || selChanges ? [
        { cmd: "reject", label: "Reject", key: this.kl("reject") },
        { cmd: "rejectReason", label: "Reject with comment…", key: "" },
        { cmd: "accept", label: "Accept", key: this.kl("accept") },
      ] : []),
      ...(this.lastReject ? [{ cmd: "reason", label: "Comment last rejection", key: this.kl("reason") }] : []),
      ...(hasSel ? [{ cmd: "clear", label: "Clear selection", key: "Esc" }] : []),
    ];
    openOverlay({ mod: "wingman", props: { form: "menu", items }, kind: "popup", at: "pointer", width: 260, height: items.length * 30 + 12 });
    cx.notify();
  }

  // ---- settings popup (Q47) ---------------------------------------------------

  /** Saves one setting; the pane copy rereads them through wingman.settings. */
  setSetting(patch, cx) {
    this.st = { ...this.st, ...patch };
    const next = this.st;
    cx.notify();
    cx.spawn(async () => {
      try { await saveSettings(next); run("wingman.settings"); } catch (e) { log(`settings: ${e.message ?? e}`); }
    });
  }

  /**
   * The settings popup's Claude hook on the space's machine: `how` "install" or "remove" (null:
   * only the status). The result line says what was done; the pane copy is told to look again.
   */
  hookAction(how, cx) {
    const on = this.form.machine;
    if (this.hook?.busy) return;
    this.hook = { ...this.hook, busy: how ? (how === "install" ? "Installing…" : "Removing…") : "Checking…", ...(how ? { result: null, failed: false } : {}) };
    cx.notify();
    cx.spawn(async (cx) => {
      let result = this.hook.result, failed = this.hook.failed;
      try {
        const text = (await readTextFile(`${appHome()}/mods/wingman/hooks/wingman-hook.sh`))?.replace(/\r\n/g, "\n") ?? null;
        if (how === "install") {
          if (!text) throw new Error("hooks/wingman-hook.sh is missing from the mod folder");
          result = await installHook(on, text);
        } else if (how === "remove") result = await uninstallHook(on);
        if (how) { failed = false; run("wingman.hook"); }
        this.hook = { status: hookSummary(await hookStatus(on, { hookText: text }), on), result, failed };
      } catch (e) {
        this.hook = { status: this.hook?.status ?? null, result: String(e.message ?? e), failed: true };
      }
      cx.notify();
    });
  }

  // ---- keyboard shortcuts dialog (form "keys") ------------------------------------

  /** Saves the shortcut overrides, updates Herdr's mod:wingman section, and tells the pane. */
  setKeys(next, cx) {
    this.overrides = next; this.km = resolve(next); this.rec = null; this.pending = null;
    cx.notify();
    const km = this.km;
    cx.spawn(async () => {
      try { await saveKeys(next); await syncHerdrKeys(km); run("wingman.settings"); } catch (e) { log(`keys: ${e.message ?? e}`); }
    });
  }

  /** A key pressed while recording: refused, a conflict to confirm, or bound. */
  recordKey(e, cx) {
    const k = keystrokeOf(e);
    if (!k) return;
    cx.stop_propagation();
    if (k === "escape") { this.rec = null; this.keyMsg = null; cx.notify(); return; }
    const why = refused(k);
    if (why) { this.keyMsg = `${keyLabel(k)} can't be bound: it's ${why}.`; cx.notify(); return; }
    const others = holders(this.km, k, this.rec);
    if (others.length) { this.pending = { id: this.rec, key: k, others }; this.rec = null; this.keyMsg = null; cx.notify(); return; }
    this.keyMsg = null;
    this.setKeys(bind(this.overrides, this.km, this.rec, k), cx);
  }

  renderKeys() {
    const t = theme(), { overlay } = this.form, km = this.km, q = (this.keySearch?.value() ?? "").trim().toLowerCase();
    const chip = (id, k) => h_flex().id(`key-${id}-${k}`).h(22).px(6).gap(4).items_center().rounded(4).bg(t.raised).text_size(11)
      .child(div().child(keyLabel(k)))
      .when(!!this.herdr?.[k], (e) => e.child(div().text_size(10).text_color(t.ansi3).child(`hides Herdr ${this.herdr[k]}`)))
      .child(div().id(`unkey-${id}-${k}`).px(2).rounded(2).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => this.setKeys(unbind(this.overrides, this.km, id, k), cx)).child("×"));
    const rows = [];
    let group = null;
    for (const a of ACTIONS) {
      const keys = km?.get(a.id) ?? [];
      if (q && !a.label.toLowerCase().includes(q) && !keys.some((k) => k.includes(q))) continue;
      if (a.group !== group) { group = a.group; rows.push(div().id(`group-${group}`).pt(10).pb(2).text_size(11).font_semibold().text_color(t.muted).child(group)); }
      const changed = !!this.overrides?.[a.id], recording = this.rec === a.id;
      rows.push(h_flex().id(`act-${a.id}`).min_h(30).py(2).gap(8).items_center().rounded(4).hover((s) => s.bg(t.hover)).px(6)
        .child(div().flex_1().min_w(0).text_size(12).child(a.label))
        .child(h_flex().flex_none().gap(4).items_center().flex_wrap()
          .children(keys.map((k) => chip(a.id, k)))
          .when(recording, (e) => e.child(div().h(22).px(8).flex().items_center().rounded(4).bg(t.accent + "55").text_size(11).child("Press a key… (Esc cancels)")))
          .when(!recording, (e) => e.child(div().id(`add-${a.id}`).h(22).px(6).flex().items_center().rounded(4).text_size(11).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground)).on_click((_e, cx) => { this.rec = a.id; this.pending = null; this.keyMsg = null; this.formHandle.focus(); cx.notify(); }).child("+ key")))
          .when(changed, (e) => e.child(div().id(`reset-${a.id}`).h(22).px(6).flex().items_center().rounded(4).text_size(11).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.raised).text_color(t.foreground)).on_click((_e, cx) => this.setKeys(resetKey(this.overrides, a.id), cx)).child("Reset")))));
    }
    const p = this.pending;
    return v_flex().id("wingman-keys").track_focus(this.formHandle)
      .on_key_down((e, cx) => {
        if (this.rec) return this.recordKey(e, cx);
        if (e.key === "escape") { if (this.pending) { this.pending = null; cx.notify(); } else closeOverlay(overlay); cx.stop_propagation(); }
      })
      .size_full().p(16).gap(8).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(15).font_semibold().child("Keyboard shortcuts"))
        .child(this.button("keys-reset-all", "Reset all", t.raised, (cx) => this.setKeys({}, cx)))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(11).text_color(t.dim).child("Click + key and press the shortcut. Keys Herdr uses globally are sent to Wingman while it has focus. Arrows, Home/End, Page Up/Down, Backspace, Delete, Enter, Tab and plain typing stay fixed."))
      .when(!!this.keySearch, (e) => e.child(Input.new(this.keySearch)))
      .when(!!this.keyMsg, (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.keyMsg)))
      .when(!!p, (e) => e.child(h_flex().gap(8).items_center().p(8).rounded(6).bg(t.ansi3 + "22").text_size(12)
        .child(div().flex_1().child(`${keyLabel(p.key)} is bound to ${p.others.map((o) => BY_ID.get(o).label).join(", ")}. Move it to ${BY_ID.get(p.id).label}?`))
        .child(this.button("keys-move", "Move it", t.accent + "55", (cx) => this.setKeys(bind(this.overrides, this.km, p.id, p.key), cx)))
        .child(this.button("keys-cancel", "Cancel", t.raised, (cx) => { this.pending = null; cx.notify(); }))))
      .child(v_flex().id("keys-list").flex_1().min_h(0).overflow_y_scrollbar().children(km ? rows : [div().id("keys-loading").text_size(12).text_color(t.dim).child("Loading…")]));
  }

  renderSettings() {
    const t = theme(), st = this.st, { overlay } = this.form;
    const toggle = (id, label, hint, on, flip) => h_flex().id(id).gap(10).py(6).items_center().cursor_pointer()
      .on_click((_e, cx) => flip(cx))
      .child(div().w(34).h(18).flex_none().rounded(9).p(2).bg(on ? t.accent : t.raised)
        .child(div().size(14).rounded(7).bg(t.foreground).when(on, (e) => e.ml(16))))
      .child(v_flex().child(div().text_size(13).child(label)).child(div().text_size(11).text_color(t.dim).child(hint)));
    return v_flex().id("wingman-settings").track_focus(this.formHandle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(overlay); cx.stop_propagation(); } })
      .size_full().p(18).gap(10).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(8).child(div().flex_1().text_size(15).font_semibold().child("Settings"))
        .child(this.button("open-keys", "Keyboard shortcuts…", t.raised, () => { closeOverlay(overlay); openOverlay({ mod: "wingman", props: { form: "keys" }, kind: "dialog", width: 700, height: 620 }); }))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(!st, (e) => e.child(div().text_size(12).text_color(t.dim).child("Loading…")))
      .when(!!st, (e) => e
        .child(toggle("set-note", "Auto note on rejections", "Tell the agent which of its changes you rejected.", st.autoNote, (cx) => this.setSetting({ autoNote: !st.autoNote }, cx)))
        .child(toggle("set-editnote", "Note on my edits", "Tell the agent which lines of its files you changed.", st.editNote, (cx) => this.setSetting({ editNote: !st.editNote }, cx)))
        .child(toggle("set-pairs", "Auto-close brackets and quotes", "Typing ( [ { \" ' ` adds the closer; Backspace in an empty pair removes both.", st.autoPairs ?? true, (cx) => this.setSetting({ autoPairs: !(st.autoPairs ?? true) }, cx)))
        .child(toggle("set-tags", "Auto-close tags", "In HTML, XML, JSX and Vue files, typing > adds the closing tag and </ completes the open one.", st.autoTags ?? true, (cx) => this.setSetting({ autoTags: !(st.autoTags ?? true) }, cx)))
        .child(toggle("set-wrap", "Wrap long lines", "Long lines continue on the next screen row instead of scrolling sideways. Alt+Z by default.", st.wordWrap ?? false, (cx) => this.setSetting({ wordWrap: !(st.wordWrap ?? false) }, cx)))
        .child(toggle("set-autosave", "Autosave", "Save on focus loss and file switch. Where you and the agent change the same lines, the agent's win.", st.autosave, (cx) => this.setSetting({ autosave: !st.autosave }, cx)))
        .child(v_flex().gap(6).when(!st.autosave, (e) => e.opacity(0.4))
          .child(div().text_size(12).text_color(t.muted).child("Also save after typing stops for"))
          .child(h_flex().gap(4).children([0, 1, 2, 3, 5, 10].map((n) => div().id(`delay-${n}`).h(24).px(10).flex().items_center().rounded(5).text_size(12).cursor_pointer()
            .bg(st.autosaveDelay === n ? t.accent + "77" : t.raised).hover((s) => s.opacity(0.85))
            .on_click((_e, cx) => { if (st.autosave) this.setSetting({ autosaveDelay: n }, cx); })
            .child(n ? `${n}s` : "Focus change")))))
        .child(v_flex().gap(6).pt(4)
          .child(div().text_size(12).text_color(t.muted).child("Editor"))
          .child(h_flex().gap(4).children([["wingman", "Wingman"], ["nvim", "Neovim"]].map(([v, label]) => div().id(`editor-${v}`).h(24).px(10).flex().items_center().rounded(5).text_size(12).cursor_pointer()
            .bg((st.editor ?? "wingman") === v ? t.accent + "77" : t.raised).hover((s) => s.opacity(0.85))
            .on_click((_e, cx) => this.setSetting({ editor: v }, cx)).child(label))))
          .child(div().text_size(11).text_color(t.dim).child("Neovim: clicking a line, Open in Neovim, or a file in the tree opens it in a Neovim pane beside Wingman.")))
        .child(v_flex().gap(6).pt(4)
          .child(div().text_size(12).text_color(t.muted).child("External editor (Open in external editor, and the file row's last button)"))
          .child(h_flex().gap(4).flex_wrap().children(Object.entries(EDITORS).map(([v, ed]) => div().id(`ext-${v}`).h(24).px(10).flex().items_center().rounded(5).text_size(12).cursor_pointer()
            .bg((st.externalEditor ?? "code") === v ? t.accent + "77" : t.raised).hover((s) => s.opacity(0.85))
            .on_click((_e, cx) => this.setSetting({ externalEditor: v }, cx)).child(ed.name))))
          .when(st.externalEditor === "custom", (e) => e
            .child(Input.new(this.extInput))
            .child(div().text_size(11).text_color(t.dim).child('{path}, {line} and {col} are filled in; "quotes" keep spaces. Example: idea --line {line} --column {col} {path}'))))
        .when(!!this.form.machine, (e) => e.child(this.hookSection(t))));
  }

  /** Settings: the Claude hook on the space's machine, with Install and Remove. */
  hookSection(t) {
    const h = this.hook ?? {}, on = this.form.machine;
    return v_flex().gap(6).pt(4)
      .child(div().text_size(12).text_color(t.muted).child(`Claude hook on ${on}`))
      .child(div().text_size(11.5).child(h.busy && !h.status ? h.busy : h.status ?? ""))
      .child(h_flex().gap(6).items_center()
        .child(this.button("hook-install", "Install", t.accent + "55", (cx) => this.hookAction("install", cx)))
        .child(this.button("hook-remove", "Remove", t.raised, (cx) => this.hookAction("remove", cx)))
        .when(!!h.busy, (e) => e.child(div().text_size(11).text_color(t.dim).child(h.busy))))
      .when(!!h.result, (e) => e.child(div().text_size(11).text_color(h.failed ? t.ansi1 : t.dim).child(h.result)))
      .child(div().text_size(11).text_color(t.dim).child("Install copies the hook to the machine and adds it to Claude's settings there. Restart Claude there to load it."));
  }

  renderMenu() {
    const t = theme(), { items, overlay } = this.form;
    return v_flex().id("review-menu").size_full().p(6).gap(2).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .children(items.map((it) => h_flex().id(`m-${it.cmd}`).h(28).flex_none().px(10).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        // The menu is its own copy of the mod; the pane does the work, reached as wingman.<cmd>.
        .on_click(() => { closeOverlay(overlay); run(`wingman.${it.cmd}`); })
        .child(div().flex_1().child(it.label)).child(div().text_size(11).text_color(t.dim).child(it.key))));
  }

  // ---- view ----------------------------------------------------------------

  button(id, label, bg, onClick) {
    return div().id(id).h(22).px(10).flex().items_center().rounded(5).cursor_pointer().bg(bg).text_size(11)
      .hover((s) => s.opacity(0.85)).on_click((_e, cx) => { this.handle?.focus(); onClick(cx); }).child(label);
  }

  row(r, f, t, selected = false) {
    if (r.kind === "@" && this.mode === "changes") {
      return h_flex().w_full().h(ROW).flex_none().items_center().bg(t.raised)
        .child(div().w(GUTTER).flex_none())
        .child(div().flex_1().text_color(t.dim).text_size(11).child(`change ${r.hunk + 1} of ${f.hunks.length}`));
    }
    if (r.kind === "@") {
      // Row renderers can't hold handlers; the input layer maps clicks here to a button by x (rowButton).
      const current = r.hunk === this.current;
      return h_flex().w_full().h(ROW).flex_none().gap(BTN_GAP).items_center().bg(current ? t.selected : t.raised)
        .child(div().w(GUTTER).flex_none())
        .child(div().w(BTN_W).flex_none().h(16).rounded(4).flex().items_center().justify_center().bg(t.ansi1 + (current ? "99" : "55")).text_size(11).child(`Reject  ${this.kl("reject")}`))
        .child(div().w(BTN_W).flex_none().h(16).rounded(4).flex().items_center().justify_center().bg(t.ansi2 + (current ? "99" : "55")).text_size(11).child(`Accept  ${this.kl("accept")}`))
        .child(div().w(BTN_W).flex_none().h(16).rounded(4).flex().items_center().justify_center().bg(t.ansi4 + (current ? "77" : "40")).text_size(11).child(`Comment  ${this.kl("comment")}`))
        .child(div().flex_1().pl(8).text_color(t.dim).text_size(11).child(`change ${r.hunk + 1} of ${f.hunks.length}`));
    }
    const spans = expandTabs(spansOf((r.side === "old" ? f.oldTok : f.newTok)?.[r.line]));
    const text = r.side === "new" ? body(linesOf(f)[r.line]) : r.seg ? body(f.B[r.line]) : "";
    // E5: a wrapped segment shows its own columns, after the wrapping indent.
    const seg = r.seg, v0 = seg ? visualCol(text, seg.from) : 0, ind = seg?.ind ?? 0, last = !seg || seg.to === text.length;
    const cw = this.cw(), hx = this.hx, x = (col) => (visualCol(text, col) - v0 + ind) * cw - hx;
    const clip = (a, b) => (seg ? [Math.max(a, seg.from), Math.min(b, seg.to)] : [a, b]);
    // Text selection on this line: [from, to) in characters; a line selected through its end
    // shows one more cell for the line break.
    let mark = null;
    if (r.side === "new" && this.hasTextSel()) {
      const [a, b] = this.ordered();
      if (r.line >= a.line && r.line <= b.line) {
        const [from, to] = clip(r.line === a.line ? a.col : 0, r.line === b.line ? b.col : text.length);
        if (from <= to) mark = { left: x(from), w: Math.max(0, x(to) - x(from)) + (r.line < b.line && last ? cw : 0) };
      }
    }
    const onLine = r.side === "new" && this.cur?.line === r.line;
    const caret = onLine && (!r.segs || r.segs[segmentOf(r.segs, this.cur.col)] === seg);
    const found = r.side === "new" && this.bar ? this.matches(f) : null;
    const hits = (found?.byLine?.get(r.line) ?? []).filter((k) => { const [a, b] = clip(found.ms[k].from, found.ms[k].to); return a < b; });
    const onHit = hits.length ? this.onMatch(found.ms) : -1;
    // D2: the matched bracket pair's boxes on this row (never on removed lines).
    const bm = r.side === "new" && this.bm ? [this.bm.open, this.bm.close].filter((p) => p.line === r.line).map((p) => clip(p.col, p.col + 1)).filter(([a, b]) => a < b) : [];
    return h_flex().w_full().h(ROW).flex_none().whitespace_nowrap()
      .when(r.kind === "+", (e) => e.bg(t.ansi2 + "22")).when(r.kind === "-", (e) => e.bg(t.ansi1 + "22"))
      .when(selected, (e) => e.bg(t.selection).border_l(2).border_color(t.accent))
      .child(div().w(44).flex_none().pr(8).text_right().text_color(onLine ? t.foreground : t.dim).child(r.cont ? "" : String(r.num)))
      .child(div().w(14).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.dim).child(r.kind === " " || r.cont ? "" : r.kind))
      .child(div().flex_1().h_full().relative().overflow_hidden()
        .children(hits.map((k) => { const [a, b] = clip(found.ms[k].from, found.ms[k].to); return div().absolute().top(1).h(ROW - 2).rounded(2).left(x(a)).w(Math.max(2, x(b) - x(a)))
          .bg(k === onHit ? t.ansi3 + "88" : t.ansi3 + "38"); }))
        .children(bm.map(([a, b]) => div().absolute().top(1).h(ROW - 2).left(x(a)).w(Math.max(2, x(b) - x(a))).rounded(2).border_1().border_color(t.dim).bg(t.raised)))
        .when(!!mark, (e) => e.child(div().absolute().top(0).h(ROW).left(mark.left).w(mark.w).bg(t.selection)))
        .child(seg
          ? div().absolute().top(0).h(ROW).left(ind * cw).w((visualCol(text, seg.to) - v0) * cw).overflow_hidden()
            .child(h_flex().absolute().top(0).h(ROW).left(-v0 * cw).children(spans.map((s) => div().text_color(color(s.type, t)).child(s.text))))
          : h_flex().absolute().top(0).h(ROW).left(-hx).children(spans.map((s) => div().text_color(color(s.type, t)).child(s.text))))
        .when(caret, (e) => e.child(div().absolute().top(3).h(ROW - 6).w(2).left(x(this.cur.col)).bg(this.handle.is_focused() && !this.treeFocus ? t.accent : t.dim))));
  }

  render() {
    if (this.form?.form === "menu") return this.renderMenu();
    if (this.form?.form === "settings") return this.renderSettings();
    if (this.form?.form === "keys") return this.renderKeys();
    if (this.form) return this.renderForm();
    const t = theme(), f = this.file(), vis = this.visible(), total = vis.reduce((n, x) => n + x.hunks.length, 0);
    const tag = (x) => x.created ? "new" : x.Ctext === null ? "deleted" : `${x.hunks.length}`;
    const rows = f ? this.rowsOf(f) : [], sel = f ? this.selection(f) : null, lsel = f ? this.lineSel(f) : null;
    this.bm = f ? this.bracketPair(f) : null; // D2: read by row()
    const picked = this.files.find((x) => x.key === this.sel); // an error tab shows its error
    const away = this.machine();
    return v_flex().id("review").relative().size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().h(40).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Wingman"))
        // A panel copy is one view: the panel's own Review and Edit buttons switch between them.
        .when(!this.view, (e) => e.child(h_flex().flex_none().gap(2).p(2).rounded(6).bg(t.raised).children(["review", "edit"].map((m) =>
          div().id(`mode-${m}`).h(22).px(8).flex().items_center().rounded(4).text_size(12).cursor_pointer()
            .when(this.mode === m, (e) => e.bg(t.selected)).on_click((_e, cx) => this.setMode(m, cx))
            .child(m === "review" ? "Review" : "Edit")))))
        .child(div().text_size(11).text_color(t.muted).truncate().child(`${away ? `on ${away} · ` : ""}${this.stores.map((st) => base(st.root)).join(", ")} · ${total} change${total === 1 ? "" : "s"} in ${vis.length} file${vis.length === 1 ? "" : "s"} · ${this.history.length} undoable${this.writing ? " · saving…" : ""}${agents().some((a) => a.space === this.spaceId && ACTIVE.has(a.status)) ? " · agent working" : ""}`))
        .child(div().flex_1())
        .when(!!this.lastReject && !this.lastReject.remote, (e) => e.child(this.button("reason", `Comment last rejection  ${this.kl("reason")}`, t.raised, (cx) => this.askReason(cx))))
        .when(total > 0 && this.mode === "review", (e) => e
          .child(this.button("reject-all", "Reject all files", t.ansi1 + "55", (cx) => this.everything("reject", cx)))
          .child(this.button("accept-all", "Accept all files", t.ansi2 + "55", (cx) => this.everything("accept", cx))))
        .child(this.button("settings", "⚙ Settings", t.raised, () => this.openSettings()).flex_none()))
      .child(h_flex().flex_1().min_h(0)
      .when(this.treeOnly(), (e) => e.child(this.renderLeft(t, true)))
      .when(this.mode === "edit" && this.treeOn && !this.treeOnly(), (e) => e.child(this.renderLeft(t)))
      .when(this.mode === "changes", (e) => e.child(this.renderChanges(t)))
      .when(!this.treeOnly(), (e) => e.child(v_flex().flex_1().min_w(0).h_full()
      // File tabs scroll sideways in their own area; the hint and file buttons stay pinned right.
      .child(h_flex().h(36).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(div().id("file-tabs").flex_1().min_w(0).h_full().relative().overflow_hidden()
          .on_size_change((size, cx) => { this.tabViewW = size.width; this.setTabOffset(this.tabOffset ?? 0); if (this.sel) this.showTab(this.sel); cx.notify(); })
          .on_scroll_wheel((ev, cx) => this.tabWheel(ev, cx))
          .when(this.mode === "changes" && !!f, (e) => e.child(div().absolute().top(0).bottom(0).left(4).flex().items_center().text_size(12).text_color(t.muted).child(f?.rel ?? "")))
          .when(this.mode !== "changes", (e) => e.child(h_flex().absolute().top(0).bottom(0).left(-(this.tabOffset ?? 0)).children(vis.map((x) => this.tab(x, t)))))
          // Position indicator, only when the tabs don't all fit.
          .when(this.tabMax() > 0, (e) => {
            const total = this.tabMax() + (this.tabViewW ?? 0), view = this.tabViewW ?? 0;
            return e.child(div().absolute().bottom(1).h(2).rounded(1).bg(t.dim)
              .left(((this.tabOffset ?? 0) / total) * view).w(Math.max(24, (view / total) * view)));
          }))
        .when(vis.length > 1 && this.mode !== "changes", (e) => e.child(div().flex_none().whitespace_nowrap().text_size(10).text_color(t.dim).px(6).child(`${vis.findIndex((x) => x.key === this.sel) + 1}/${vis.length} · ${this.kl("prevFile")}/${this.kl("nextFile")}`)))
        .when(!!f && this.nvim(), (e) => e.child(this.button("nvim", `Neovim  ${this.kl("openInNvim")}`, t.raised, (cx) => this.toNvim(f, f.hunks[this.current]?.n ?? 0, cx)).flex_none().whitespace_nowrap()))
        .when(this.dirty(f), (e) => e.child(this.button("save", `Save  ${this.kl("save")}`, t.accent + "55", (cx) => this.save(cx)).flex_none().whitespace_nowrap()))
        // Only a file with the agent's changes (an opened file's own edits aren't the agent's).
        .when(this.mode === "changes" && !!f && !f.committed, (e) => this.discardKey === f.key
          ? e.child(this.button("discard-yes", "Discard all changes to this file", t.ansi1 + "88", (cx) => this.discard(f, cx)).flex_none().whitespace_nowrap())
            .child(this.button("discard-no", "Cancel", t.raised, (cx) => { this.discardKey = null; cx.notify(); }).flex_none())
          : e.child(this.button("discard", "Discard file", t.ansi1 + "40", (cx) => { this.discardKey = f.key; cx.notify(); }).flex_none().whitespace_nowrap()))
        .when(this.mode !== "changes" && !!f && !f.plain && f.hunks.length > 0, (e) => e
          .child(this.button("reject-file", `Reject file  ${this.kl("rejectFile")}`, t.ansi1 + "40", (cx) => this.wholeFile("reject", cx)).flex_none().whitespace_nowrap())
          .child(this.button("accept-file", `Accept file  ${this.kl("acceptFile")}`, t.ansi2 + "40", (cx) => this.wholeFile("accept", cx)).flex_none().whitespace_nowrap()))
        .when(!!f, (e) => e.child(this.button("vscode", `${editorName(this.settings.externalEditor)}  ${this.kl("openInVSCode")}`, t.raised, (cx) => this.toVSCode(cx)).flex_none().whitespace_nowrap())))
      .when(!(this.mode === "edit" && this.treeOn) && !!(this.ws || this.wsBusy), (e) => e.child(this.workspacePanel(t)))
      .when(!!f && !!this.bar, (e) => e.child(this.findBar(f, t)))
      .when(!!f?.conflict, (e) => e.child(h_flex().px(12).py(6).gap(8).items_center().bg(t.ansi3 + "22").text_size(12)
        .child(div().flex_1().child(f?.conflict?.theirs ? "The agent changed the same lines you're editing." : "The file was deleted while you were editing it."))
        .child(this.button("ours", "Keep mine", t.raised, (cx) => this.resolve("ours", cx)))
        .child(this.button("theirs", f?.conflict?.theirs ? "Take agent's" : "Drop my edits", t.ansi1 + "55", (cx) => this.resolve("theirs", cx)))))
      .when(!!(this.error || this.status || !f), (e) => e.child(h_flex().px(12).py(6).gap(10).items_center().text_size(12)
        .child(div().flex_1().min_w(0).text_color(this.error || picked?.error ? t.ansi1 : t.muted).child(this.error ?? this.status ?? (picked?.error ? `${picked.rel}: ${picked.error}` : this.mode === "edit" ? `No file open: pick one in the file tree (${this.kl("toggleTree")}) or Quick Open (${this.kl("quickOpen")})` : this.mode === "changes" ? "No uncommitted changes" : "No changes to review")))
        .when(!this.stores.length && !!this.spaceId, (e) => e.child(this.button("open-folder", "Add repo…", t.raised, (cx) => this.openFolder(cx)).flex_none()))))
      .when(!!f, (e) => e.child(div().id("review-diff").flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .on_size_change((size, cx) => { this.viewH = size.height; this.viewW = size.width; cx.notify(); })
        // One character's width in the diff font, for cursor columns (the font is monospace).
        .child(div().absolute().top(0).left(0).opacity(0).whitespace_nowrap().child("0".repeat(100))
          .on_size_change((size, cx) => { const w = size.width / 100; if (w > 0 && Math.abs(w - (this.charW ?? 0)) > 0.001) { this.charW = w; cx.notify(); } }))
        .child(v_virtual_list("review-rows", rows.length, ROW, (i) => rows[i].kind === "@" ? `h${rows[i].hunk}` : `r${i}`,
          (range) => {
            // The list calls this twice a frame: once with [0, 1) to measure a row, then with
            // the visible range. Only the second says which row is on top.
            if (!(range.start === 0 && range.end === 1 && rows.length > 1)) this.drawnTop = range.start;
            return rows.slice(range.start, range.end).map((r, k) => this.row(r, f, t, lsel && range.start + k >= lsel[0] && range.start + k <= lsel[1])); })
          .w_full().h(this.viewRows() * ROW)
          .track_scroll(this.scroll))
        // Input layer over the rows (under the scrollbar and the selection bar): every click,
        // drag, right-click and wheel turn on the diff lands here and is mapped to a row.
        .child(div().id("review-input").absolute().top(0).left(0).bottom(0).right(14).cursor_text()
          .on_mouse_down("left", (ev, cx) => this.pointerDown(ev, cx))
          .on_mouse_move((ev, cx) => this.pointerMove(ev, cx))
          .on_mouse_up("left", (_e, cx) => this.pointerUp(cx))
          .on_hover((hovered, cx) => { if (!hovered) this.pointerUp(cx, false); })
          .on_mouse_down("right", (ev, cx) => this.openMenu(ev, cx))
          .on_scroll_wheel((ev, cx) => this.wheel(ev, cx)))
        .child(Scrollbar.vertical("review-rows").viewport_from_layout().absolute().inset_0())
        .when(!!sel, (e) => e.child(this.selectionBar(f, sel, t))))))))
      // Quick Open floats over everything, so it's the root's last child.
      .when(!!this.qo, (e) => e.child(this.quickOpen(t)));
  }
}
