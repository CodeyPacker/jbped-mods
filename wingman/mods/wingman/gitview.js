// G6 in the Changes view: each repo's branch, upstream and ↑/↓ counts with Fetch, Pull and Push
// (sync.js), the branch list (branches.js), Discard change (hunkdiscard.js) and Generate commit
// message (commitmsg.js). One per Changes copy (main.js initChanges: this.gitx); the logic is in
// those modules, this holds what's shown and runs the calls.
//
// Where results land: sync and branch state is kept per repo (idOf), so a push that ends after a
// space switch reports on its own repo's row. A generated message lands in the space it was asked
// for (stateOf). Nothing here runs on a timer but the local ↑/↓ reread (no network call ever runs
// unless a button or command asks for it), and only while the Changes view is shown.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, InputState, Input } from "gpui-base";
import { exec, readTextFile, appHome, writeTextFile, shared } from "herdr";
import * as fs from "fs/promises";
import { readInfo, runSync, counts, cantSync, cantPublish, fetchArgs, pullArgs, pushArgs, publishArgs, unpublishedArgs, confirmText, failMessage, oldAutostash, errorLine, fetchRemote } from "./sync.js";
import { nameProblem, checkArgs, LIST, parseBranches, switchArgs, createArgs, unsavedIn, unsavedMessage, ago } from "./branches.js";
import { cantDiscard, discardText, reviewWrites, discardQuestion, discardWhat } from "./hunkdiscard.js";
import { buildPrompt, cleanMessage, parseSubjects, newFileDiff, SUBJECT_ARGS, diffArgs } from "./commitmsg.js";
import { expand as expandCommand, usesFile, failure as runFailure, words as commandWords, DEFAULT_COMMAND, TIMEOUT_MS } from "./inlineedit.js";
import { plan as runPlan } from "./toolpath.js";
import { READ } from "./changes.js";
import { idOf } from "./remote.js";
import { chunkArgs, execOn } from "./fsx.js";
import { toWsl } from "./git.js";
import { fitBar } from "./barfit.js";
import { capSteps } from "./undocap.js";

/** Commands of this module (wingman.<name>[:arg]); main.js hands them to the Changes copy. */
export const GIT_COMMANDS = /^(fetch|pull|push|publish|syncConfirm|syncCancel|branches|branchSwitch|branchNew|branchClose|discardChange|discardChangeConfirm|discardChangeCancel|genMessage|genReplace|genKeep|genCancel)(:|$)/;
/** How often the ↑/↓ counts are reread from local refs while Changes is shown (ms). */
export const INFO_MS = 30000;
/** The "Discard change" button on a change's header row in Changes: its width, and the narrow one's. */
export const DISCARD_W = 104, DISCARD_NARROW = 62;
/** Untracked files' texts read for a generated message, in characters at most (the prompt cap cuts the rest). */
const NEW_FILES_CHARS = 60000;
/** The diff text read for a generated message, at most. */
const DIFF_CHARS = 400000;
const BROW = 24; // a branch row's height
const DIRTY = "wingman.dirty", DIRTY_FRESH = 30000; // main.js: each copy's files with unsaved edits ({ <copy id>: { keys, at } })

const base = (p) => p.split("/").pop();
const bare = (f) => Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith("_")));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const DONE = { fetch: "Fetched", pull: "Pulled", push: "Pushed", publish: "Published" };
const BUSY = { fetch: "Fetching…", pull: "Pulling…", push: "Pushing…", publish: "Publishing…", count: "Checking…" };

export class GitActions {
  /** host: the Changes copy (main.js Review). opts: { log }. */
  constructor(host, opts = {}) {
    this.host = host; this.log = opts.log ?? (() => {});
    this.repos = new Map(); // repo id -> { info, at, busy, note: { text, error }, confirm: { kind, text, args }, reading }
    this.branch = null; // the branch list: { id, st, list, more, loading, busy, note }
    this.input = InputState.new({ placeholder: "New branch name (from HEAD)" });
    this.input.on("submit", (_e, cx) => this.newBranch(this.input.value(), cx));
    this.input.on("focus", () => { host.inBar = this.input; host.treeFocus = false; });
    this.input.on("blur", () => { if (host.inBar === this.input) host.inBar = null; });
    this.ask = null; // Discard change's question: { space, key, hunk, pick, text }
    this.gens = new Map(); // space -> generate job { status: confirm|running|ask|done|error, note, draft, typed, seq, started }
    this.seq = 0;
  }

  release() { this.input?.release?.(); }

  repo(st) {
    const id = idOf(st);
    let R = this.repos.get(id);
    if (!R) { R = { info: null, at: 0, busy: null, note: null, confirm: null }; this.repos.set(id, R); }
    return R;
  }

  /** The repo a command without a name acts on: the commit box's, else the first. A name picks by folder or label. */
  repoFor(name) {
    const h = this.host, rs = h.repos();
    if (name) return rs.find((st) => base(st.root) === name || h.repoName(st) === name || st.root === name) ?? null;
    return h.commitStore() ?? rs[0] ?? null;
  }

  // ---- reading ---------------------------------------------------------------------

  /** Rereads a repo's branch, upstream and counts (local refs: two git calls, no network). */
  async read(st) {
    const R = this.repo(st);
    if (R.reading) return;
    R.reading = true;
    try { R.info = await readInfo((args) => this.host.git(st, [...READ, ...args]), await st.branch()); R.at = Date.now(); }
    catch (e) { R.note = { text: String(e.message ?? e).slice(0, 300), error: true }; R.at = Date.now(); }
    finally { R.reading = false; }
  }

  /** After the Changes lists load (HEAD or the files moved): every repo's counts again. */
  async afterLoad(cx) {
    for (const st of this.host.repos()) await this.read(st);
    this.host.paint(cx);
  }

  /** Each Changes pass: a repo not reread for INFO_MS is (a fetch from a terminal moves the counts). */
  async tick(cx) {
    let any = false;
    for (const st of this.host.repos()) if (Date.now() - this.repo(st).at > INFO_MS) { await this.read(st); any = true; }
    if (any) this.host.paint(cx);
  }

  // ---- commands ----------------------------------------------------------------------

  /** A wingman.<command> for this module, in the Changes copy that's shown. */
  command(c, cx) {
    const h = this.host;
    if (h.mode !== "changes" || !h.changesShown()) return;
    const at = c.indexOf(":"), name = at < 0 ? c : c.slice(0, at), arg = at < 0 ? null : c.slice(at + 1);
    const st = () => this.repoFor(arg);
    const go = {
      fetch: () => this.sync("fetch", st(), cx), pull: () => this.sync("pull", st(), cx),
      push: () => this.sync("push", st(), cx), publish: () => this.sync("publish", st(), cx),
      syncConfirm: () => { const s = arg ? st() : this.confirming(); if (s) this.confirm(s, cx); },
      syncCancel: () => { const s = arg ? st() : this.confirming(); if (s) { this.repo(s).confirm = null; h.paint(cx); } },
      branches: () => this.openBranches(st(), cx), branchClose: () => this.closeBranches(cx),
      branchSwitch: () => this.switchTo(arg ?? "", cx), branchNew: () => this.newBranch(arg ?? "", cx),
      discardChange: () => this.askDiscard(cx), discardChangeConfirm: () => this.discard(cx), discardChangeCancel: () => { this.ask = null; h.paint(cx); },
      genMessage: () => this.generate(cx), genReplace: () => this.takeDraft(true, cx), genKeep: () => this.takeDraft(false, cx), genCancel: () => this.cancelGen(cx),
    }[name];
    go?.();
  }

  /** The repo whose Push or Publish question is open. */
  confirming() { return this.host.repos().find((st) => this.repo(st).confirm) ?? null; }

  // ---- Fetch, Pull, Push, Publish -------------------------------------------------------

  /** A sync button: Fetch and Pull run; Push and Publish ask first. A reason shows when it can't. */
  sync(kind, st, cx) {
    const h = this.host;
    if (!st) { h.error = "No git repo here"; h.paint(cx); return; }
    const R = this.repo(st), say = (text) => { R.note = { text, error: true }; R.confirm = null; h.paint(cx); };
    if (R.busy) return say(`${BUSY[R.busy]} wait for it to end`);
    let args;
    try {
      args = kind === "fetch" ? fetchArgs(R.info) : kind === "pull" ? pullArgs(R.info) : kind === "push" ? pushArgs(R.info) : publishArgs(R.info);
    } catch (e) { return say(String(e.message ?? e)); }
    if (kind === "push") { R.confirm = { kind, args, n: R.info.ahead, text: confirmText("push", R.info) }; R.note = null; h.paint(cx); return; }
    if (kind === "publish") {
      // How many commits origin doesn't have yet (local refs), for the question.
      R.busy = "count"; h.paint(cx);
      cx.spawn(async (cx) => {
        const r = await h.git(st, [...READ, ...unpublishedArgs()]).catch(() => null);
        R.busy = null;
        const n = r?.code === 0 ? Number(String(r.stdout).trim()) || 0 : 0;
        R.confirm = { kind, args, n, text: confirmText("publish", R.info, n) }; R.note = null; h.paint(cx);
      });
      return;
    }
    this.run(st, kind, args, cx);
  }

  /**
   * The Push or Publish question's yes. The branch is read again first: when what would be sent
   * isn't what the question named (a commit made meanwhile, the upstream changed), it asks again.
   */
  confirm(st, cx) {
    const h = this.host, R = this.repo(st), c = R.confirm;
    if (!c || R.busy) return;
    R.confirm = null; R.busy = "count"; h.paint(cx);
    cx.spawn(async (cx) => {
      await this.read(st);
      let args = null, n = 0;
      try {
        args = c.kind === "push" ? pushArgs(R.info) : publishArgs(R.info);
        n = c.kind === "push" ? R.info.ahead : Number(String((await h.git(st, [...READ, ...unpublishedArgs()])).stdout).trim()) || 0;
      } catch (e) { R.busy = null; R.note = { text: String(e.message ?? e), error: true }; h.paint(cx); return; }
      R.busy = null;
      if (JSON.stringify(args) !== JSON.stringify(c.args) || n !== c.n) {
        R.confirm = { kind: c.kind, args, n, text: confirmText(c.kind, R.info, n) };
        R.note = { text: "The branch changed since you were asked: check again", error: true };
        h.paint(cx); return;
      }
      this.run(st, c.kind, args, cx);
    });
  }

  /** Runs one sync step (one per repo at a time) and rereads the counts. */
  run(st, kind, args, cx) {
    const h = this.host, R = this.repo(st), info = R.info;
    R.busy = kind; R.note = null; h.paint(cx);
    cx.spawn(async (cx) => {
      const t0 = Date.now();
      let r;
      try {
        r = await runSync(st, args);
        if (kind === "pull" && r.code !== 0 && oldAutostash(r)) r = await runSync(st, pullArgs(info, false));
      } catch (e) { r = e instanceof Error ? e : new Error(String(e?.message ?? e)); }
      const ms = Date.now() - t0, ok = !(r instanceof Error) && r.code === 0;
      this.log(`sync ${kind} in ${st.root}: ${ok ? "ok" : `failed ${r instanceof Error ? r.message : `exit ${r.code}`}`} in ${ms} ms`);
      R.busy = null;
      await this.read(st);
      if (!ok) R.note = { text: failMessage(kind, r), error: true };
      else R.note = { text: this.doneText(kind, info, R.info, r), error: false };
      if (kind === "pull" && ok) await h.loadChanges(cx); // the files moved: the lists now, not at the next poll
      h.paint(cx);
    });
  }

  doneText(kind, before, after, r) {
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    if (kind === "fetch") return `Fetched from ${fetchRemote(before) ?? "the remote"}${counts(after) ? `: ${counts(after)}` : ""}`;
    if (kind === "pull") return /up to date/i.test(out) ? "Already up to date" : `Pulled ${plural(before?.behind ?? 0, "commit")} (fast-forward)`;
    if (kind === "push") return `Pushed ${plural(before?.ahead ?? 0, "commit")} to ${before.remote}/${before.remoteRef.replace(/^refs\/heads\//, "")}`;
    return `Published ${before.branch} to origin/${before.branch}`;
  }

  // ---- branches ----------------------------------------------------------------------

  openBranches(st, cx) {
    const h = this.host;
    if (!st) return;
    if (this.branch?.id === idOf(st)) return this.closeBranches(cx);
    this.branch = { id: idOf(st), st, list: null, more: false, loading: true, busy: null, note: null };
    h.chgScroll?.scroll_to_item?.(0);
    h.paint(cx);
    this.loadBranches(cx);
  }

  closeBranches(cx) {
    this.branch = null;
    if (this.host.inBar === this.input) { this.host.inBar = null; this.host.handle.focus(); }
    this.host.paint(cx);
  }

  loadBranches(cx) {
    const b = this.branch, h = this.host;
    if (!b) return;
    cx.spawn(async (cx) => {
      try {
        const [r, cur] = await Promise.all([h.git(b.st, [...READ, ...LIST]), b.st.branch()]);
        if (r.code !== 0) throw new Error(`git for-each-ref: ${errorLine(r.stderr || r.stdout)}`);
        Object.assign(b, parseBranches(r.stdout, cur), { loading: false });
      } catch (e) { b.loading = false; b.note = { text: String(e.message ?? e), error: true }; }
      h.paint(cx);
    });
  }

  /** Files of a repo with unsaved edits in any Wingman copy (DIRTY, this copy's own included). */
  unsaved(st) {
    const h = this.host, keys = [...h.files.filter((f) => h.dirty(f)).map((f) => f.key)];
    const now = Date.now();
    for (const v of Object.values(shared(DIRTY) ?? {})) if (now - (v?.at ?? 0) <= DIRTY_FRESH) keys.push(...(v?.keys ?? []));
    return unsavedIn(st.root, keys);
  }

  /** Switches the listed repo to a branch: refused with unsaved edits; git's own refusal shows as it is. */
  switchTo(name, cx) { this.branchOp("switch", name, cx); }

  /** Makes a branch at HEAD and switches to it (nothing in the working tree changes). */
  newBranch(name, cx) { this.branchOp("new", String(name ?? "").trim(), cx); }

  branchOp(kind, name, cx) {
    const h = this.host, b = this.branch ?? (this.repoFor(null) && { id: idOf(this.repoFor(null)), st: this.repoFor(null), list: null });
    if (!b?.st) return;
    this.branch = b;
    const say = (text, error = true) => { b.note = { text, error }; h.paint(cx); };
    if (b.busy) return say(`${b.busy} wait for it to end`);
    const why = nameProblem(name);
    if (why) return say(why);
    if (kind === "switch") {
      const held = this.unsaved(b.st);
      if (held.length) return say(unsavedMessage(held));
    }
    b.busy = kind === "switch" ? `Switching to ${name}…` : `Making ${name}…`; b.note = null; h.paint(cx);
    const st = b.st;
    cx.spawn(async (cx) => {
      try {
        // git checks the name too, the way it reads a branch name (only names Wingman passed get here).
        const chk = await h.git(st, checkArgs(name));
        if (chk.code !== 0) throw new Error(`${errorLine(chk.stderr || chk.stdout) || "not a valid branch name"}`);
        const r = await h.git(st, kind === "switch" ? switchArgs(name) : createArgs(name), { timeout: 60000 });
        if (r.code !== 0) throw new Error(errorLine(r.stderr || r.stdout) || `git switch exited with ${r.code}`);
        b.busy = null;
        this.repo(st).note = { text: kind === "switch" ? `Switched to ${name}` : `Made ${name} at HEAD and switched to it`, error: false };
        if (kind === "new") this.input.set_value("");
        if (this.branch === b) this.branch = null;
        await this.read(st);
        await h.loadChanges(cx);
      } catch (e) { b.busy = null; b.note = { text: `git: ${String(e.message ?? e)}`, error: true }; }
      h.paint(cx);
    });
  }

  // ---- Discard change ------------------------------------------------------------------

  /** The change (or the selected changed lines) Discard change acts on, and its question. */
  askDiscard(cx, hunk = null) {
    const h = this.host, f = h.file();
    const fail = (m) => { h.error = m; h.paint(cx); };
    const why = cantDiscard(f);
    if (why) return fail(why);
    if (hunk != null) h.current = hunk;
    const sel = h.selection(f), p = sel ? h.picks(f, sel) : null;
    if (p && !p.any) return fail("The selection has no changed lines");
    const pick = p?.pick ?? null;
    this.ask = { space: h.spaceId, key: f.key, hunk: h.current, pick, text: discardQuestion(f, h.current, pick) };
    h.error = null; h.paint(cx);
  }

  /**
   * Discard change, confirmed: the lines go back as HEAD has them, compare-and-swap. A file under
   * review is written as a save of the user's edit (hunkdiscard.reviewWrites). One undo step in this
   * copy's history (ctrl-z here puts the lines back, compare-and-swap too).
   */
  discard(cx) {
    const h = this.host, a = this.ask;
    this.ask = null;
    const f = h.file();
    if (!a || !f || a.space !== h.spaceId || f.key !== a.key) { h.paint(cx); return; }
    const fail = (m) => { h.error = m; h.paint(cx); };
    const why = cantDiscard(f);
    if (why) return fail(why);
    if (h.heldElsewhere([f.key]).length) return fail(`${base(f.rel)} has unsaved edits in Edit: save or discard them there first`);
    let after;
    try { after = discardText(f, a.hunk, a.pick); } catch (e) { return fail(String(e.message ?? e)); }
    const st = f.store, before = f.Ctext, space = h.spaceId, what = discardWhat(f, a.hunk, a.pick);
    if (after === before) return fail("Nothing to discard there");
    const entry = { snaps: [bare(f)], writes: [], feedback: [] };
    h.history.push(entry); h.redo = []; capSteps(h.history);
    h.selA = h.selB = null; h.anchor = null; h.error = null;
    h.enqueue(async () => {
      const e = (await st.index())[f.rel];
      let target = f, writes = [{ target: "current", before, after }];
      if (e) { target = await st.load(f.rel, e); writes = reviewWrites(target, before, after); }
      const applied = [];
      try { for (const w of writes) applied.push(await st.apply(target, w)); }
      catch (err) { if (applied.length) await st.undo(applied).catch(() => {}); throw err; } // file and baseline go together
      entry.writes.push(...applied);
      if (e) await h.sendEditNotes(writes.map((w) => h.editNote(target, w)).filter(Boolean)).catch(() => {});
      const s = h.stateOf(space);
      if (s) s.commitNote = `Discarded ${what} in ${f.rel}`;
    }, cx, space);
    const queued = h.queue;
    cx.spawn(async (cx) => { await queued; if (h.spaceId === space) await h.loadChanges(cx); h.paint(cx); });
    h.paint(cx);
  }

  /** The question bar over the diff while Discard change asks. */
  askBar(t) {
    const h = this.host, a = this.ask;
    if (!a || a.space !== h.spaceId || h.sel !== a.key) return null;
    return h_flex().id("discard-change-ask").flex_none().px(12).py(6).gap(8).items_center().bg(t.ansi1 + "1c").border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_1().min_w(0).child(a.text))
      .child(h.button("discard-change-yes", "Discard", t.ansi1 + "88", (cx) => this.discard(cx)).flex_none())
      .child(h.button("discard-change-no", "Cancel", t.raised, (cx) => { this.ask = null; h.paint(cx); }).flex_none());
  }

  /** The "Discard change" button's width on a change's header row, for the diff's width now. */
  discardW() {
    const w = this.host.px(this.host.viewW ?? 0);
    if (!(w > 0) || w >= 58 + DISCARD_W + 140) return DISCARD_W;
    return w >= 58 + DISCARD_NARROW + 20 ? DISCARD_NARROW : 0;
  }

  /** A change's header row in Changes: the Discard change button, then "change n of m". */
  hunkRow(r, f, t, ROW, GUTTER, GAP) {
    const w = this.discardW(), asked = this.ask && this.ask.key === f.key && this.ask.hunk === r.hunk && !this.ask.pick;
    return h_flex().w_full().h(ROW).flex_none().gap(GAP).items_center().bg(t.raised)
      .child(div().w(GUTTER).flex_none())
      .when(w > 0, (e) => e.child(div().w(w).flex_none().h(16).rounded(4).flex().items_center().justify_center().bg(t.ansi1 + (asked ? "99" : "40")).text_size(11).whitespace_nowrap()
        .child(w === DISCARD_W ? "Discard change" : "Discard")))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).text_size(11).child(`change ${r.hunk + 1} of ${f.hunks.length}`));
  }

  /** A press on a change's header row in Changes at x: on the button, Discard change asks; anywhere, the change becomes current. */
  hunkClick(hunk, x, GUTTER, GAP, cx) {
    const w = this.discardW();
    this.host.current = hunk;
    if (w > 0 && x >= GUTTER + GAP && x < GUTTER + GAP + w) { this.host.selA = this.host.selB = null; this.askDiscard(cx, hunk); }
    else this.host.paint(cx);
  }

  // ---- Generate commit message -------------------------------------------------------

  genOf(space = this.host.spaceId) { return this.gens.get(space) ?? null; }

  /** Generate: replaces an empty box; with a message typed, asks first. */
  generate(cx) {
    const h = this.host, space = h.spaceId, st = h.commitStore(), g = this.genOf(space);
    if (g?.status === "running") return;
    const say = (note) => { this.gens.set(space, { status: "error", note }); h.paint(cx); };
    if (!st) return say("No uncommitted changes to describe");
    const files = h.checkedIn(st);
    if (!files.length) return say("Check the files to describe");
    const typed = h.commitInput?.value() ?? "";
    if (typed.trim() && g?.status !== "confirm") {
      this.gens.set(space, { status: "confirm", note: "Replace your message with a generated draft?" });
      h.paint(cx); return;
    }
    const template = String(h.settings.inlineCommand ?? "").trim() || DEFAULT_COMMAND, name = commandWords(template)[0] ?? "the command";
    const job = { status: "running", started: Date.now(), seq: ++this.seq, typed, name, note: null };
    this.gens.set(space, job);
    h.paint(cx);
    cx.spawn(async (cx) => this.runGen(st, files, space, job, template, cx));
  }

  cancelGen(cx) {
    const g = this.genOf();
    if (g) { g.seq = -1; this.gens.delete(this.host.spaceId); }
    this.host.paint(cx);
  }

  /** The checked files' diff against HEAD (tracked files from git, new ones from their text), capped. */
  async diffOf(st, files, hasHead) {
    const h = this.host, tracked = hasHead ? files.filter((f) => f.xy !== "??").map((f) => f.rel) : [];
    let diff = "";
    for (const run of chunkArgs(tracked, 28000 - st.root.length * 2)) {
      if (diff.length >= DIFF_CHARS) break;
      const r = await h.git(st, [...READ, ...diffArgs(run)], { timeout: 60000 });
      if (r.code !== 0) throw new Error(`git diff: ${errorLine(r.stderr || r.stdout)}`);
      diff += r.stdout.slice(0, DIFF_CHARS - diff.length);
    }
    let added = 0;
    for (const f of hasHead ? files.filter((x) => x.xy === "??") : files) {
      if (added >= NEW_FILES_CHARS || f.error === "binary file") continue;
      const text = await readTextFile(f.path, { on: st.on ?? null }).catch(() => null);
      if (typeof text !== "string" || text.includes("\0")) continue;
      const d = newFileDiff(f.rel, text.slice(0, NEW_FILES_CHARS - added));
      diff += d; added += d.length;
    }
    return diff;
  }

  async runGen(st, files, space, job, template, cx) {
    const h = this.host, live = () => this.gens.get(space) === job && job.seq > 0;
    let tmp = null, r, ms = 0;
    try {
      const head = await st.head();
      const [diff, subj] = await Promise.all([this.diffOf(st, files, !!head), head ? h.git(st, [...READ, ...SUBJECT_ARGS]) : null]);
      const prompt = buildPrompt({ repo: h.repoName(st), files: files.map((f) => ({ rel: f.rel, letter: f.letter, add: f.add, del: f.del, binary: f.error === "binary file" })), diff, subjects: subj?.code === 0 ? parseSubjects(subj.stdout) : [] });
      // The inline edit command's runner, as runInline uses it: where (this computer, WSL, the machine), {promptFile}.
      const where = await h.inlineWhere(st, job.name);
      if (usesFile(template)) {
        if (where.on) throw new Error("{promptFile} works only for files on this computer: use {prompt}");
        const dir = `${appHome()}/data/wingman`;
        await fs.mkdir(dir, { recursive: true }).catch(() => {});
        tmp = `${dir}/inline-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.txt`;
        await writeTextFile(tmp, prompt, null);
      }
      const p = runPlan(expandCommand(template, { prompt, promptFile: tmp && (where.how === "wsl" ? toWsl(tmp) : tmp) }), where);
      const t0 = Date.now();
      r = await (p.opts.on ? execOn(p.cmd, p.args, p.opts) : exec(p.cmd, p.args, p.opts));
      ms = Date.now() - t0;
      this.log(`commit message: ${prompt.length} chars to ${job.name}, exit ${r.code}, ${r.stdout?.length ?? 0} chars back in ${ms} ms`);
    } catch (e) { r = e instanceof Error ? e : new Error(String(e?.message ?? e)); this.log(`commit message: ${r.message}`); }
    finally { if (tmp) await fs.unlink(tmp).catch(() => {}); }
    if (!live()) return;
    const why = runFailure(r, { name: job.name, elapsed: ms, timeout: TIMEOUT_MS });
    const draft = why ? null : cleanMessage(r.stdout);
    if (!draft) { Object.assign(job, { status: "error", note: why ?? `${job.name} gave no answer` }); h.paint(cx); return; }
    job.draft = draft; job.ms = ms;
    // The box as it is now, in the job's own space (shown or kept).
    const shown = h.spaceId === space, s = h.stateOf(space);
    const now = shown ? h.commitInput.value() : s?.commitMsg ?? "";
    if (!now.trim() || now === job.typed) this.put(space, job, cx);
    else { job.status = "ask"; job.note = "You typed while it ran: replace your message with the draft?"; h.paint(cx); }
  }

  /** Puts the job's draft in its space's commit box. */
  put(space, job, cx) {
    const h = this.host, s = h.stateOf(space);
    if (h.spaceId === space) h.commitInput.set_value(job.draft); else if (s) s.commitMsg = job.draft;
    job.status = "done"; job.note = `Draft from ${job.name} in ${(job.ms / 1000).toFixed(1)} s: edit it, then Commit`;
    h.paint(cx);
  }

  /** The replace question's answers (before running: Generate; after: Replace / Keep mine). */
  takeDraft(yes, cx) {
    const space = this.host.spaceId, g = this.genOf(space);
    if (!g) return;
    if (g.status === "confirm") { if (yes) this.generate(cx); else { this.gens.delete(space); this.host.paint(cx); } return; }
    if (g.status !== "ask") return;
    if (yes) this.put(space, g, cx); else { g.status = "done"; g.note = "Kept your message"; this.host.paint(cx); }
  }

  // ---- drawing (inside renderChanges' 320 px column) ------------------------------------

  /** Every repo's sync rows, at the top of the Changes column. */
  syncRows(t, multi) {
    const h = this.host;
    return h.repos().map((st) => this.syncRow(st, t, multi));
  }

  syncRow(st, t, multi) {
    const h = this.host, id = idOf(st), R = this.repo(st), i = R.info;
    const label = !i ? "…" : i.detached ? (i.branch ? `detached ${i.branch.slice(1, 8)}` : "no commits") : i.branch;
    const ab = counts(i), push = !i || i.detached || i.upstream && !i.gone ? "push" : "publish";
    const busy = R.busy && R.busy !== "count" ? BUSY[R.busy] : null;
    const items = [
      { id: "fetch", labels: ["Fetch"], drop: Infinity },
      { id: "pull", labels: [i?.behind ? `Pull ↓${i.behind}` : "Pull", "Pull"], drop: Infinity },
      push === "push" ? { id: "push", labels: [i?.ahead ? `Push ↑${i.ahead}` : "Push", "Push"], drop: Infinity } : { id: "publish", labels: ["Publish branch", "Publish"], drop: Infinity },
    ].map((x) => ({ ...x, size: 11, pad: 20 }));
    const fit = fitBar(304, items, busy ? 90 : 0, 6);
    const can = { fetch: !!fetchRemote(i), pull: !cantSync(i, "pull"), push: !cantSync(i, "push"), publish: !cantPublish(i) };
    const hot = (k) => (k === "push" && i?.ahead > 0 && can.push) || (k === "pull" && i?.behind > 0 && can.pull) || (k === "publish" && can.publish);
    const btn = (k) => h.button(`sync-${k}-${id}`, fit.get(k), hot(k) ? t.accent + "88" : t.raised, (cx) => this.sync(k, st, cx))
      .flex_none().whitespace_nowrap().when(!can[k] || !!R.busy, (e) => e.opacity(0.5));
    return v_flex().id(`sync-${id}`).flex_none().px(8).py(5).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().h(22).gap(6).items_center()
        .child(div().id(`branch-${id}`).h(22).px(6).flex().items_center().gap(4).rounded(5).cursor_pointer().bg(this.branch?.id === id ? t.selected : t.raised)
          .flex_shrink(1).min_w(0).text_size(11.5).hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => { h.handle?.focus(); this.openBranches(st, cx); })
          .child(div().flex_none().text_color(t.dim).child("⎇"))
          .child(div().min_w(0).truncate().child(`${multi ? `${h.repoName(st)} · ` : ""}${label}`))
          .child(div().flex_none().text_size(10).text_color(t.dim).child("▾")))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
          .child(!i ? "" : i.upstream ? `→ ${i.upstream}${i.gone ? " (gone)" : ""}` : i.detached ? "" : "no upstream"))
        .when(!!ab, (e) => e.child(div().flex_none().text_size(11.5).font_semibold().text_color(t.accent).child(ab))))
      .when(!!R.confirm, (e) => e.child(v_flex().gap(4).p(6).rounded(5).bg(t.accent + "1c")
        .child(div().text_size(11.5).child(R.confirm.text))
        .child(h_flex().gap(6)
          .child(h.button(`sync-yes-${id}`, R.confirm.kind === "publish" ? "Publish" : "Push", t.accent + "88", (cx) => this.confirm(st, cx)).flex_none())
          .child(h.button(`sync-no-${id}`, "Cancel", t.raised, (cx) => { R.confirm = null; h.paint(cx); }).flex_none()))))
      .when(!R.confirm, (e) => e.child(h_flex().h(22).gap(6).items_center()
        .children(["fetch", "pull", push].filter((k) => fit.has(k)).map(btn))
        .when(!!busy, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(busy)))))
      .when(!!R.note, (e) => e.child(div().text_size(11).text_color(R.note.error ? t.ansi1 : t.dim).child(R.note.text)));
  }

  /** Whether the branch list replaces the file list (its repo is in the shown space). */
  branchOpen() { return !!this.branch && this.host.repos().includes(this.branch.st); }

  /** The branch list, in place of the file list: New branch, then the branches (current first). */
  branchPanel(t) {
    const h = this.host, b = this.branch, list = b.list ?? [];
    const rows = list.map((x) => ({ key: `br|${x.name}`, x }));
    const row = (r) => h_flex().w_full().h(BROW).px(10).gap(8).items_center().cursor_pointer().text_size(12)
      .when(r.x.current, (e) => e.bg(t.selected))
      .child(div().w(12).flex_none().text_color(t.accent).child(r.x.current ? "✓" : ""))
      .child(div().flex_1().min_w(0).truncate().child(r.x.name))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(ago(r.x.at)));
    return v_flex().id("branch-panel").flex_1().min_h(0)
      .child(h_flex().h(30).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(`Branches · ${h.repoName(b.st)}${b.more ? " (newest 200)" : ""}`))
        .child(h.button("branch-close", "×", t.raised, (cx) => this.closeBranches(cx)).flex_none()))
      .child(h_flex().flex_none().px(8).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(12).child(Input.new(this.input)))
        .child(h.button("branch-new", "Create", t.accent + "55", (cx) => this.newBranch(this.input.value(), cx)).flex_none()))
      .when(!!b.busy || !!b.note || b.loading, (e) => e.child(div().flex_none().px(10).py(4).text_size(11)
        .text_color(b.note?.error ? t.ansi1 : t.muted).child(b.busy ?? b.note?.text ?? "Loading branches…")))
      .child(div().id("branch-list").flex_1().min_h(0).relative().overflow_hidden()
        .when(rows.length > 0, (e) => e
          .child(v_virtual_list("branch-rows", rows.length, BROW, (i) => rows[i].key, (range) => rows.slice(range.start, range.end).map(row))
            .w_full().h(Math.max(BROW, (h.chgH ?? 300) - 80)).track_scroll(h.chgScroll)
            .on_item_click((key, cx) => { const x = list.find((y) => `br|${y.name}` === key); if (x && !x.current) this.switchTo(x.name, cx); }))
          .child(Scrollbar.vertical("branch-rows").viewport_from_layout().absolute().inset_0())));
  }

  /** The row above the commit message box: Generate, and what it's doing. */
  genRow(t) {
    const h = this.host, g = this.genOf(), running = g?.status === "running";
    const secs = running ? Math.max(0, Math.floor((Date.now() - g.started) / 1000)) : 0;
    const ask = g?.status === "confirm" || g?.status === "ask";
    return v_flex().flex_none().gap(4)
      .child(h_flex().h(22).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(running ? t.muted : t.dim)
          .child(running ? `Writing a message… ${secs} s (the diff goes to ${g.name})` : "Commit message"))
        .when(!running && !ask, (e) => e.child(h.button("gen-message", "Generate", t.ansi4 + "40", (cx) => this.generate(cx)).flex_none().whitespace_nowrap()))
        .when(running, (e) => e.child(h.button("gen-cancel", "Cancel", t.ansi1 + "40", (cx) => this.cancelGen(cx)).flex_none())))
      .when(ask, (e) => e.child(v_flex().gap(4).p(6).rounded(5).bg(t.ansi4 + "1c")
        .child(div().text_size(11.5).child(g.note))
        .when(g.status === "confirm", (e) => e.child(div().text_size(10.5).text_color(t.dim).child("The checked files' diff is sent to the inline edit command (Settings).")))
        .child(h_flex().gap(6)
          .child(h.button("gen-yes", g.status === "confirm" ? "Generate" : "Replace", t.ansi4 + "66", (cx) => this.takeDraft(true, cx)).flex_none())
          .child(h.button("gen-no", g.status === "confirm" ? "Cancel" : "Keep mine", t.raised, (cx) => this.takeDraft(false, cx)).flex_none()))))
      .when(!!g?.note && !ask, (e) => e.child(div().text_size(11).text_color(g.status === "error" ? t.ansi1 : t.dim).child(g.note)));
  }

  /** Whether a generate job of the shown space is running (its seconds redraw). */
  running() { return this.genOf()?.status === "running" || [...this.repos.values()].some((R) => R.busy); }
}
