// Wayfinder: one Profile's Boards and Pull Requests, in the layout's side panel beside Wingman
// (a "wayfinder" block in the "panel-body" stack; the tab bar's Wayfinder button shows it).
// Fullscreen hides the "main" block and stretches the panel; tabs-plus undoes it when Wayfinder
// stops showing. Esc closes the Ticket detail panel, then leaves fullscreen.
// Board data comes from the cache at once, then refreshes in the background on show and every
// 30 minutes while shown. Nothing runs while hidden (D25).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { run, layout, shared, setShared, theme, appHome, readTextFile, writeTextFile, nextCommand, notify, window as herdrWindow } from "herdr";
import { parseConfig } from "./config.js";
import { createRunner } from "./runner.js";
import { loadBoard, loadTicket, loadPullRequests, signInStates } from "./flow.js";
import { shellInvocation } from "./command.js";
import { byColumn, byRepo, initials, trackColumns } from "./providers/contract.js";
import { cacheFile, parseCache, serializeCache, cachedBoard, withBoard, cachedPrs, withPrs, prsKey, formatAge, isShown, due } from "./cache.js";

const VIEW_KEY = "wayfinder.view.v1";
const COLUMN_W = 280, PANEL_W = 460;
const FULL_KEY = "wayfinder.fullscreen"; // { px }: the panel's width before fullscreen
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
const load = (k, fallback) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* nicety only */ } };

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

// Markdown link text: brackets would end the link early.
const linkText = (s) => String(s ?? "").replace(/([[\]\\])/g, "\\$1");
const link = (label, url) => url ? `[${linkText(label)}](<${url}>)` : linkText(label);

function card(tk, t, selected, onClick) {
  return v_flex().id(`wf-card-${tk.key}`).gap(6).p(10).rounded(8).bg(t.surface).border_1().border_color(selected ? t.accent : t.border)
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

function prRow(pr, t) {
  return h_flex().id(`wf-pr-${pr.key}`).gap(12).px(12).py(8).items_center().border_t(1).border_color(t.border)
    .child(v_flex().flex_1().min_w(0).gap(4)
      .child(h_flex().gap(8).items_center().min_w(0)
        .when(pr.draft, (el) => el.child(h_flex().h(18).px(6).flex_none().items_center().rounded(9).bg(t.selected).text_size(11).text_color(t.muted).child("Draft")))
        .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(pr.title)))
      .child(div().text_size(11).text_color(t.dim).truncate()
        .child(`${pr.id} · ${pr.author.name}${pr.updatedAt ? ` · updated ${formatAge(Date.now() - Date.parse(pr.updatedAt))}` : ""}`)))
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
    this.view = load(VIEW_KEY, "board") === "prs" ? "prs" : "board";
    this.state = { status: "loading" };
    this.checks = null;
    this.boards = {}; // board id -> { status: "cached" | "loading" | "ok" | "error", data, at, tried, error }
    this.hidden = true; // until seen on screen: the first show refreshes
    this.lastRefresh = null;
    this.selected = null; // { boardId, summary }: the Ticket in the detail panel
    this.tickets = {}; // ticket key -> { status, data, error }
    this.prs = null; // { status, data: loadPullRequests()'s list, at, tried, error }
    this.reload(cx);
    cx.timer.every(60_000, (cx) => { if (this.watch(cx)) cx.notify(); }); // reads the layout only: no requests
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

  setFullscreen(on) {
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

  close_() { this.setFullscreen(false); run("layout.hide", { id: "panel" }); }

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
    if (this.view === "prs") this.fetchPrs(cx);
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

  reload(cx) {
    const before = this.profile?.name ?? this.lastProfile;
    this.state = { status: "loading" };
    this.boards = {};
    this.tickets = {};
    this.prs = null;
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
      if (this.state.status === "ok") this.watch(cx);
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
        if (this.profile !== profile) return; // a reload replaced the Profile meanwhile
        this.boards[b.id] = { status: "error", data: prev?.data ?? null, at: prev?.at ?? null, tried, error: String(e.message ?? e) };
        cx.notify();
        return;
      }
      if (this.profile !== profile) return;
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
      if (this.profile !== profile) return; // a reload replaced the Profile meanwhile
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
      if (this.profile !== profile) return; // a reload replaced the Profile meanwhile
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
      if (this.profile !== p) return; // a reload replaced the Profile meanwhile
      this.tickets[key] = next;
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

  header(t) {
    return h_flex().h(44).px(12).gap(10).flex_none().items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Wayfinder"))
      .child(segmented("wf-view", [["board", "Board"], ["prs", "Pull Requests"]], this.view, t, (key, cx) => {
        this.showView(key, cx); cx.notify();
      }))
      .child(div().flex_1())
      .when(Boolean(this.profile) && this.state.profileNames.length > 1, (el) => el.child(segmented("wf-profiles",
        this.state.profileNames.map((n) => [n, n]), this.profile.name, t, (name, cx) => cx.spawn(async (cx) => { await this.switchProfile(name, cx); cx.notify(); }))))
      .child(button("wf-refresh", "Refresh", t, (cx) => this.reload(cx)))
      .child(button("wf-full", this.fullscreen ? "Exit fullscreen" : "Fullscreen", t, (cx) => { this.setFullscreen(!this.fullscreen); cx.notify(); }, { on: this.fullscreen }))
      .child(button("wf-close", "Close", t, () => this.close_()));
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
        .children(byColumn(b.trackedStatuses?.length ? trackColumns(entry.data, b.trackedStatuses) : entry.data, { mine }).map(({ column, tickets }) =>
          v_flex().id(`wf-col-${column.id}`).w(COLUMN_W).flex_none().max_h_full().rounded(10).bg(t.chrome).border_1().border_color(t.border)
            .child(h_flex().h(36).px(12).gap(8).flex_none().items_center()
              .child(div().text_size(12).font_semibold().text_color(t.foreground).truncate().child(column.name))
              .child(div().text_size(11).text_color(t.dim).child(String(tickets.length))))
            .child(v_flex().id(`wf-col-body-${column.id}`).px(8).pb(8).gap(8).overflow_y_scrollbar()
              .children(tickets.map((tk) => card(tk, t, this.selected?.summary.key === tk.key, (cx) => this.openTicket(b, tk, cx)))))));
    }
    const panel = this.selected?.boardId === b.id && !(si && !si.ok) ? this.ticketPanel(t) : null;
    // The detail panel takes the full height under the header, beside the Board's bar and Columns.
    return h_flex().size_full().items_start()
      .child(v_flex().flex_1().min_w(0).h_full().child(bar).child(content))
      .when(Boolean(panel), (el) => el.child(panel));
  }

  // The detail panel (D11, D23): the summary shows at once, the rest when the Ticket arrives.
  ticketPanel(t) {
    const sum = this.selected.summary;
    const entry = this.tickets[sum.key] ?? { status: "loading" };
    const tk = entry.data;
    const k = sum.key;
    const md = (id, text) => div().text_size(13).text_color(t.foreground).child(TextView.markdown(`wf-${id}-${k}`, text).selectable(true));
    const section = (title) => div().pt(8).text_size(11).font_semibold().text_color(t.dim).child(title.toUpperCase());
    const row = (label, value) => h_flex().gap(8).items_start().text_size(12)
      .child(div().w(84).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_color(t.foreground).child(value || "—"));

    const head = h_flex().h(40).px(14).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
      .child(div().text_size(12).text_color(t.muted).truncate().child(`${(tk ?? sum).id} · ${(tk ?? sum).type}`))
      .child(div().flex_1())
      .when(entry.status === "loading", (el) => el.child(div().text_size(12).text_color(t.dim).child("Loading…")))
      .child(button("wf-ticket-close", "Close", t, (cx) => { this.closeTicket(); cx.notify(); }));

    const body = v_flex().id(`wf-ticket-body-${k}`).flex_1().min_h(0).p(14).gap(10).overflow_y_scrollbar()
      .child(div().text_size(16).font_semibold().text_color(t.foreground).child((tk ?? sum).title))
      .when(entry.status === "error", (el) => el.child(div().text_size(12).text_color(t.blocked).child(entry.error)))
      .when(!tk && entry.status === "loading", (el) => el.child(skeletonTicket(t)));
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
        .child(tk.description.trim() ? md("desc", tk.description) : div().text_size(12).text_color(t.dim).child("No description."))
        .when(tk.acceptanceCriteria != null, (el) => el.child(section("Acceptance criteria")).child(md("ac", tk.acceptanceCriteria ?? "")))
        .child(section(`Pull requests (${tk.pullRequests.length})`))
        .when(tk.pullRequests.length > 0, (el) => el.child(md("prs", tk.pullRequests
          .map((pr) => `- ${link(`${pr.id} ${pr.title}`, pr.url)}${pr.draft || pr.state ? ` · ${pr.draft ? "draft" : pr.state}` : ""}`).join("\n"))))
        .child(section(`Comments (${tk.comments.length + tk.moreComments})`))
        .when(tk.moreComments > 0, (el) => el.child(md("more", link(`${tk.moreComments} older comments`, tk.url))))
        .children(tk.comments.map((c, i) => v_flex().gap(4).p(10).rounded(8).bg(t.surface).border_1().border_color(t.border)
          .child(div().text_size(11).text_color(t.dim).child(`${c.author} · ${String(c.createdAt ?? "").slice(0, 10)}`))
          .child(md(`c${i}`, c.body))));
    }
    return v_flex().id("wf-ticket").w(PANEL_W).flex_none().h_full().bg(t.chrome).border_l(1).border_color(t.border)
      .child(head).child(body);
  }

  body(t) {
    const s = this.state;
    if (s.status === "loading") return this.message(t, "Loading…", []);
    if (s.status === "missing") {
      return this.message(t, "No configuration yet", [`Create ${s.path} and press Refresh. A minimal file:`])
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
            .children(g.prs.map((pr) => prRow(pr, t)))),
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

  render(cx) {
    if (this.hidden) this.watch(cx); // just shown: refresh in the background
    const t = theme();
    return v_flex().id("wf-root").size_full().bg(t.background)
      .track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.selected) this.closeTicket(); else this.setFullscreen(false);
        cx.notify();
      })
      .child(this.header(t))
      .child(v_flex().id("wf-body").flex_1().min_h(0).child(this.body(t)));
  }
}
