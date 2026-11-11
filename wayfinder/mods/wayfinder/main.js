// Wayfinder: one Profile's Boards and Pull Requests, in the layout's side panel beside Wingman
// (a "wayfinder" block in the "panel-body" stack; the tab bar's Wayfinder button shows it).
// Fullscreen hides the "main" block and stretches the panel; tabs-plus undoes it when Wayfinder
// stops showing. Esc closes the Ticket detail panel, then leaves fullscreen.
// Board data comes from the cache at once, then refreshes in the background on show and every
// 30 minutes while shown. Nothing runs while hidden (D25).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { run, layout, shared, setShared, theme, appHome, readTextFile, writeTextFile, nextCommand, notify, spaces, pickFolder, window as herdrWindow } from "herdr";
import { parseConfig, defaultRunner } from "./config.js";
import { createRunner } from "./runner.js";
import { loadBoard, loadTicket, loadPullRequests, signInStates, discoverBoards, discoverRepos, loadImages, IMAGE_MD, existingWorktrees, makeLaunchWorktrees, makeReviewWorktree, loadReviewInfo, moveTicket, updateTicket, commentOnTicket, boardStatuses, providerFor, renameProfileData } from "./flow.js";
import * as edits from "./settings.js";
import { DEFAULT_LAUNCH, DEFAULT_REVIEW, resolveTemplate, agentArgv, launchPrompt, reviewPrompt, ticketFolder, reviewFolder, slug, repoName, spaceArgv, launchSpaceName, reviewSpaceName } from "./launch.js";
import { shellInvocation } from "./command.js";
import { byColumn, byRepo, initials, trackColumns, can, repoFilter, moveTarget } from "./providers/contract.js";
import { cacheFile, parseCache, serializeCache, cachedBoard, withBoard, cachedPrs, withPrs, prsKey, formatAge, isShown, due } from "./cache.js";

const VIEW_KEY = "wayfinder.view.v1";
const COLUMN_W = 280, PANEL_W = 460;
const IMAGE_DIR = "data/wayfinder-images"; // under Herdr's home: image() reads from there
const FULL_KEY = "wayfinder.fullscreen"; // { px }: the panel's width before fullscreen
const WANT_FULL_KEY = "wayfinder.wantFullscreen"; // the last fullscreen choice, kept across Close
const SITE = { github: "GitHub", azure: "Azure" }; // for the Board's "View in …" link

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}
const configPath = () => `${appHome()}/data/wayfinder.json`;

const EXAMPLE = `{
  "activeProfile": "work",
  "profiles": {
    "work": {
      "runner": "wsl:Ubuntu",
      "accounts": [{ "id": "gh-work", "provider": "github", "login": "<gh user>" }],
      "repos": [],
      "boards": [{ "id": "team", "account": "gh-work", "ref": { "owner": "<user or org>", "number": 1 } }]
    }
  }
}`;

const stop = (_e, cx) => cx.stop_propagation();
// localStorage holds per-viewer niceties only; it can be missing, so every access is guarded.
// Remembered view state lives in Herdr's shared state: saved across restarts and the same for every
// copy (localStorage is per copy, so a Wayfinder in another space or layout started blank). A value
// only localStorage has is still read.
const load = (k, fallback) => {
  const v = shared(k);
  if (v != null) return v;
  try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
};
const save = (k, v) => setShared(k, v);

// A header action as an icon, like Herdr's pane actions. `on` marks the one that is open.
function iconButton(id, icon, t, onClick, { on = false } = {}) {
  return div().id(id).p(4).flex_none().rounded(4).cursor_pointer()
    .text_color(on ? t.foreground : t.dim).when(on, (el) => el.bg(t.hover))
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", stop).on_click((_e, cx) => onClick(cx))
    .child(svg(`mods/wayfinder/icons/${icon}.svg`).size(14));
}

function button(id, label, t, onClick, { on = false } = {}) {
  return h_flex().id(id).h(26).px(10).flex_none().items_center().rounded(6)
    .text_size(12).text_color(on ? t.foreground : t.muted).bg(on ? t.selected : t.background).cursor_pointer()
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", stop).on_click((_e, cx) => onClick(cx))
    .child(label);
}

function segmented(id, options, value, t, onPick) {
  return h_flex().id(id).p(2).gap(2).rounded(8).bg(t.chrome).border_1().border_color(t.border).children(options.map(([key, label]) => {
    const on = key === value;
    return h_flex().id(`${id}-${key}`).h(24).px(12).items_center().rounded(6)
      .bg(on ? t.raised : t.chrome).text_size(12).text_color(on ? t.foreground : t.muted).when(on, (el) => el.font_semibold())
      .cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => onPick(key, cx))
      .child(div().truncate().child(label));
  }));
}

function checkRow(id, on, label, t, onClick) {
  return h_flex().id(id).flex_1().min_w(0).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => onClick(cx))
    .child(h_flex().w(14).h(14).flex_none().justify_center().items_center().rounded(3).border_1()
      .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background).text_size(10).text_color(t.background).when(on, (el) => el.child("✓")))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(label));
}

// The wrapper keeps the click from reaching the root, whose mouse-down would take the focus back.
const FOLD_PARTS = ["", "boards", "repos", "repos.others"];
const field = (state, t, w = 260) => div().on_mouse_down("left", stop)
  .child(Input.new(state).w(w).h(28).px(8).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground));

// Markdown link text: brackets would end the link early.
const linkText = (s) => String(s ?? "").replace(/([[\]\\])/g, "\\$1");
const link = (label, url) => url ? `[${linkText(label)}](<${url}>)` : linkText(label);

// `cursor`: the card the arrow keys are on (#20).
function card(tk, t, selected, onClick, cursor = false) {
  return v_flex().id(`wf-card-${tk.key}`).gap(6).p(10).rounded(8).bg(cursor ? t.hover : t.surface).border_1().border_color(selected ? t.accent : cursor ? t.foreground : t.border)
    .cursor_pointer().hover((s) => s.border_color(selected ? t.accent : t.input))
    .on_mouse_down("left", stop).on_click((_e, cx) => onClick(cx))
    .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
      .child(div().child(tk.id)).child(div().child("·")).child(div().truncate().child(tk.type)))
    .child(div().text_size(13).text_color(t.foreground).child(tk.title))
    .when(Boolean(tk.priority) || tk.assignees.length > 0, (el) => el.child(h_flex().gap(4).items_center()
      .when(Boolean(tk.priority), (r) => r.child(h_flex().h(18).px(6).items_center().rounded(9).bg(t.selected).text_size(11).text_color(t.muted).child(tk.priority)))
      .child(div().flex_1())
      .children(tk.assignees.slice(0, 3).map((a) => h_flex().id(`wf-a-${tk.key}-${a.id}`).w(20).h(20).flex_none().justify_center().items_center()
        .rounded(10).bg(t.raised).border_1().border_color(t.border).text_size(9).font_semibold().text_color(t.muted).child(initials(a.name))))));
}

const prAge = (pr) => pr.updatedAt ? ` · updated ${formatAge(Date.now() - Date.parse(pr.updatedAt))}`
  : pr.createdAt ? ` · opened ${formatAge(Date.now() - Date.parse(pr.createdAt))}` : "";

function prRow(pr, t, review = null) {
  return h_flex().id(`wf-pr-${pr.key}`).gap(12).px(12).py(8).items_center().border_t(1).border_color(t.border)
    .child(v_flex().flex_1().min_w(0).gap(4)
      .child(h_flex().gap(8).items_center().min_w(0)
        .when(pr.draft, (el) => el.child(h_flex().h(18).px(6).flex_none().items_center().rounded(9).bg(t.selected).text_size(11).text_color(t.muted).child("Draft")))
        .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(pr.title)))
      .child(div().text_size(11).text_color(t.dim).truncate()
        .child(`${pr.id} · ${pr.author.name}${prAge(pr)}`)))
    .when(Boolean(review?.state?.status === "error"), (el) => el.child(div().max_w(260).flex_none().text_size(11).text_color(t.blocked).child(review.state.error)))
    .when(Boolean(review), (el) => el.child(button(`wf-pr-review-${pr.key}`, review.state?.status === "busy" ? (review.state.message ?? "Starting…") : "Review", t,
      (cx) => review.start(cx), { on: review.state?.status === "busy" })))
    .when(Boolean(pr.url), (el) => el.child(div().flex_none().text_size(12).child(TextView.markdown(`wf-pr-open-${pr.key}`, link("Open in browser", pr.url)))));
}

// Loading placeholders: grey bars in the shape of what's coming, pulsing (native animation, no timer).
const bar = (t, w, h = 10) => div().w(w).h(h).flex_none().rounded(4).bg(t.raised);
const pulse = (el) => el.loop("opacity", { from: 0.45, to: 1, period: 1400 });

function skeletonColumns(t) {
  return pulse(h_flex().id("wf-columns-skeleton").size_full().min_w(0).min_h(0).px(16).pb(16).gap(12).items_start().overflow_hidden()
    .children([3, 2, 4, 1].map((n, i) => v_flex().id(`wf-col-skel-${i}`).w(COLUMN_W).flex_none().rounded(10).bg(t.chrome).border_1().border_color(t.border)
      .child(h_flex().h(36).px(12).gap(8).flex_none().items_center().child(bar(t, 80, 12)).child(bar(t, 14)))
      .child(v_flex().px(8).pb(8).gap(8).children(Array.from({ length: n }, (_, j) =>
        v_flex().gap(8).p(10).rounded(8).bg(t.surface).border_1().border_color(t.border)
          .child(bar(t, 70, 9)).child(bar(t, (i + j) % 2 ? 210 : 230, 12)).child(bar(t, (i + j) % 2 ? 120 : 160, 12))))))));
}

function skeletonTicket(t) {
  const row = (w) => h_flex().gap(8).items_center().child(div().w(84).flex_none().child(bar(t, 56))).child(bar(t, w));
  return pulse(v_flex().gap(10)
    .child(v_flex().gap(8).child(row(90)).child(row(140)).child(row(70)).child(row(40)).child(row(180)))
    .child(bar(t, 96, 12))
    .child(div().pt(8).child(bar(t, 80, 9)))
    .child(v_flex().gap(8).children([380, 400, 340, 0, 360, 300, 390, 220].map((w) => w ? bar(t, w, 11) : div().h(4))))
    .child(div().pt(8).child(bar(t, 110, 9)))
    .child(v_flex().gap(8).p(10).rounded(8).bg(t.surface).border_1().border_color(t.border)
      .child(bar(t, 120, 9)).child(bar(t, 360, 11)).child(bar(t, 240, 11))));
}

export default class Wayfinder extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.view = ["prs", "settings"].includes(load(VIEW_KEY, "board")) ? load(VIEW_KEY, "board") : "board";
    this.state = { status: "loading" };
    this.checks = null;
    this.boards = {}; // board id -> { status: "cached" | "loading" | "ok" | "error", data, at, tried, error }
    this.hidden = true; // until seen on screen: the first show refreshes
    this.lastRefresh = null;
    this.selected = null; // { boardId, summary }: the Ticket in the detail panel
    this.tickets = {}; // ticket key -> { status, data, error }
    this.images = {}; // image url -> { status, file, error }: saved files stay across reloads
    this.launch = null; // the Launch dialog: { key, selected: repo ids, exists: names | null, status, error, message }
    this.reviews = {}; // pr key -> { status: "busy" | "error", message, error }
    this.editing = null; // the title being edited: { key, input, status, error }
    this.commentBox = TextareaState.new({ placeholder: "Write a comment (markdown)", rows: 3 });
    this.commentBox.set_auto_grow(3, 10);
    this.commentBox.on("focus", () => { this.typing = true; });
    this.commentBox.on("blur", () => { this.typing = false; });
    this.commenting = null; // { key, status, error }
    this.prs = null; // { status, data: loadPullRequests()'s list, at, tried, error }
    this.found = {}; // settings: account id -> { boards: { status, data, error }, repos: { ... } }
    this.statusLists = {}; // settings: board id -> { status, data, error }
    this.statusOpen = null; // settings: the board id whose statuses are shown
    this.confirm = null; // settings: the remove button waiting for a second click
    this.settingsError = null;
    this.inputs = {
      profile: InputState.new({ placeholder: "new profile name" }),
      gh: InputState.new({ placeholder: "GitHub user name" }),
      ado: InputState.new({ placeholder: "https://dev.azure.com/<org>" }),
      boards: {}, // account id -> InputState: each list's search
      repos: {},
    };
    this.renaming = null; // { name, input }: the Profile being renamed
    this.reload(cx);
    // Reads the layout only (due() gates requests), often enough that a show from anywhere is noticed.
    // Redraws on a show, and once a minute while shown (the "Updated" age).
    let drawn = 0;
    cx.timer.every(2_000, (cx) => {
      const was = this.hidden;
      if (this.watch(cx) && (was || Date.now() - drawn >= 60_000)) { drawn = Date.now(); cx.notify(); }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).replace(/^wayfinder\./, "");
        if (c === "focus") this.handle.focus();
        else if (c === "close") this.close_();
        else if (c === "fullscreen") this.setFullscreen(!this.fullscreen);
        else if (c === "refresh") this.reload(cx);
        else if (c === "profile") await this.nextProfile(cx);
        cx.notify();
      }
    });
  }

  get fullscreen() { return Boolean(shared(FULL_KEY)); }

  // `remember` false leaves the wish as it was: Close leaves fullscreen but the next show goes back.
  setFullscreen(on, { remember = true } = {}) {
    if (remember) save(WANT_FULL_KEY, on ? "1" : "0");
    const full = shared(FULL_KEY);
    if (on && !full) {
      const px = findNode(layout(), "panel")?.size?.px;
      setShared(FULL_KEY, { px: typeof px === "number" ? px : null });
      run("layout.hide", { id: "main" });
      run("layout.resize", { id: "panel", weight: 1 });
    } else if (!on && full) {
      setShared(FULL_KEY, null);
      run("layout.show", { id: "main" });
      run("layout.resize", { id: "panel", px: full.px ?? 960 });
    }
  }

  // Hidden from now: the next show is noticed at once (it refreshes, and goes back to fullscreen).
  close_() { this.setFullscreen(false, { remember: false }); run("layout.hide", { id: "panel" }); this.hidden = true; }

  shownNow() { return isShown(layout(), (n) => n.content?.mod === "wayfinder"); }

  // Refreshes on show and every POLL_MS while shown. Never while hidden (D25). True when shown.
  watch(cx) {
    if (!this.shownNow()) { this.hidden = true; return false; }
    const showing = this.hidden;
    this.hidden = false;
    if (this.profile && due(this.lastRefresh, Date.now(), { showing })) this.refresh(cx);
    return true;
  }

  // Sign-in states and the shown view's data: the selected Board (or the CLI checks without one) or the
  // Pull Requests. Plus a Ticket a reload left open.
  refresh(cx) {
    this.lastRefresh = Date.now();
    this.checkSignIn(cx);
    if (this.view === "settings") this.loadSettings(cx, true);
    else if (this.view === "prs") this.fetchPrs(cx);
    else if (this.board) this.fetchBoard(this.board, cx);
    else cx.spawn((cx) => this.check(cx));
    if (this.fetchTicketLater) { this.fetchTicketLater = false; this.fetchTicket(cx); }
  }

  // What a Provider gets: the runner, fetch, and the Profile's name (Azure keeps an az login per Profile).
  io() { return { run: this.state.runner.run, fetch, profile: this.profile.name }; }

  get profile() { return this.state.status === "ok" ? this.state.profile : null; }

  // The selected Board's config: the remembered one, else the first.
  get board() {
    const p = this.profile;
    if (!p || p.boards.length === 0) return null;
    const id = load(`wayfinder.board.${p.name}`, null);
    return p.boards.find((b) => b.id === id) ?? p.boards[0];
  }

  mineKey(b) { return `wayfinder.mine.${this.profile.name}.${b.id}`; }

  // The Board's Columns as shown: Tracked Statuses or the Provider's, with the Mine filter.
  columnsOf(b, data) {
    const mine = load(this.mineKey(b), "0") === "1";
    return byColumn(b.trackedStatuses?.length ? trackColumns(data, b.trackedStatuses) : data, { mine });
  }

  // Arrow keys move between cards and Columns (#20). Enter opens the card, and while the detail panel
  // is open it follows the cursor. True when the key was used.
  boardKey(key, cx, shift = false) {
    const b = this.board, data = b && this.boards[b.id]?.data;
    if (this.view !== "board" || !data) return false;
    const cols = this.columnsOf(b, data);
    if (!cols.length) return false;
    let c = this.cursor?.board === b.id ? { ...this.cursor } : null;
    // Shift with left or right moves the card under the cursor one Column over (#15).
    if (c && shift && (key === "left" || key === "right")) {
      const tk = cols[c.col]?.tickets[c.row], to = cols[c.col + (key === "left" ? -1 : 1)];
      if (tk && to && this.canMove(b)) { this.moveCard(b, tk, to.column.id, cx); this.cursor = { board: b.id, col: c.col + (key === "left" ? -1 : 1), row: 0 }; }
      return true;
    }
    if (!c) {
      if (!["left", "right", "up", "down", "enter"].includes(key)) return false;
      const first = Math.max(0, cols.findIndex((x) => x.tickets.length));
      c = { board: b.id, col: first, row: 0 };
    } else if (key === "left" || key === "right") {
      // To the next Column that has cards, keeping the row where it can.
      const step = key === "left" ? -1 : 1;
      let i = c.col + step;
      while (i >= 0 && i < cols.length && !cols[i].tickets.length) i += step;
      if (i < 0 || i >= cols.length) return true;
      c.col = i; c.row = Math.min(c.row, cols[i].tickets.length - 1);
    } else if (key === "up") c.row = Math.max(0, c.row - 1);
    else if (key === "down") c.row = Math.min(cols[c.col].tickets.length - 1, c.row + 1);
    else if (key === "home") c.row = 0;
    else if (key === "end") c.row = Math.max(0, cols[c.col].tickets.length - 1);
    else if (key !== "enter") return false;
    c.col = Math.min(c.col, cols.length - 1);
    c.row = Math.max(0, Math.min(c.row, cols[c.col].tickets.length - 1));
    this.cursor = c;
    const tk = cols[c.col].tickets[c.row];
    if (tk && (key === "enter" || this.selected)) this.openTicket(b, tk, cx);
    return true;
  }

  reload(cx) {
    const before = this.profile?.name ?? this.lastProfile;
    this.state = { status: "loading" };
    this.boards = {};
    this.tickets = {};
    this.prs = null;
    this.found = {};
    this.statusLists = {};
    this.signIn = null; // account id -> { ok } | { ok: false, reason, command }; null until checked
    this.lastRefresh = null;
    if (this.selected) this.fetchTicketLater = true;
    cx.spawn(async (cx) => {
      const path = configPath();
      let text = null;
      try { text = await readTextFile(path); } catch (e) { this.state = { status: "invalid", path, errors: [String(e.message ?? e)] }; cx.notify(); return; }
      if (text == null) { this.state = { status: "missing", path }; cx.notify(); return; }
      const parsed = parseConfig(text, herdrWindow().platform);
      this.state = parsed.errors.length
        ? { status: "invalid", path, errors: parsed.errors }
        : { status: "ok", path, text, ...parsed, runner: createRunner(parsed.profile.runner) };
      // Another Profile: its Ticket detail must not carry over, even to a Board with the same id (D10).
      const now = parsed.profile?.name ?? null;
      if (now !== before) { this.selected = null; this.fetchTicketLater = false; }
      this.lastProfile = now;
      if (this.state.status === "ok") {
        let cached = null;
        try { cached = await readTextFile(cacheFile(appHome(), parsed.profile.name)); } catch { /* no cache */ }
        const cache = parseCache(cached);
        for (const b of parsed.profile.boards) {
          const c = cachedBoard(cache, b);
          if (c) this.boards[b.id] = { status: "cached", ...c };
        }
        const cp = cachedPrs(cache, prsKey(parsed.profile.accounts));
        if (cp) this.prs = { status: "cached", ...cp };
      }
      cx.notify();
      if (this.state.status === "ok") { this.ensureInputs(); this.watch(cx); }
    });
  }

  // A failed refresh keeps the data it had and shows the error beside its age.
  fetchBoard(b, cx) {
    const prev = this.boards[b.id], profile = this.profile, tried = Date.now();
    this.boards[b.id] = { status: "loading", data: prev?.data ?? null, at: prev?.at ?? null, tried };
    const io = this.io();
    cx.spawn(async (cx) => {
      let data = null;
      try { data = await loadBoard(profile, b, io); } catch (e) {
        if (this.profile?.name !== profile.name) return; // a reload replaced the Profile meanwhile
        this.boards[b.id] = { status: "error", data: prev?.data ?? null, at: prev?.at ?? null, tried, error: String(e.message ?? e) };
        cx.notify();
        return;
      }
      if (this.profile?.name !== profile.name) return;
      const at = Date.now();
      this.boards[b.id] = { status: "ok", data, at, tried };
      cx.notify();
      await this.saveCache(profile, (c) => withBoard(c, profile.boards, b, data, at));
    });
  }

  // One request per Account. Accounts that fail show their error and the rest still list (D19).
  fetchPrs(cx) {
    const prev = this.prs, profile = this.profile, tried = Date.now();
    this.prs = { status: "loading", data: prev?.data ?? null, at: prev?.at ?? null, tried };
    const io = this.io();
    cx.spawn(async (cx) => {
      const data = await loadPullRequests(profile, io);
      if (this.profile?.name !== profile.name) return; // a reload replaced the Profile meanwhile
      const at = Date.now();
      this.prs = { status: "ok", data, at, tried };
      cx.notify();
      await this.saveCache(profile, (c) => withPrs(c, prsKey(profile.accounts), data, at));
    });
  }

  // The view's data, when it has none yet, only a cached copy, or one older than a minute.
  showView(key, cx) {
    this.view = key; save(VIEW_KEY, key);
    if (!this.profile) return;
    const e = key === "prs" ? this.prs : this.board && this.boards[this.board.id];
    const stale = !e || e.status === "cached" || (e.status !== "loading" && due(e.tried, Date.now(), { showing: true }));
    if (key === "prs" && stale) this.fetchPrs(cx);
    else if (key === "board" && this.board && stale) this.fetchBoard(this.board, cx);
  }

  // Best effort: a failed write leaves the old cache, and the next refresh writes again.
  async saveCache(profile, update) {
    const path = cacheFile(appHome(), profile.name);
    for (let i = 0; i < 2; i++) { // a second try when another copy wrote in between
      let cur = null;
      try { cur = await readTextFile(path); } catch { /* unreadable: start over */ }
      try { await writeTextFile(path, serializeCache(update(parseCache(cur))), cur); return; } catch { /* stale snapshot */ }
    }
  }

  checkSignIn(cx) {
    const profile = this.profile, io = this.io();
    cx.spawn(async (cx) => {
      const states = await signInStates(profile, io);
      if (this.profile?.name !== profile.name) return; // a reload replaced the Profile meanwhile
      this.signIn = states;
      cx.notify();
    });
  }

  // Runs an Account's sign-in command in a new tab, through the Profile's runner (D19).
  signInTab(account, command) {
    try {
      const inv = shellInvocation(this.profile.runner, herdrWindow().platform, command);
      run("tab.new", { name: `Sign in: ${account.id}`, argv: [inv.command, ...inv.args] });
    } catch (e) {
      notify({ title: "Wayfinder", body: `Couldn't open the sign-in tab: ${e.message ?? e}`, level: "error" });
    }
  }

  signInCard(t, account, si) {
    const who = account.login ? `${account.id} (${account.login})` : account.id;
    return v_flex().id(`wf-signin-${account.id}`).p(14).gap(8).max_w(720).rounded(10).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Sign in needed"))
      .child(div().text_size(12).text_color(t.muted).child(`${who}: ${si.reason}`))
      .when(Boolean(si.command), (el) => el
        .child(div().text_size(12).child(TextView.markdown(`wf-signin-cmd-${account.id}`, "```sh\n" + si.command + "\n```").selectable(true)))
        .child(h_flex().gap(8).items_center()
          .child(button(`wf-signin-run-${account.id}`, "Run in a new tab", t, () => this.signInTab(account, si.command), { on: true }))
          .child(div().text_size(12).text_color(t.dim).child("Then press Refresh."))));
  }

  // Opens the detail panel on a Ticket, or switches it to another.
  openTicket(b, summary, cx) {
    this.selected = { boardId: b.id, summary };
    this.handle.focus(); // a card's click stops the root's, which would focus: keys need it (#20)
    if (this.tickets[summary.key]?.status !== "ok") this.fetchTicket(cx);
    cx.notify();
  }

  closeTicket() { this.selected = null; }

  fetchTicket(cx) {
    const sel = this.selected, p = this.profile;
    const b = p?.boards.find((x) => x.id === sel?.boardId);
    if (!b) { this.selected = null; return; }
    const key = sel.summary.key;
    this.tickets[key] = { status: "loading", data: this.tickets[key]?.data ?? null };
    const io = this.io();
    cx.spawn(async (cx) => {
      let next;
      try { next = { status: "ok", data: await loadTicket(p, b, sel.summary, io) }; } catch (e) {
        next = { status: "error", data: this.tickets[key]?.data ?? null, error: String(e.message ?? e) };
      }
      if (this.profile?.name !== p.name) return; // a reload replaced the Profile meanwhile
      this.tickets[key] = next;
      if (next.status === "ok") this.fetchImages(p, b, next.data, io, cx);
      cx.notify();
    });
  }

  // A Ticket's images, saved under Herdr's home so image() can show them. Each shows as it arrives.
  fetchImages(p, b, ticket, io, cx) {
    cx.spawn(async (cx) => {
      await loadImages(p, b, ticket, `${appHome()}/${IMAGE_DIR}`, io, (url, name, error) => {
        this.images[url] = name ? { status: "ok", file: `${IMAGE_DIR}/${name}` } : { status: "error", error };
        cx.notify();
      }, { onStart: (url) => { if (!this.images[url]) this.images[url] = { status: "loading" }; } });
      cx.notify();
    });
  }

  selectBoard(id, cx) {
    this.closeTicket();
    save(`wayfinder.board.${this.profile.name}`, id);
    const e = this.boards[id];
    if (!e || e.status === "cached" || (e.status !== "loading" && due(e.tried, Date.now(), { showing: true }))) this.fetchBoard(this.board, cx);
    cx.notify();
  }

  // Confirms the Profile's runner can reach the CLIs Wayfinder signs in with.
  async check(cx) {
    const r = this.state.runner;
    this.checks = null;
    const version = async (cmd, args) => {
      const res = await r.run(cmd, args, { timeout: 20000 });
      return res.code === 0 ? { ok: true, text: res.stdout.split("\n")[0].trim() } : { ok: false, text: (res.stderr || res.stdout).trim().split("\n")[0] || `exit ${res.code}` };
    };
    const [gh, az] = await Promise.all([version("gh", ["--version"]), version("az", ["version", "--query", '"azure-cli"', "-o", "tsv"])]);
    this.checks = { gh, az };
    cx.notify();
  }

  async nextProfile(cx) {
    const s = this.state;
    if (s.status !== "ok") return;
    const names = s.profileNames;
    if (names.length < 2) { notify({ title: "Wayfinder", body: "Only one profile is configured.", level: "info" }); return; }
    await this.switchProfile(names[(names.indexOf(s.profile.name) + 1) % names.length], cx);
  }

  // Saves the choice as the config's activeProfile, so it holds across restarts, then shows it.
  async switchProfile(name, cx) {
    const s = this.state;
    if (s.status !== "ok" || name === s.profile.name || !s.profileNames.includes(name)) return;
    const updated = JSON.stringify({ ...s.config, activeProfile: name }, null, 2) + "\n";
    try { await writeTextFile(s.path, updated, s.text); } catch (e) {
      notify({ title: "Wayfinder", body: `Couldn't switch profile: ${e.message ?? e}`, level: "error" });
    }
    this.reload(cx);
  }

  // ---- Settings (#17): edits wayfinder.json. Each change is written at once, in order.

  openSettings(cx) {
    this.view = "settings"; save(VIEW_KEY, "settings");
    this.settingsError = null;
    this.ensureInputs();
    this.loadSettings(cx);
  }

  // A search box per Account list. InputState needs a live host call, so never from render.
  ensureInputs() {
    for (const a of this.profile?.accounts ?? []) {
      for (const [kind, placeholder] of [["boards", "Search boards"], ["repos", "Search repos"]]) {
        if (this.inputs[kind][a.id]) continue;
        const input = InputState.new({ placeholder });
        input.on("change", (_e, cx) => cx.notify());
        this.inputs[kind][a.id] = input;
      }
    }
  }

  // Whether part of an Account's Settings is folded away. Remembered per Profile and Account.
  // "" is the other Boards, "boards" and "repos" the whole cards, "repos.others" the other repos.
  foldKey(a, part = "", profile = this.profile.name) { return `wayfinder.settings.fold.${profile}.${a.id}${part ? `.${part}` : ""}`; }

  startRename(name) {
    const input = InputState.new({ value: name, placeholder: "profile name" });
    input.on("submit", (_e, cx) => this.finishRename(cx));
    this.renaming = { name, input };
    input.focus();
  }

  // Renames the Profile in the file, then moves what is keyed by its name: the az login folder (through
  // that Profile's runner), the cache (copied: Herdr can't delete files, so the old one stays), and the
  // remembered Board and Mine choices.
  finishRename(cx) {
    const r = this.renaming, s = this.state;
    if (!r || s.status !== "ok") return;
    const from = r.name, to = r.input.value().trim();
    this.renaming = null;
    if (to === from) { cx.notify(); return; }
    const rawProfile = s.config.profiles?.[from];
    const platform = herdrWindow().platform;
    this.saveConfig((raw) => edits.renameProfile(raw, from, to), cx, {
      after: async () => {
        const runner = from === s.profile.name ? s.runner : createRunner(rawProfile?.runner ?? defaultRunner(platform));
        const accounts = rawProfile?.accounts ?? [];
        try { await renameProfileData({ name: from, accounts }, to, { run: runner.run, fetch, profile: from }); } catch (e) {
          this.settingsError = `Renamed, but ${e.message ?? e}. Sign in again for ${to}.`;
        }
        try {
          const cache = await readTextFile(cacheFile(appHome(), from));
          if (cache != null) await writeTextFile(cacheFile(appHome(), to), cache, null);
        } catch { /* the cache is rebuilt on the next refresh */ }
        const key = (k) => `wayfinder.${k}.${from}`;
        const b = load(key("board"), null);
        if (b != null) save(`wayfinder.board.${to}`, b);
        for (const x of rawProfile?.boards ?? []) {
          const m = load(`wayfinder.mine.${from}.${x.id}`, null);
          if (m != null) save(`wayfinder.mine.${to}.${x.id}`, m);
        }
        for (const a of accounts) {
          for (const part of FOLD_PARTS) {
            const f = load(this.foldKey(a, part, from), null);
            if (f != null) save(this.foldKey(a, part, to), f);
          }
        }
      },
    });
  }

  // What each Account can offer: its Boards and its repos. Loaded once per open, or on Refresh.
  loadSettings(cx, force = false) {
    const p = this.profile;
    if (!p) return;
    const io = this.io();
    for (const a of p.accounts) {
      const f = (this.found[a.id] ??= {});
      const provider = providerFor(a);
      for (const [key, cap, fn] of [["boards", "boards", discoverBoards], ["repos", "repos", discoverRepos]]) {
        if (!can(provider, cap) || (!force && f[key] && f[key].status !== "error")) continue;
        f[key] = { status: "loading", data: f[key]?.data ?? null };
        cx.spawn(async (cx) => {
          let next;
          try { next = { status: "ok", data: await fn(a, io) }; } catch (e) { next = { status: "error", data: f[key]?.data ?? null, error: String(e.message ?? e) }; }
          if (this.profile?.name !== p.name || this.found[a.id] !== f) return;
          f[key] = next;
          cx.notify();
        });
      }
    }
    if (force) { this.statusLists = {}; if (this.statusOpen) this.loadStatuses(this.statusOpen, cx); }
  }

  loadStatuses(boardId, cx) {
    const p = this.profile, b = p?.boards.find((x) => x.id === boardId);
    if (!b) return;
    this.statusLists[boardId] = { status: "loading" };
    const io = this.io();
    cx.spawn(async (cx) => {
      let next;
      try { next = { status: "ok", data: await boardStatuses(p, b, io) }; } catch (e) { next = { status: "error", error: String(e.message ?? e) }; }
      if (this.profile?.name !== p.name) return;
      this.statusLists[boardId] = next;
      cx.notify();
    });
  }

  // Applies `change(rawConfig)` and writes it. A change that leaves the config invalid is refused.
  saveConfig(change, cx, { after = null } = {}) {
    const s = this.state;
    const base = s.status === "ok" ? s.config : s.status === "missing" ? {} : null;
    if (!base) return;
    let raw;
    try { raw = change(base); } catch (e) { this.settingsError = String(e.message ?? e); cx.notify(); return; }
    const text = JSON.stringify(raw, null, 2) + "\n";
    const parsed = parseConfig(text, herdrWindow().platform);
    if (parsed.errors.length) { this.settingsError = parsed.errors[0]; cx.notify(); return; }
    this.settingsError = null;
    this.confirm = null;
    const expected = s.status === "ok" ? s.text : null;
    // Another active Profile or runner needs a full reload. Otherwise the change applies in place.
    const reload = s.status !== "ok" || parsed.profile.name !== s.profile.name || parsed.profile.runner !== s.profile.runner;
    if (!reload && !after) {
      this.state = { ...s, text, config: parsed.config, profile: parsed.profile, profileNames: parsed.profileNames };
      if (this.prs) this.prs = { ...this.prs, status: "cached" }; // followed repos may have changed: refetch on show
    }
    this.writes = (this.writes ?? Promise.resolve()).then(async () => {
      try { await writeTextFile(s.path, text, expected); } catch (e) {
        this.settingsError = `Couldn't save (${e.message ?? e}). The file changed elsewhere, so it was read again.`;
        this.reload(cx); cx.notify(); return;
      }
      if (after) await after();
      if (reload || after) { this.reload(cx); cx.notify(); }
    });
    cx.notify();
  }

  // A remove button: the first click asks, the second removes.
  removeButton(id, t, onRemove) {
    const armed = this.confirm === id;
    return button(`wf-rm-${id}`, armed ? "Click again to remove" : "Remove", t, (cx) => {
      if (armed) onRemove(cx); else this.confirm = id;
      cx.notify();
    }, { on: armed });
  }

  settingsView(t) {
    const s = this.state, p = this.profile;
    const heading = (text) => div().pt(8).text_size(13).font_semibold().text_color(t.foreground).child(text);
    const note = (text, color = t.dim) => div().text_size(12).text_color(color).child(text);
    const card = (id, kids) => v_flex().id(id).p(12).gap(6).rounded(8).bg(t.surface).border_1().border_color(t.border).children(kids);
    const who = (a) => `${a.id} · ${a.provider === "azure" ? a.org : a.login}`;
    const line = () => div().h(1).my(4).bg(t.border);
    // A clickable row that folds what follows it. Returns [row, folded].
    const fold = (id, a, part, label, color = t.muted) => {
      const folded = load(this.foldKey(a, part), "0") === "1";
      return [h_flex().id(id).gap(8).items_center().cursor_pointer()
        .on_mouse_down("left", stop).on_click((_e, cx) => { save(this.foldKey(a, part), folded ? "0" : "1"); cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(color).child(label))
        .child(div().text_size(12).text_color(t.dim).hover((x) => x.text_color(t.foreground)).child(folded ? "Show" : "Hide")), folded];
    };
    const out = [];
    if (this.settingsError) out.push(note(this.settingsError, t.blocked));

    // Profiles: order is the switcher's order.
    const names = s.profileNames ?? [];
    out.push(heading("Profiles"), note("Each Profile is a separate set of Accounts and Boards. Wayfinder shows one at a time, and the switcher lists them in this order."));
    out.push(card("wf-set-profiles", [
      ...names.map((n, i) => {
        const renaming = this.renaming?.name === n;
        return h_flex().id(`wf-set-p-${n}`).gap(6).items_center()
          .when(renaming, (el) => el.child(field(this.renaming.input, t, 200))
            .child(button(`wf-ren-ok-${n}`, "Save", t, (cx) => this.finishRename(cx), { on: true }))
            .child(button(`wf-ren-no-${n}`, "Cancel", t, (cx) => { this.renaming = null; cx.notify(); }))
            .child(div().flex_1()))
          .when(!renaming, (el) => el.child(div().flex_1().text_size(12).text_color(t.foreground).child(n === p?.name ? `${n} (shown)` : n))
            .when(n !== p?.name, (r) => r.child(button(`wf-use-${n}`, "Show", t, (cx) => cx.spawn(async (cx) => { await this.switchProfile(n, cx); cx.notify(); }))))
            .child(button(`wf-ren-${n}`, "Rename", t, (cx) => { this.startRename(n); cx.notify(); })))
          .child(button(`wf-pu-${n}`, "↑", t, (cx) => this.saveConfig((raw) => edits.moveProfile(raw, n, -1), cx)))
          .child(button(`wf-pd-${n}`, "↓", t, (cx) => this.saveConfig((raw) => edits.moveProfile(raw, n, 1), cx)))
          .when(names.length > 1, (el) => el.child(this.removeButton(`profile-${n}`, t, (cx) => this.saveConfig((raw) => edits.removeProfile(raw, n), cx))));
      }),
      h_flex().gap(8).items_center().child(field(this.inputs.profile, t, 200))
        .child(button("wf-add-profile", "Add profile", t, (cx) => {
          const name = this.inputs.profile.value().trim();
          this.saveConfig((raw) => {
            const next = edits.addProfile(raw, name);
            if (!names.length) next.activeProfile = name;
            return next;
          }, cx);
          this.inputs.profile.set_value("");
        })),
    ]));
    if (!p) return v_flex().id("wf-settings").size_full().min_h(0).p(16).gap(10).overflow_y_scrollbar().children(out);

    // Accounts
    out.push(heading(`Accounts in ${p.name}`), note("Wayfinder signs in through the gh and az CLIs and stores no secrets."));
    out.push(card("wf-set-accounts", [
      ...(p.accounts.length ? [] : [note("No accounts yet.")]),
      ...p.accounts.flatMap((a) => {
        const si = this.signIn?.[a.id];
        return [
          h_flex().id(`wf-set-a-${a.id}`).gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(who(a)))
            .child(div().text_size(11).text_color(si?.ok === false ? t.blocked : t.dim).child(si ? (si.ok ? "signed in" : "sign in needed") : ""))
            .child(this.removeButton(`account-${a.id}`, t, (cx) => this.saveConfig((raw) => edits.removeAccount(raw, p.name, a.id), cx))),
          ...(si && !si.ok ? [this.signInCard(t, a, si)] : []),
        ];
      }),
      h_flex().gap(8).items_center().child(field(this.inputs.gh, t))
        .child(button("wf-add-gh", "Add GitHub account", t, (cx) => {
          this.saveConfig((raw) => edits.addAccount(raw, p.name, { provider: "github", login: this.inputs.gh.value().trim() }), cx);
          this.inputs.gh.set_value(""); this.ensureInputs(); this.checkSignIn(cx); this.loadSettings(cx);
        })),
      h_flex().gap(8).items_center().child(field(this.inputs.ado, t))
        .child(button("wf-add-ado", "Add Azure account", t, (cx) => {
          this.saveConfig((raw) => edits.addAccount(raw, p.name, { provider: "azure", org: this.inputs.ado.value().trim() }), cx);
          this.inputs.ado.set_value(""); this.ensureInputs(); this.checkSignIn(cx); this.loadSettings(cx);
        })),
    ]));

    // Boards: one card per Account. Its followed Boards first, a line, then the others (foldable, searchable).
    out.push(heading("Boards"), note("Ticked Boards show in Wayfinder. With two or more, a switcher shows above the Board."));
    for (const a of p.accounts.filter((x) => can(providerFor(x), "boards"))) {
      const f = this.found[a.id]?.boards;
      const found = f?.data ?? [];
      const mine = p.boards.filter((b) => b.account === a.id);
      const cfgFor = (d) => mine.find((b) => edits.showsBoard(b, a.id, d, Boolean(d.teamDefault)));
      const search = this.inputs.boards[a.id];
      const unfollowed = found.filter((d) => !cfgFor(d));
      const others = edits.matchBoards(unfollowed, search?.value());
      const active = mine.flatMap((b) => {
        const open = this.statusOpen === b.id;
        const tracked = b.trackedStatuses?.length ?? 0;
        return [
          h_flex().id(`wf-set-ab-${b.id}`).gap(8).items_center()
            .child(checkRow(`wf-set-abc-${b.id}`, true, b.name ?? b.id, t, (cx) => this.saveConfig((raw) => edits.unfollowBoard(raw, p.name, b.id), cx)))
            .when(can(providerFor(a), "statuses"), (el) => el.child(button(`wf-st-${b.id}`,
              open ? "Done" : tracked ? `Edit displayed statuses (${tracked})` : "Edit displayed statuses", t,
              (cx) => { this.statusOpen = open ? null : b.id; if (this.statusOpen && !this.statusLists[b.id]) this.loadStatuses(b.id, cx); cx.notify(); },
              { on: open || tracked > 0 }))),
          ...(open ? [this.statusEditor(t, p, b)] : []),
        ];
      });
      const [cardRow, cardFolded] = fold(`wf-set-bc-${a.id}`, a, "boards", `${who(a)} · ${mine.length} followed`, t.foreground);
      const [othersRow, folded] = fold(`wf-set-bh-${a.id}`, a, "", `Other Boards${f?.status === "ok" ? ` · ${unfollowed.length}` : ""}`);
      out.push(card(`wf-set-boards-${a.id}`, [
        cardRow,
        ...(cardFolded ? [] : [
          ...(active.length ? active : [note("No Boards followed. Tick one below.")]),
          line(),
          othersRow,
          ...(folded ? [] : [
            ...(search ? [field(search, t)] : []),
            ...(f?.status === "loading" ? [note("Finding boards…")] : []),
            ...(f?.status === "error" ? [note(`Couldn't list boards: ${f.error}`, t.blocked)] : []),
            ...(f?.status === "ok" && !unfollowed.length ? [note(found.length ? "All followed." : "No boards found.")] : []),
            ...(unfollowed.length && !others.length ? [note("No match.")] : []),
            ...others.map((d) => h_flex().child(checkRow(`wf-set-bo-${a.id}-${found.indexOf(d)}`, false, d.title, t,
              (cx) => this.saveConfig((raw) => edits.followBoard(raw, p.name, a.id, d), cx)))),
          ]),
        ]),
      ]));
    }

    // Pull Request repos
    out.push(heading("Pull Request repos"), note("All: every repo's Pull Requests. Selected: only the ticked repos. Ignored: every repo except the ticked ones."));
    for (const a of p.accounts.filter((x) => can(providerFor(x), "repos"))) {
      const f = this.found[a.id]?.repos;
      const rf = repoFilter(a);
      const ticked = rf.mode === "all" ? [] : rf[rf.mode];
      const search = this.inputs.repos[a.id];
      const all = f?.data ?? [];
      // The ticked repos first, then the others to search. A ticked repo no longer listed still shows.
      const { rows, hidden } = edits.repoRows(all.filter((r) => !ticked.includes(r)), [], search?.value());
      const untickedCount = all.filter((r) => !ticked.includes(r)).length;
      const summary = rf.mode === "all" ? "all repos"
        : rf.mode === "selected" ? (ticked.length ? `only ${ticked.length} selected` : "nothing selected, so no Pull Requests")
        : `all but ${ticked.length} ignored`;
      const [cardRow, cardFolded] = fold(`wf-set-rc-${a.id}`, a, "repos", `${who(a)} · ${summary}`, t.foreground);
      const [othersRow, folded] = fold(`wf-set-rh-${a.id}`, a, "repos.others", `Other repos${f?.status === "ok" ? ` · ${untickedCount}` : ""}`);
      const tickLabel = rf.mode === "selected" ? "Selected repos" : "Ignored repos";
      out.push(card(`wf-set-repos-${a.id}`, [
        cardRow,
        ...(cardFolded ? [] : [
          h_flex().child(segmented(`wf-rm-${a.id}`, [["all", "All"], ["selected", "Selected"], ["ignored", "Ignored"]], rf.mode, t,
            (mode, cx) => this.saveConfig((raw) => edits.setRepoMode(raw, p.name, a.id, mode), cx))),
          ...(rf.mode === "all" ? [] : [
            note(tickLabel),
            ...(ticked.length ? ticked.map((r) => h_flex().child(checkRow(`wf-set-rt-${a.id}-${r}`, true, r, t,
              (cx) => this.saveConfig((raw) => edits.toggleRepo(raw, p.name, a.id, r), cx))))
              : [note(rf.mode === "selected" ? "None selected. Tick one below." : "None ignored. Tick one below.")]),
            line(),
            othersRow,
            ...(folded ? [] : [
              ...(search ? [field(search, t)] : []),
              ...(f?.status === "loading" ? [note("Listing repos…")] : []),
              ...(f?.status === "error" ? [note(`Couldn't list repos: ${f.error}`, t.blocked)] : []),
              ...(f?.status === "ok" && !untickedCount ? [note("All ticked.")] : []),
              ...(untickedCount && !rows.length ? [note("No match.")] : []),
              ...rows.map((r) => h_flex().child(checkRow(`wf-set-r-${a.id}-${r}`, false, r, t,
                (cx) => this.saveConfig((raw) => edits.toggleRepo(raw, p.name, a.id, r), cx)))),
              ...(hidden ? [note(`${hidden} more match. Search to narrow the list.`)] : []),
            ]),
          ]),
        ]),
      ]));
    }
    return v_flex().id("wf-settings").size_full().min_h(0).p(16).gap(10).overflow_y_scrollbar().children(out);
  }

  // A Board's Tracked Statuses: ticked ones in Column order with up and down, then the rest.
  statusEditor(t, p, b) {
    const st = this.statusLists[b.id];
    const tracked = b.trackedStatuses ?? [];
    const set = (list, cx) => this.saveConfig((raw) => edits.setTrackedStatuses(raw, p.name, b.id, list), cx);
    const rest = (st?.data ?? []).filter((x) => !tracked.some((y) => y.toLowerCase() === x.toLowerCase()));
    return v_flex().id(`wf-st-ed-${b.id}`).ml(22).p(8).gap(2).rounded(6).bg(t.background).border_1().border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).child(tracked.length ? "Each ticked status is one Column, in this order." : "None ticked: the Board's own Columns."))
      .when(st?.status === "loading", (el) => el.child(div().text_size(11).text_color(t.dim).child("Loading statuses…")))
      .when(st?.status === "error", (el) => el.child(div().text_size(11).text_color(t.blocked).child(`Couldn't list statuses: ${st?.error}`)))
      .children(tracked.map((x, i) => h_flex().id(`wf-st-t-${b.id}-${i}`).gap(4).items_center()
        .child(checkRow(`wf-st-c-${b.id}-${i}`, true, x, t, (cx) => set(edits.toggleStatus(tracked, x), cx)))
        .child(button(`wf-st-up-${b.id}-${i}`, "↑", t, (cx) => set(edits.move(tracked, i, -1), cx)))
        .child(button(`wf-st-dn-${b.id}-${i}`, "↓", t, (cx) => set(edits.move(tracked, i, 1), cx)))))
      .children(rest.map((x, i) => h_flex().child(checkRow(`wf-st-r-${b.id}-${i}`, false, x, t, (cx) => set(edits.toggleStatus(tracked, x), cx)))));
  }

  header(t) {
    return h_flex().h(44).px(12).gap(10).flex_none().items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Wayfinder"))
      .child(segmented("wf-view", [["board", "Board"], ["prs", "Pull Requests"]], this.view, t, (key, cx) => {
        this.showView(key, cx); cx.notify();
      }))
      .child(div().flex_1())
      .when(Boolean(this.profile) && this.state.profileNames.length > 1, (el) => el.child(segmented("wf-profiles",
        this.state.profileNames.map((n) => [n, n]), this.profile.name, t, (name, cx) => cx.spawn(async (cx) => { await this.switchProfile(name, cx); cx.notify(); }))))
      .child(h_flex().gap(2).items_center()
        .child(iconButton("wf-settings", "settings", t, (cx) => { this.openSettings(cx); cx.notify(); }, { on: this.view === "settings" }))
        .child(iconButton("wf-refresh", "refresh", t, (cx) => this.reload(cx)))
        .child(iconButton("wf-full", this.fullscreen ? "exit-fullscreen" : "fullscreen", t, (cx) => { this.setFullscreen(!this.fullscreen); cx.notify(); }))
        .child(iconButton("wf-close", "close", t, () => this.close_())));
  }

  message(t, title, lines) {
    return v_flex().p(16).gap(8).max_w(720).child(div().text_size(14).font_semibold().text_color(t.foreground).child(title))
      .children(lines.map((l) => div().text_size(12).text_color(t.muted).child(l)));
  }

  boardView(t) {
    const p = this.profile, b = this.board;
    if (!b) {
      const c = this.checks;
      const check = (name, r) => r ? `${name}: ${r.ok ? r.text : `not reachable (${r.text})`}` : `${name}: checking…`;
      const bad = p.accounts.filter((a) => this.signIn?.[a.id]?.ok === false);
      return v_flex().p(16).gap(12)
        .child(this.message(t, "No Boards", [`Profile ${p.name} has no Boards. Add one under "boards" in ${this.state.path}.`, check("gh", c?.gh), check("az", c?.az)]).p(0))
        .children(bad.map((a) => this.signInCard(t, a, this.signIn[a.id])));
    }
    const entry = this.boards[b.id] ?? { status: "loading" };
    const mine = load(this.mineKey(b), "0") === "1";
    const title = b.name ?? entry.data?.title ?? b.id;
    const site = p.accounts.find((a) => a.id === b.account)?.provider;

    const bar = h_flex().h(40).px(16).gap(10).flex_none().items_center()
      .when(p.boards.length > 1, (el) => el.child(segmented("wf-boards", p.boards.map((x) => [x.id, x.name ?? this.boards[x.id]?.data?.title ?? x.id]), b.id, t, (id, cx) => this.selectBoard(id, cx))))
      .when(p.boards.length <= 1, (el) => el.child(div().text_size(13).font_semibold().text_color(t.foreground).child(title)))
      .child(button("wf-mine", "Mine", t, (cx) => { save(this.mineKey(b), mine ? "0" : "1"); cx.notify(); }, { on: mine }))
      .when(Boolean(entry.data?.url), (el) => el.child(div().flex_none().text_size(12)
        .child(TextView.markdown(`wf-board-link-${b.id}`, link(`View in ${SITE[site] ?? "browser"}`, entry.data.url)))))
      .child(div().flex_1())
      .when(entry.status === "error" && Boolean(entry.data), (el) => el.child(div().min_w(0).text_size(12).text_color(t.blocked).truncate().child(`Couldn't refresh: ${entry.error}`)))
      .when(entry.status === "loading" || Boolean(entry.at), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim)
        .child(entry.status === "loading" ? (entry.data ? "Refreshing…" : "Loading…") : `Updated ${formatAge(Date.now() - entry.at)}`)));

    const account = p.accounts.find((a) => a.id === b.account);
    const si = account ? this.signIn?.[account.id] : null;
    let content;
    if (si && !si.ok) {
      content = v_flex().p(16).child(this.signInCard(t, account, si));
    } else if (!entry.data) {
      content = entry.status === "error" ? this.message(t, "Couldn't load this Board", [entry.error]) : skeletonColumns(t);
    } else {
      content = h_flex().id("wf-columns").size_full().min_w(0).min_h(0).px(16).pb(16).gap(12).items_start().overflow_x_scrollbar()
        .children(this.columnsOf(b, entry.data).map(({ column, tickets }, ci) =>
          v_flex().id(`wf-col-${column.id}`).w(COLUMN_W).flex_none().max_h_full().rounded(10).bg(t.chrome).border_1().border_color(t.border)
            .child(h_flex().h(36).px(12).gap(8).flex_none().items_center()
              .child(div().text_size(12).font_semibold().text_color(t.foreground).truncate().child(column.name))
              .child(div().text_size(11).text_color(t.dim).child(String(tickets.length))))
            .child(v_flex().id(`wf-col-body-${column.id}`).px(8).pb(8).gap(8).overflow_y_scrollbar()
              .children(tickets.map((tk, ri) => card(tk, t, this.selected?.summary.key === tk.key, (cx) => { this.cursor = { board: b.id, col: ci, row: ri }; this.openTicket(b, tk, cx); },
                this.cursor?.board === b.id && this.cursor.col === ci && this.cursor.row === ri))))));
    }
    const panel = this.selected?.boardId === b.id && !(si && !si.ok) ? this.ticketPanel(t) : null;
    // The detail panel takes the full height under the header, beside the Board's bar and Columns.
    return h_flex().size_full().items_start()
      // A click on the Board outside a card closes the detail panel. Cards and buttons stop their own.
      .child(v_flex().id("wf-board-area").flex_1().min_w(0).h_full()
        .on_click((_e, cx) => { if (this.selected) { this.closeTicket(); cx.notify(); } })
        .child(bar).child(content))
      .when(Boolean(panel), (el) => el.child(panel));
  }

  canMove(b) {
    const a = this.profile.accounts.find((x) => x.id === b.account);
    return Boolean(a) && can(providerFor(a), "move");
  }

  // Moves a card (#15): shown in its new Column at once, then the Board reloads. A failure puts it back.
  moveCard(b, summary, columnId, cx) {
    const entry = this.boards[b.id], data = entry?.data;
    if (!data || this.moving?.status === "busy") return;
    let target;
    try { target = moveTarget(data, b, columnId); } catch (e) { this.moving = { key: summary.key, status: "error", error: String(e.message ?? e) }; return; }
    const before = data.tickets.find((x) => x.key === summary.key);
    if (!before) return;
    const after = { ...before, columnId: target.column?.id ?? before.columnId, status: target.status ?? target.column?.states?.[before.type] ?? before.status };
    entry.data = { ...data, tickets: data.tickets.map((x) => (x.key === summary.key ? after : x)) };
    if (this.selected?.summary.key === summary.key) this.selected = { ...this.selected, summary: { ...this.selected.summary, ...after } };
    this.moving = { key: summary.key, status: "busy" };
    const io = this.io(), p = this.profile;
    cx.spawn(async (cx) => {
      try {
        await moveTicket(p, b, data, before, columnId, io);
        this.moving = null;
        delete this.tickets[summary.key]; // its Column changed: the detail reloads
        if (this.selected?.summary.key === summary.key) this.fetchTicket(cx);
      } catch (e) {
        const cur = this.boards[b.id];
        if (cur?.data) cur.data = { ...cur.data, tickets: cur.data.tickets.map((x) => (x.key === summary.key ? before : x)) };
        this.moving = { key: summary.key, status: "error", error: `Couldn't move it: ${e.message ?? e}` };
      }
      if (this.profile?.name === p.name) this.fetchBoard(b, cx);
      cx.notify();
    });
  }

  moveRow(t, b, sum) {
    const data = this.boards[b.id]?.data;
    if (!data || !this.canMove(b)) return null;
    const cols = this.columnsOf(b, data).map((x) => x.column);
    const cur = this.columnsOf(b, data).find((x) => x.tickets.some((tk) => tk.key === sum.key))?.column.id;
    const m = this.moving?.key === sum.key ? this.moving : null;
    return v_flex().gap(6)
      .child(h_flex().gap(6).flex_wrap().items_center()
        .child(div().w(84).flex_none().text_size(12).text_color(t.dim).child("Move to"))
        .children(cols.map((c) => button(`wf-move-${c.id}`, c.name, t, (cx) => { if (c.id !== cur) this.moveCard(b, sum, c.id, cx); cx.notify(); }, { on: c.id === cur }))))
      .when(m?.status === "busy", (el) => el.child(div().text_size(12).text_color(t.dim).child("Moving…")))
      .when(m?.status === "error", (el) => el.child(div().text_size(12).text_color(t.blocked).child(m.error)));
  }

  canUpdate(b) {
    const a = this.profile.accounts.find((x) => x.id === b.account);
    return Boolean(a) && can(providerFor(a), "update");
  }

  // Title editing (#16): an input in place of the title, saved with Enter or Save.
  startEdit(sum, title) {
    const input = InputState.new({ value: title });
    input.on("submit", (_e, cx) => { this.saveTitle(cx); cx.notify(); });
    input.on("focus", () => { this.typing = true; });
    input.on("blur", () => { this.typing = false; });
    this.editing = { key: sum.key, input, status: "idle" };
    input.focus();
  }

  saveTitle(cx) {
    const E = this.editing, sel = this.selected, p = this.profile;
    const b = p.boards.find((x) => x.id === sel?.boardId);
    if (!E || !b || E.status === "busy" || E.key !== sel.summary.key) return;
    const title = E.input.value().trim();
    E.status = "busy"; E.error = null;
    const io = this.io(), sum = sel.summary;
    cx.spawn(async (cx) => {
      try {
        await updateTicket(p, b, sum, { title }, io);
        if (this.editing === E) { this.editing = null; this.typing = false; }
        const entry = this.boards[b.id];
        if (entry?.data) entry.data = { ...entry.data, tickets: entry.data.tickets.map((x) => (x.key === sum.key ? { ...x, title } : x)) };
        if (this.selected?.summary.key === sum.key) { this.selected = { ...this.selected, summary: { ...this.selected.summary, title } }; this.fetchTicket(cx); }
      } catch (e) {
        E.status = "error"; E.error = `Couldn't save the title: ${e.message ?? e}`;
      }
      cx.notify();
    });
  }

  postComment(cx) {
    const sel = this.selected, p = this.profile, b = p.boards.find((x) => x.id === sel?.boardId);
    if (!b || this.commenting?.status === "busy") return;
    const text = this.commentBox.value().trim();
    if (!text) return;
    const C = this.commenting = { key: sel.summary.key, status: "busy" };
    const io = this.io(), sum = sel.summary;
    cx.spawn(async (cx) => {
      try {
        await commentOnTicket(p, b, sum, text, io);
        this.commentBox.set_value("");
        this.commenting = null;
        if (this.selected?.summary.key === sum.key) this.fetchTicket(cx);
      } catch (e) {
        C.status = "error"; C.error = `Couldn't post the comment: ${e.message ?? e}`;
      }
      cx.notify();
    });
  }

  // Launch (#13, D5, D18). The repos offered are the Board's, else the Profile's.
  launchRepos() {
    const p = this.profile, b = p.boards.find((x) => x.id === this.selected?.boardId);
    const ids = b?.repos?.length ? b.repos : p.repos.map((r) => r.id);
    return ids.map((id) => p.repos.find((r) => r.id === id)).filter(Boolean);
  }

  launchTemplate() {
    const b = this.profile.boards.find((x) => x.id === this.selected?.boardId);
    return resolveTemplate(DEFAULT_LAUNCH, this.state.templates?.launch, b?.launch);
  }

  openLaunch(tk, cx) {
    const repos = this.launchRepos();
    const key = this.selected.summary.key;
    this.launch = { key, selected: repos.map((r) => r.id), exists: null, status: "idle" };
    const io = this.io();
    cx.spawn(async (cx) => {
      let exists = [];
      try { exists = await existingWorktrees(ticketFolder(tk), repos.map(repoName), io); } catch { /* shown as not made */ }
      if (this.launch?.key !== key) return;
      this.launch.exists = exists;
      cx.notify();
    });
  }

  addLaunchRepo(cx) {
    const boardId = this.selected?.boardId, name = this.profile.name;
    cx.spawn(async (cx) => {
      const folder = await pickFolder({ prompt: "Pick a local clone for this Board" });
      if (!folder) return;
      let id = null;
      this.saveConfig((raw) => { const r = edits.addRepo(raw, name, { path: folder, boardId }); id = r.id; return r.raw; }, cx, {
        after: () => { if (this.launch && id && !this.launch.selected.includes(id)) this.launch.selected.push(id); },
      });
    });
  }

  startLaunch(tk, cx) {
    const L = this.launch, p = this.profile;
    if (!L || L.status === "busy") return;
    // A second Launch selects the space it made (D18).
    const name = launchSpaceName(tk);
    const open = spaces().find((x) => x.name === name);
    if (open) { run("space.select", { id: open.id }); this.launch = null; return; }
    const repos = this.launchRepos().filter((r) => L.selected.includes(r.id));
    let argv;
    const tpl = this.launchTemplate();
    try { argv = agentArgv(tpl); } catch (e) { L.status = "error"; L.error = String(e.message ?? e); return; }
    const folder = ticketFolder(tk), branch = folder;
    L.status = "busy"; L.message = repos.length ? "Making worktrees…" : "Starting…"; L.error = null;
    const io = this.io(), runner = p.runner;
    cx.spawn(async (cx) => {
      try {
        const made = await makeLaunchWorktrees(folder, branch, repos.map((r) => ({ path: r.path, name: repoName(r) })), io);
        const info = repos.map((r) => ({ id: r.id, branch, worktree: `${made.path}/${repoName(r)}` }));
        run("space.new", { name, folder: made.space, argv: spaceArgv(runner, herdrWindow().platform, made.path, argv), task: launchPrompt(tk, info, tpl) });
        if (this.launch === L) this.launch = null;
      } catch (e) {
        L.status = "error"; L.error = `Launch failed: ${e.message ?? e}`;
      }
      cx.notify();
    });
  }

  launchCard(t, tk) {
    const L = this.launch, repos = this.launchRepos(), tpl = this.launchTemplate();
    const note = (text, color = t.dim) => div().text_size(12).text_color(color).child(text);
    const exists = (r) => L.exists?.includes(repoName(r));
    const open = spaces().some((x) => x.name === launchSpaceName(tk));
    return v_flex().id("wf-launch-card").p(12).gap(8).rounded(8).bg(t.surface).border_1().border_color(t.accent)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Launch"))
      .child(note(open ? `The space "${launchSpaceName(tk)}" is open. Launch selects it.`
        : `A space with ${tpl.agent}${tpl.model ? ` (${tpl.model})` : ""} in ~/.herdr/worktrees/${ticketFolder(tk)}, on branch ${ticketFolder(tk)}.`))
      .children(repos.length ? repos.map((r) => h_flex().gap(8).items_center()
        .child(checkRow(`wf-launch-r-${r.id}`, L.selected.includes(r.id), r.id, t, (cx) => {
          L.selected = L.selected.includes(r.id) ? L.selected.filter((x) => x !== r.id) : [...L.selected, r.id]; cx.notify();
        }))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.path))
        .child(note(L.exists == null ? "" : exists(r) ? "worktree exists" : ""))) : [note("No repos for this Board yet. Add a local clone, or launch without one.")])
      .child(h_flex().gap(8).items_center()
        .child(button("wf-launch-add", "Add repo…", t, (cx) => this.addLaunchRepo(cx)))
        .child(div().flex_1())
        .when(L.status === "busy", (el) => el.child(note(L.message ?? "Working…")))
        .child(button("wf-launch-go", open ? "Show space" : "Launch", t, (cx) => { this.startLaunch(tk, cx); cx.notify(); }, { on: true })))
      .when(L.status === "error", (el) => el.child(note(L.error, t.blocked)));
  }

  // Review (#14, D15 to D17): the PR's clone from the Profile's repos, else asked for once.
  startReview(accountId, pr, cx) {
    if (this.reviews[pr.key]?.status === "busy") return;
    const name = reviewSpaceName(pr);
    const open = spaces().find((x) => x.name === name);
    if (open) { run("space.select", { id: open.id }); return; }
    const st = this.reviews[pr.key] = { status: "busy", message: "Starting…" };
    const profileName = this.profile.name, io = this.io(), runner = this.profile.runner;
    cx.spawn(async (cx) => {
      try {
        let repo = this.profile.repos.find((r) => r.prRepo === pr.repo);
        if (!repo) {
          st.message = "Pick its clone…"; cx.notify();
          const folder = await pickFolder({ prompt: `Pick your local clone of ${pr.repo}` });
          if (!folder) { delete this.reviews[pr.key]; cx.notify(); return; }
          let id = null;
          this.saveConfig((raw) => { const r = edits.addRepo(raw, profileName, { path: folder, prRepo: pr.repo }); id = r.id; return r.raw; }, cx);
          repo = { id: id ?? "repo", path: folder.replace(/[\\/]+$/, ""), prRepo: pr.repo };
        }
        st.message = "Reading the Pull Request…"; cx.notify();
        const info = await loadReviewInfo(this.profile, accountId, pr, io);
        st.message = "Making the worktree…"; cx.notify();
        const tpl = resolveTemplate(DEFAULT_REVIEW, this.state.templates?.review, repo.review);
        const made = await makeReviewWorktree(reviewFolder(pr), { path: repo.path, name: repoName(repo) }, info.branch, io);
        run("space.new", { name, folder: made.space, argv: spaceArgv(runner, herdrWindow().platform, made.path, agentArgv(tpl)), task: reviewPrompt(pr, info, made.path, tpl) });
        delete this.reviews[pr.key];
      } catch (e) {
        this.reviews[pr.key] = { status: "error", error: `Review failed: ${e.message ?? e}` };
      }
      cx.notify();
    });
  }

  titleRow(t, sum, tk) {
    const title = (tk ?? sum).title, E = this.editing?.key === sum.key ? this.editing : null;
    const b = this.profile.boards.find((x) => x.id === this.selected.boardId);
    if (E) {
      return v_flex().gap(6)
        .child(h_flex().gap(6).items_center().child(field(E.input, t, 300))
          .child(button("wf-title-save", E.status === "busy" ? "Saving…" : "Save", t, (cx) => { this.saveTitle(cx); cx.notify(); }, { on: true }))
          .child(button("wf-title-cancel", "Cancel", t, (cx) => { this.editing = null; this.typing = false; cx.notify(); })))
        .when(E.status === "error", (el) => el.child(div().text_size(12).text_color(t.blocked).child(E.error)));
    }
    return h_flex().gap(8).items_start()
      .child(div().flex_1().min_w(0).text_size(16).font_semibold().text_color(t.foreground).child(title))
      .when(Boolean(tk) && Boolean(b) && this.canUpdate(b), (el) => el.child(button("wf-title-edit", "Edit", t, (cx) => { this.startEdit(sum, title); cx.notify(); })));
  }

  commentForm(t, k) {
    const C = this.commenting?.key === k ? this.commenting : null;
    return v_flex().gap(6)
      .child(div().on_mouse_down("left", stop).rounded(6).border(1).border_color(t.input).bg(t.background).p(6).text_size(12).text_color(t.foreground)
        .child(Textarea.new(this.commentBox).w_full()))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(C?.status === "error" ? t.blocked : t.dim).child(C?.status === "error" ? C.error : ""))
        .child(button("wf-comment-post", C?.status === "busy" ? "Posting…" : "Post comment", t, (cx) => { this.postComment(cx); cx.notify(); }, { on: true })));
  }

  // The detail panel (D11, D23): the summary shows at once, the rest when the Ticket arrives.
  ticketPanel(t) {
    const sum = this.selected.summary;
    const entry = this.tickets[sum.key] ?? { status: "loading" };
    const tk = entry.data;
    const k = sum.key;
    const md = (id, text) => div().text_size(13).text_color(t.foreground).child(TextView.markdown(`wf-${id}-${k}`, text).selectable(true));
    // Text with its images shown in place. One not saved (yet) shows as a link.
    const pic = (url, alt) => {
      const im = this.images[url];
      if (im?.status === "ok") return div().max_w_full().rounded(6).overflow_hidden().border_1().border_color(t.border).child(image(im.file).max_w_full());
      return div().text_size(12).text_color(t.dim).child(im?.status === "error" ? `Couldn't load image: ${im.error}` : `Loading ${alt || "image"}…`);
    };
    const rich = (id, text) => {
      const parts = [];
      let at = 0, n = 0;
      for (const m of String(text).matchAll(IMAGE_MD)) {
        const before = text.slice(at, m.index);
        if (before.trim()) parts.push(md(`${id}-${n++}`, before));
        const alt = m[1].replace(/\\(.)/g, "$1");
        parts.push(this.images[m[2]] ? pic(m[2], alt) : md(`${id}-${n++}`, link(alt || "image", m[2])));
        at = m.index + m[0].length;
      }
      if (String(text).slice(at).trim() || !parts.length) parts.push(md(`${id}-${n}`, String(text).slice(at)));
      return v_flex().gap(8).children(parts);
    };
    const section = (title) => div().pt(8).text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase());
    const row = (label, value) => h_flex().gap(8).items_start().text_size(12)
      .child(div().w(84).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_color(t.foreground).child(value || "—"));

    const head = h_flex().h(40).px(14).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
      .child(div().text_size(12).text_color(t.muted).truncate().child(`${(tk ?? sum).id} · ${(tk ?? sum).type}`))
      .child(div().flex_1())
      .when(entry.status === "loading", (el) => el.child(div().text_size(12).text_color(t.dim).child("Loading…")))
      .when(Boolean(tk), (el) => el.child(button("wf-launch", this.launch?.key === k ? "Cancel launch" : "Launch", t,
        (cx) => { if (this.launch?.key === k) this.launch = null; else this.openLaunch(tk, cx); cx.notify(); }, { on: this.launch?.key === k })))
      .child(button("wf-ticket-close", "Close", t, (cx) => { this.closeTicket(); cx.notify(); }));

    const body = v_flex().id(`wf-ticket-body-${k}`).flex_1().min_h(0).p(14).gap(10).overflow_y_scrollbar()
      .child(this.titleRow(t, sum, tk))
      .when(entry.status === "error", (el) => el.child(div().text_size(12).text_color(t.blocked).child(entry.error)))
      .when(!tk && entry.status === "loading", (el) => el.child(skeletonTicket(t)));
    const ub = this.profile.boards.find((x) => x.id === this.selected.boardId);
    if (tk && this.launch?.key === k) body.child(this.launchCard(t, tk));
    const mb = this.profile.boards.find((x) => x.id === this.selected.boardId);
    const mr = mb && this.moveRow(t, mb, sum);
    if (mr) body.child(mr);
    if (tk) {
      body
        .child(v_flex().gap(6)
          .child(row("Column", tk.column))
          .child(row("Assignees", tk.assignees.map((a) => a.name).join(", ")))
          .child(row("Tags", tk.tags.join(", ")))
          .child(row("Priority", tk.priority))
          .child(row("Parent", tk.parent ? `${tk.parent.id} ${tk.parent.title}` : null)))
        .when(Boolean(tk.url), (el) => el.child(md("url", link("Open in browser", tk.url))))
        .child(section(tk.descriptionLabel ?? "Description"))
        .child(tk.description.trim() ? rich("desc", tk.description) : div().text_size(12).text_color(t.dim).child("No description."))
        .when(tk.acceptanceCriteria != null, (el) => el.child(section("Acceptance criteria")).child(rich("ac", tk.acceptanceCriteria ?? "")))
        .when((tk.images ?? []).length > 0, (el) => el.child(section(`Attached images (${tk.images.length})`))
          .children(tk.images.map((im) => v_flex().gap(4).child(div().text_size(11).text_color(t.dim).child(im.name)).child(pic(im.url, im.name)))))
        .child(section(`Pull requests (${tk.pullRequests.length})`))
        .when(tk.pullRequests.length > 0, (el) => el.child(md("prs", tk.pullRequests
          .map((pr) => `- ${link(`${pr.id} ${pr.title}`, pr.url)}${pr.draft || pr.state ? ` · ${pr.draft ? "draft" : pr.state}` : ""}`).join("\n"))))
        .child(section(`Comments (${tk.comments.length + tk.moreComments})`))
        .when(Boolean(ub) && this.canUpdate(ub), (el) => el.child(this.commentForm(t, k)))
        .when(tk.moreComments > 0, (el) => el.child(md("more", link(`${tk.moreComments} older comments`, tk.url))))
        .children(tk.comments.map((c, i) => v_flex().gap(4).p(10).rounded(8).bg(t.surface).border_1().border_color(t.border)
          .child(div().text_size(11).text_color(t.dim).child(`${c.author} · ${String(c.createdAt ?? "").slice(0, 10)}`))
          .child(rich(`c${i}`, c.body))));
    }
    return v_flex().id("wf-ticket").w(PANEL_W).flex_none().h_full().bg(t.chrome).border_l(1).border_color(t.border)
      .child(head).child(body);
  }

  body(t) {
    const s = this.state;
    if (s.status === "loading") return this.message(t, "Loading…", []);
    if (this.view === "settings" && s.status !== "invalid") return this.settingsView(t);
    if (s.status === "missing") {
      return this.message(t, "No configuration yet", [`Open Settings to add a profile, or create ${s.path} and press Refresh. A minimal file:`])
        .child(div().p(10).rounded(6).bg(t.surface).border_1().border_color(t.border).text_size(12)
          .child(TextView.markdown("wf-example", "```json\n" + EXAMPLE + "\n```").selectable(true)));
    }
    if (s.status === "invalid") return this.message(t, "The configuration has problems", [s.path, ...s.errors]);
    if (this.view === "board") return this.boardView(t);
    return this.prsView(t);
  }

  // Two sections (D6), each grouped by Account, then repo.
  prsView(t) {
    const p = this.profile, entry = this.prs ?? { status: "loading" };
    const bar = h_flex().h(40).px(16).gap(10).flex_none().items_center()
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Pull Requests"))
      .child(div().flex_1())
      .when(entry.status === "loading" || Boolean(entry.at), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim)
        .child(entry.status === "loading" ? (entry.data ? "Refreshing…" : "Loading…") : `Updated ${formatAge(Date.now() - entry.at)}`)));
    const signedOut = (id) => this.signIn?.[id]?.ok === false;
    const lists = entry.data ?? [];
    const ok = lists.filter((l) => !l.error && !signedOut(l.account));
    const accounts = new Map(p.accounts.map((a) => [a.id, a]));
    const note = (text, color = t.dim) => div().text_size(12).text_color(color).child(text);
    const section = (title, field) => {
      const total = ok.reduce((n, l) => n + l[field].length, 0);
      const groups = ok.filter((l) => l[field].length > 0).flatMap((l) => {
        const a = accounts.get(l.account);
        return [
          ...(ok.length > 1 ? [div().pt(4).text_size(12).text_color(t.dim).child(`${l.account} · ${a?.login ?? a?.org ?? ""}`)] : []),
          ...byRepo(l[field]).map((g) => v_flex().rounded(8).bg(t.surface).border_1().border_color(t.border).overflow_hidden()
            .child(div().px(12).py(6).text_size(12).font_semibold().text_color(t.foreground).child(g.repo))
            .children(g.prs.map((pr) => prRow(pr, t, { state: this.reviews[pr.key], start: (cx) => this.startReview(l.account, pr, cx) })))),
          ...(l.more?.[field] ? [note(`${l.more[field]} more not shown`)] : []),
        ];
      });
      return v_flex().gap(8).child(div().text_size(12).font_semibold().text_color(t.muted).child(`${title} (${total})`))
        .children(total === 0 ? [note("None")] : groups);
    };
    const top = [
      ...p.accounts.filter((a) => signedOut(a.id)).map((a) => this.signInCard(t, a, this.signIn[a.id])),
      ...lists.filter((l) => l.error && !signedOut(l.account)).map((l) => note(`${l.account}: couldn't load Pull Requests: ${l.error}`, t.blocked)),
    ];
    const body = entry.data ? [section("Mine", "mine"), section("Needs my review", "needsReview")] : (entry.status === "loading" ? [] : [note("No Pull Requests yet.")]);
    return v_flex().size_full().min_h(0).child(bar)
      .child(v_flex().id("wf-prs").flex_1().min_h(0).px(16).pb(16).gap(16).overflow_y_scrollbar().children([...top, ...body]));
  }

  // Shown while fullscreen is wanted but off (Close, the tab bar, another panel left it): back to
  // fullscreen. By state, not by noticing a hide, so a quick hide and show counts too. Deferred: the
  // layout can't change during render.
  restoreFullscreen(cx) {
    if (this.restoring || this.fullscreen || load(WANT_FULL_KEY, "0") !== "1") return;
    this.restoring = true;
    cx.timer.after(0, () => {
      this.restoring = false;
      if (this.shownNow() && !this.fullscreen && load(WANT_FULL_KEY, "0") === "1") this.setFullscreen(true, { remember: false });
    });
  }

  render(cx) {
    if (this.hidden) this.watch(cx); // just shown: refresh in the background
    this.restoreFullscreen(cx);
    const t = theme();
    return v_flex().id("wf-root").size_full().bg(t.background)
      .track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.selected) this.closeTicket(); else this.setFullscreen(false);
          cx.notify(); return;
        }
        if (this.typing) return; // keys in a text box are for the text
        if (this.boardKey(e.key, cx, Boolean(e.modifiers?.shift))) { cx.stop_propagation(); cx.notify(); }
      })
      .child(this.header(t))
      .child(v_flex().id("wf-body").flex_1().min_h(0).child(this.body(t)));
  }
}
