// Wranglr: the spaces sidebar sorted into Groups (Workspaces, Repos, Custom groups), with
// Subgroups, drag and drop, a move dialog and its own select/next/prev keys. Started from
// Herdr's `spaces` mod: the row, its git tail, the rail and the machine guidance are its.
// Every rule lives in model.js. This file builds the World, sends actions through `act`,
// runs the effects and draws the Tree. The copy in the layout owns the state; overlay copies
// of this mod (move dialog, menus, text input) send their action to it through shared state.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import {
  spaces, machines, panes, agents, focused, run, openOverlay, closeOverlay, props, exec, hc, theme,
  shared, setShared, watchFolder, window, layout, home, nextCommand,
} from "herdr";
import { emptyState, mkey, clonedMap, arrange, act, workspaceHome } from "./model.js";
import { parseConfig, loadConfig, settingError, DEFAULT_SETTINGS } from "./config.js";
import { makeResolver } from "./repos.js";
import { loadState, makeSaver } from "./store.js";
import { writeWorkspaceFile } from "./workspacefile.js";
import { runEffects } from "./effects.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
const CONFIG_EVERY = 5000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const SORT_LABEL = { recent: "Recent", kind: "Kind", az: "A-Z", manual: "Manual" };
const KIND_ICON = { workspace: "layers", repo: "git-branch", custom: "folder" };
const icon = (name) => `mods/workspace-chrome/${name}.svg`;

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// Overlays hand their action to the owner: a counter, so the owner runs each one once.
function send(action) {
  const n = (shared("wranglr.action")?.n ?? 0) + 1;
  setShared("wranglr.action", { n, action });
}

// The key an input dialog's text fills in its action.
const textKey = (action) => (action?.type === "plus" ? "branch" : "name");

function openInput(input) {
  openOverlay({ mod: "wranglr", kind: "dialog", width: 420, props: { dialog: "input", ...input } });
}

function openMenu(items) {
  // A popup is as tall as its items; height is only the most.
  openOverlay({ mod: "wranglr", kind: "popup", width: 220, height: 300, props: { dialog: "menu", items } });
}

export default class Wranglr extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.dialog = p.overlay ? p.dialog ?? "none" : null;
    if (this.dialog === "move" || this.dialog === "input") this.initInput(cx);
    else if (this.dialog === "settings") this.initSettings(cx);
    else if (this.dialog === "menu") { this.at = 0; this.handle = cx.focus_handle(); this.handle.focus(); }
    else if (!this.dialog) this.initOwner(cx);
  }

  // The owner

  initOwner(cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    this.pressed = null; // { kind: "row" | "group" | "sub", id, group?, sub? } while the button is down
    this.over = null; // the drop target under the pointer: { kind, id, group?, sub?, below }
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;

    const parsed = parseConfig(null);
    this.config = parsed.config;
    this.errors = [];
    this.configText = undefined;
    this.state = emptyState();
    this.resolver = makeResolver();
    this.saver = makeSaver();
    this.resolving = new Set();
    this.tree = null;
    this.loaded = false;
    this.syncedKey = null;
    this.filesKey = null;
    this.kicked = false;
    // Actions sent before this copy started are not ours to run.
    this.handled = shared("wranglr.action")?.n ?? 0;

    cx.spawn(async (cx) => {
      await this.reloadConfig();
      this.state = await loadState(emptyState()).catch(() => emptyState());
      this.loaded = true;
      this.tick(cx);
      cx.notify();
    });
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    cx.timer.every(CONFIG_EVERY, (cx) => cx.spawn(async (cx) => {
      if (await this.reloadConfig()) { this.filesKey = null; this.tick(cx); cx.notify(); }
    }));
    // "wranglr.<command>" in keys.json and the palette.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).replace(/^wranglr[.:]/, "");
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  async close() {
    if (!this.dialog && this.saver) await this.saver.flush();
  }

  // The config file's text changed: true. A missing file is the defaults.
  async reloadConfig() {
    let loaded;
    try { loaded = await loadConfig(); } catch { loaded = { ...parseConfig(null), text: null }; }
    if (loaded.text === this.configText) return false;
    this.configText = loaded.text;
    this.config = loaded.config;
    this.errors = loaded.errors;
    return true;
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    this.tick(cx);
  }

  // Runs an action an overlay sent, then a sync when the World's inputs changed.
  tick(cx) {
    this.kicked = false;
    if (!this.loaded) return;
    const msg = shared("wranglr.action");
    if (msg && typeof msg.n === "number") {
      if (msg.n < this.handled) this.handled = msg.n;
      else if (msg.n > this.handled) {
        this.handled = msg.n;
        if (msg.action) this.dispatch(msg.action, cx);
      }
    }
    const world = this.world(cx);
    const key = this.inputsKey(world);
    if (key !== this.syncedKey) {
      this.syncedKey = key;
      this.dispatch({ type: "sync" }, cx, world);
    }
    this.writeFiles(cx);
  }

  // What the model sees. With a cx, Repos not resolved yet are asked for.
  world(cx) {
    const all = spaces(), ps = panes();
    const repos = {};
    // A space made just now waits (at most a moment) for its git, so it appears in its Group instead of jumping there.
    const now = Date.now();
    this.born ??= {};
    const sp = all.filter((s) => {
      if (s.id in (this.state?.snap ?? {})) return true;
      const dir = place(s, ps);
      if (!dir || this.resolver.get(dir, s.machine) !== undefined) return true;
      if (cx) this.resolve(dir, s.machine, cx);
      return now - (this.born[s.id] ??= now) > 1500;
    });
    for (const s of sp) {
      const dir = place(s, ps);
      if (!dir) { repos[s.id] = null; continue; }
      const repo = this.resolver.get(dir, s.machine);
      repos[s.id] = repo;
      // Not in a repo is asked again after a minute: git may have failed, or the folder became a repo.
      if (cx && (repo === undefined || (repo === null && this.retryDue(dir, s.machine)))) this.resolve(dir, s.machine, cx);
    }
    const titles = {};
    for (const a of agents()) if (a.title && !(a.space in titles)) titles[a.space] = a.title;
    const ms = machines().map((m) => ({ name: m.name, layout: m.layout }));
    if (!ms.some((m) => m.name === null)) ms.push({ name: null, layout: "ready" });
    return {
      spaces: sp, machines: ms, repos, titles,
      focus: focused()?.space ?? null,
      local: { home: home(), windows: window().platform === "windows" },
      cloned: clonedMap(this.config, this.state),
    };
  }

  retryDue(dir, machine) {
    const k = JSON.stringify([machine ?? null, dir]);
    return Date.now() - ((this.tried ??= {})[k] ?? 0) > 61000;
  }

  resolve(dir, machine, cx) {
    const k = JSON.stringify([machine ?? null, dir]);
    if (this.resolving.has(k)) return;
    (this.tried ??= {})[k] = Date.now();
    this.resolving.add(k);
    cx.spawn(async (cx) => {
      try { await this.resolver.want(dir, machine); } catch {}
      this.resolving.delete(k);
      cx.notify();
    });
  }

  // A sync is due when this changes. Activity counts only under the recent sort.
  inputsKey(world) {
    const activity = (s) => Math.max(0, ...(s.tabs ?? []).map((t) => Math.max(t.changed_at || 0, t.working_since || 0)));
    return JSON.stringify([
      world.spaces.map((s) => [s.id, s.name, s.named, s.folder, s.branch, s.machine]),
      world.machines.map((m) => [m.name, m.layout]),
      world.repos, world.titles, world.cloned, this.configText ?? null,
      this.config.settings.sort === "recent" ? world.spaces.map(activity) : 0,
    ]);
  }

  // The one place `act` is called.
  dispatch(action, cx, world = this.world(cx)) {
    if (!this.loaded) return;
    const { state, effects } = act(action, world, this.config, this.state);
    if (state !== this.state) {
      this.state = state;
      this.saver.save(state);
    }
    // The file is read again only every few seconds: the new setting applies now.
    for (const e of effects)
      if (e.type === "setting") this.config = { ...this.config, settings: { ...this.config.settings, [e.key]: e.value } };
    // An `ask` can take a minute: it runs apart, and nothing waits for either.
    const asks = effects.filter((e) => e.type === "ask"), rest = effects.filter((e) => e.type !== "ask");
    for (const list of [rest, asks])
      if (list.length) cx.spawn(async (cx) => { await runEffects(list, { dispatch: (a) => this.dispatch(a, cx) }); });
    this.tree = arrange({ ...world, cloned: clonedMap(this.config, this.state) }, this.config, this.state);
    this.publish();
    cx.notify();
  }

  // What overlays need, shared only when it changed (a setShared re-renders every mod).
  publish() {
    const s = this.config.settings;
    const view = {
      groups: this.tree.groups.map((g) => ({
        id: g.id, kind: g.kind, name: g.name, subgroups: g.subgroups.map((x) => ({ id: x.id, name: x.name })), machines: g.machines,
      })),
      focus: focused()?.space ?? null, sort: s.sort, plus: s.plus,
    };
    if (JSON.stringify(view) !== JSON.stringify(shared("wranglr.view") ?? null)) setShared("wranglr.view", view);
  }

  // Each Workspace's .code-workspace file, on each ready Machine where it has a home.
  writeFiles(cx) {
    const cloned = clonedMap(this.config, this.state);
    const ms = machines();
    const ready = ms.filter((m) => m.layout === "ready").map((m) => mkey(m.name));
    if (!ms.some((m) => m.name === null)) ready.push("");
    const key = JSON.stringify([cloned, this.configText ?? null, ready]);
    if (key === this.filesKey) return;
    this.filesKey = key;
    const local = { home: home(), windows: window().platform === "windows" };
    const jobs = [];
    for (const ws of this.config.workspaces)
      for (const mk of ready) {
        const dir = workspaceHome(ws, mk, cloned, local);
        if (dir != null) jobs.push(() => writeWorkspaceFile(ws, mk === "" ? null : mk, cloned, dir));
      }
    if (jobs.length) cx.spawn(async () => { for (const job of jobs) { try { await job(); } catch {} } });
  }

  // Where a space is in the Tree: { group, sub } ("" for loose), or null.
  placeOf(id) {
    for (const g of this.tree?.groups ?? []) {
      if (g.rows.some((r) => r.id === id)) return { group: g.id, sub: null };
      for (const s of g.subgroups) if (s.rows.some((r) => r.id === id)) return { group: g.id, sub: s.id };
    }
    return this.tree?.loose.some((r) => r.id === id) ? { group: "", sub: null } : null;
  }

  command(c, cx) {
    const focus = focused()?.space ?? null;
    const n = /^select:?(\d+)$/.exec(c);
    if (n) this.dispatch({ type: "select", index: Number(n[1]) }, cx);
    else if (c === "next" || c === "prev") this.dispatch({ type: c }, cx);
    else if (c === "fold") this.dispatch({ type: "foldFocused" }, cx);
    else if (c === "sort") this.dispatch({ type: "sort", value: null }, cx);
    else if (c === "settings") this.openSettings();
    else if (c === "name" && focus) this.dispatch({ type: "name", space: focus }, cx);
    else if (c === "move" && focus) this.openMove(focus);
    else if (c === "new") {
      const at = focus && this.placeOf(focus);
      const g = at?.group && this.tree.groups.find((x) => x.id === at.group);
      if (g) this.plus(g, at.sub, cx);
      else run("space.new");
    }
  }

  openMove(space) {
    openOverlay({ mod: "wranglr", kind: "dialog", width: 420, props: { dialog: "move", space, at: this.placeOf(space) } });
  }

  openSettings() {
    openOverlay({ mod: "wranglr", kind: "dialog", width: 460, props: { dialog: "settings", settings: this.config.settings } });
  }

  // "+": a new space in that Group. A worktree by default asks for its branch first.
  plus(g, sub, cx) {
    const action = { type: "plus", group: g.id, sub, mode: null };
    if (g.kind === "repo" && this.config.settings.plus === "worktree") openInput({ title: "New worktree", value: "", action: { ...action, mode: "worktree" } });
    else this.dispatch(action, cx);
  }

  plusMenu(g, sub) {
    const action = { type: "plus", group: g.id, sub };
    // Machines in priority order, picked with 1, 2, 3…; W makes a worktree.
    const items = g.machines.map((m, i) => ({ label: `Open on ${m || "this computer"}`, key: i < 9 ? String(i + 1) : undefined, action: { ...action, mode: "open", machine: m === "" ? null : m } }));
    if (!items.length) items.push({ label: "Open on this computer", key: "1", action: { ...action, mode: "open" } });
    if (g.kind === "repo") items.push({ label: "New worktree…", key: "w", input: { title: "New worktree", value: "", action: { ...action, mode: "worktree" } } });
    openMenu(items);
  }

  groupMenu(g) {
    const items = [{ label: "Add subgroup…", input: { title: "New subgroup", value: "", action: { type: "addSub", group: g.id } } }];
    if (g.kind === "custom") {
      items.push({ label: "Rename…", input: { title: "Rename group", value: g.name, action: { type: "renameGroup", group: g.id } } });
      items.push({ label: "Remove group", action: { type: "removeCustom", group: g.id } });
    }
    if (g.can.dismiss) items.push({ label: "Dismiss", action: { type: "dismiss", group: g.id } });
    openMenu(items);
  }

  subMenu(g, s) {
    openMenu([
      { label: "Rename…", input: { title: "Rename subgroup", value: s.name, action: { type: "renameSub", group: g.id, sub: s.id } } },
      { label: "Remove subgroup", action: { type: "removeSub", group: g.id, sub: s.id } },
    ]);
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        await Promise.all(keys.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await Promise.all([
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      ]);
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await Promise.all([
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      ]);
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  spaceMenu(id) {
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id } } });
  }

  // Drag and drop

  press(target) {
    this.pressed = target;
    this.over = null;
  }

  hover(target, e, cx) {
    if (!this.pressed) return;
    const below = e?.local_position && e?.bounds ? e.local_position.y > e.bounds.height / 2 : false;
    const next = { ...target, below };
    if (JSON.stringify(next) !== JSON.stringify(this.over)) { this.over = next; cx.notify(); }
  }

  // Released on a row: a press there with no drop elsewhere selects it.
  releaseRow(r, at, after, cx) {
    const from = this.pressed, below = this.over?.id === r.id && this.over.below;
    this.pressed = this.over = null;
    if (from?.kind !== "row") return;
    if (from.id === r.id) run("space.select", { id: r.id });
    else this.dispatch({ type: "drop", space: from.id, group: at.group, sub: at.sub, before: below ? after : r.id }, cx);
  }

  releaseGroup(g, after, cx) {
    const from = this.pressed, below = this.over?.id === g.id && this.over.below;
    this.pressed = this.over = null;
    if (from?.kind === "row") this.dispatch({ type: "drop", space: from.id, group: g.id, sub: null, before: null }, cx);
    else if (from?.kind === "group" && from.id === g.id) this.dispatch({ type: "fold", group: g.id, sub: null }, cx);
    else if (from?.kind === "group") this.dispatch({ type: "dropGroup", group: from.id, before: below ? after : g.id }, cx);
  }

  releaseSub(g, s, cx) {
    const from = this.pressed;
    this.pressed = this.over = null;
    if (from?.kind === "row") this.dispatch({ type: "drop", space: from.id, group: g.id, sub: s.id, before: null }, cx);
    else if (from?.kind === "sub" && from.id === `${g.id}/${s.id}`) this.dispatch({ type: "fold", group: g.id, sub: s.id }, cx);
  }

  releaseEnd(cx) {
    const from = this.pressed;
    this.pressed = this.over = null;
    if (from?.kind === "row") this.dispatch({ type: "drop", space: from.id, group: "", sub: null, before: null }, cx);
  }

  // Drawing the owner. Nothing here calls the model's actions: it reads the last Tree.

  // Only what's unusual, after the name: "herdr · spike ↑2 ↓1". The repo or
  // branch goes when the name already says it, and master/main go: nearly every space is on one.
  gitTail(g, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" · ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)));
  }

  chip(machine, t) {
    return div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10.5).text_color(t.dim).child(machine);
  }

  avatar(id, name, t) {
    const color = (shared("space.colors") ?? {})[id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...name][0]?.toUpperCase() ?? "?");
  }

  // r: a Row. at: its container. after: the id of the row below it there, or null.
  row(r, at, after, indent, d) {
    const { t, live, ps } = d;
    const w = live.get(r.id) ?? r.space;
    const name = w?.name ?? r.name;
    const g = w ? this.git[where(w, ps)] ?? null : null;
    const content = h_flex().gap(9).items_center().pl(indent)
      .child(this.avatar(r.id, name, t))
      .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(name))
      .when(Boolean(r.machine), (el) => el.child(this.chip(r.machine, t)))
      .child(g && !r.dim ? this.gitTail(g, name, t) : div().flex_1());
    const el = v_flex().relative().id(`space-${r.id}`).px(8).h(30).flex_none().justify_center().rounded(8);
    if (r.dim) return el.opacity(0.5).child(content);
    const on = !!w?.active;
    const target = this.pressed?.kind === "row" && this.pressed.id !== r.id && this.over?.kind === "row" && this.over.id === r.id;
    return el
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed?.kind === "row" && this.pressed.id === r.id && this.over && this.over.id !== r.id, (el) => el.opacity(0.5))
      .when(target, (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent).when(this.over.below, (l) => l.bottom(0)).when(!this.over.below, (l) => l.top(0))))
      .on_mouse_down("left", () => this.press({ kind: "row", id: r.id }))
      .on_mouse_move((e, cx) => this.hover({ kind: "row", id: r.id }, e, cx))
      .on_mouse_up("left", (_e, cx) => { this.releaseRow(r, at, after, cx); cx.notify(); })
      .on_mouse_down("right", () => this.spaceMenu(r.id))
      .child(content);
  }

  rows(list, at, indent, d) {
    return list.map((r, i) => this.row(r, at, list.slice(i + 1).find((x) => !x.dim)?.id ?? null, indent, d));
  }

  plusButton(id, g, sub, t) {
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(5)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.plusMenu(g, sub); })
      .on_click((_e, cx) => { cx.stop_propagation(); this.plus(g, sub, cx); })
      .child(svg(icon("plus")).size(11));
  }

  groupHead(g, after, d) {
    const { t } = d;
    const count = g.rows.length + g.subgroups.reduce((n, s) => n + s.rows.length, 0);
    const dragging = this.pressed?.kind === "row" || (this.pressed?.kind === "group" && this.pressed.id !== g.id);
    const over = dragging && this.over?.kind === "group" && this.over.id === g.id;
    const lineFor = this.pressed?.kind === "group" && over;
    return h_flex().relative().id(`group-${g.id}`).h(26).mt(4).px(8).gap(6).flex_none().items_center().rounded(6)
      .text_size(11.5).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .when(over && !lineFor, (el) => el.bg(t.hover).border_1().border_color(t.accent))
      .when(lineFor, (el) => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent).when(this.over.below, (l) => l.bottom(0)).when(!this.over.below, (l) => l.top(0))))
      .on_mouse_down("left", () => this.press({ kind: "group", id: g.id }))
      .on_mouse_move((e, cx) => this.hover({ kind: "group", id: g.id }, e, cx))
      .on_mouse_up("left", (_e, cx) => { this.releaseGroup(g, after, cx); cx.notify(); })
      .on_mouse_down("right", () => this.groupMenu(g))
      .child(svg(icon(g.folded ? "chevron-right" : "chevron-down")).size(11).flex_none())
      .child(svg(icon(KIND_ICON[g.kind])).size(12).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(g.name))
      .when(g.folded && count > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(count))))
      .when(g.can.plus, (el) => el.child(this.plusButton(`group-plus-${g.id}`, g, null, t)));
  }

  subHead(g, s, d) {
    const { t } = d;
    const key = `${g.id}/${s.id}`;
    const over = this.pressed?.kind === "row" && this.over?.kind === "sub" && this.over.id === key;
    return h_flex().id(`sub-${key}`).h(24).pl(24).pr(8).gap(6).flex_none().items_center().rounded(6)
      .text_size(11.5).text_color(t.muted).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .when(over, (el) => el.bg(t.hover).border_1().border_color(t.accent))
      .on_mouse_down("left", () => this.press({ kind: "sub", id: key }))
      .on_mouse_move((e, cx) => this.hover({ kind: "sub", id: key }, e, cx))
      .on_mouse_up("left", (_e, cx) => { this.releaseSub(g, s, cx); cx.notify(); })
      .on_mouse_down("right", () => this.subMenu(g, s))
      .child(svg(icon(s.folded ? "chevron-right" : "chevron-down")).size(10).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(s.name))
      .when(s.folded && s.rows.length > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(s.rows.length))))
      .when(g.can.plus, (el) => el.child(this.plusButton(`sub-plus-${key}`, g, s.id, t)));
  }

  list(d) {
    const out = [];
    const groups = this.tree.groups;
    groups.forEach((g, i) => {
      out.push(this.groupHead(g, groups[i + 1]?.id ?? null, d));
      if (g.folded) return;
      out.push(...this.rows(g.rows, { group: g.id, sub: null }, 0, d));
      for (const s of g.subgroups) {
        out.push(this.subHead(g, s, d));
        if (!s.folded) out.push(...this.rows(s.rows, { group: g.id, sub: s.id }, 16, d));
      }
    });
    if (this.tree.loose.length) out.push(div().h(8).flex_none());
    out.push(...this.rows(this.tree.loose, { group: "", sub: null }, 0, d));
    const { t } = d;
    const over = this.pressed?.kind === "row" && this.over?.kind === "end";
    out.push(div().id("wranglr-end").flex_1().min_h(36).rounded(6)
      .when(over, (el) => el.border_t(2).border_color(t.accent))
      .on_mouse_move((e, cx) => this.hover({ kind: "end", id: "" }, e, cx))
      .on_mouse_up("left", (_e, cx) => { this.releaseEnd(cx); cx.notify(); }));
    return out;
  }

  // The rail: every row in Tree order, numbered as the select keys count.
  railRows(d) {
    const { t, live } = d;
    const byId = new Map();
    for (const g of this.tree.groups) for (const r of [...g.rows, ...g.subgroups.flatMap((s) => s.rows)]) byId.set(r.id, r);
    for (const r of this.tree.loose) byId.set(r.id, r);
    return this.tree.order.map((id, i) => {
      const w = live.get(id) ?? byId.get(id)?.space;
      return railCell(h_flex()
        .id(`space-${id}`)
        .relative()
        .w(RAIL_CELL)
        .h(26)
        .rounded(6)
        .justify_center()
        .items_center()
        .tooltip(w?.name ?? byId.get(id)?.name ?? "")
        .when(!!w?.active, (el) => el.bg(t.selected))
        .when(!w?.active, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => run("space.select", { id }))
        .child(div().text_color(w?.active ? t.foreground : t.muted).child(String(i + 1)))
        .child(div().absolute().right(5).text_color(tone(t, w?.status)).child(glyph(w?.status))));
    });
  }

  // One line per other Machine that is not connected, with the shipped Connect and login Copy.
  machineLines(t, collapsed) {
    const names = [...new Set([...this.machines.map((m) => m.name), ...Object.keys(this.reconnecting)])].sort();
    return names.flatMap((m) => {
      const repair = this.reconnecting[m];
      const machine = this.machines.find((k) => k.name === m) ?? repair?.machine;
      if (machine?.state === "connected" && !repair) return [];
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const state = (machine?.state ?? "asleep").replace(/_/g, " ");
      const server = svg(icon("server")).size(13).flex_none();
      if (collapsed) {
        return [railCell(h_flex().id(`machine-${m}`).w(RAIL_CELL).h(26).justify_center().items_center().rounded(6).text_color(t.dim)
          .tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : `${m} · ${state}`)
          .hover((s) => s.bg(t.hover))
          .on_click(() => { if (login) run("app.settings", { section: "machines" }); })
          .child(server))];
      }
      const head = h_flex().id(`machine-${m}`).h(26).flex_none().px(8).gap(7).items_center().text_size(11).text_color(t.dim)
        .child(server)
        .child(div().flex_1().truncate().child(m))
        .when(!rebuilt && !login, (el) => el.child(div().flex_none().child(state)))
        .when(rebuilt, (el) => el.child(h_flex().flex_none().gap(3).items_center()
          .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
          .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
            .hover((s) => s.text_color(t.foreground))
            .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
            .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
            .child(repair?.busy ? "Connecting…" : "Connect"))))
        .child(div().size(6).rounded(3).flex_none().bg(t.dim));
      const guidance = login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      return [head, ...guidance];
    });
  }

  headerButton(id, t, child, tip, onClick) {
    return div().id(id).h(26).min_w(26).px(4).flex_none().flex().items_center().justify_center().rounded(6)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick).child(child);
  }

  renderOwner(cx) {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    this.kick(cx);

    const d = { t, live: new Map(sp.map((s) => [s.id, s])), ps: panes() };
    const sort = this.config.settings.sort;
    const header = h_flex().h(31).pl(16).pr(10).gap(2).items_center().text_size(11.5).text_color(t.dim)
      .when(collapsed, (el) => el.pl(0).pr(0).justify_center())
      .when(!collapsed, (el) => el.child(div().flex_1().child("Spaces"))
        .child(this.headerButton("wranglr-sort", t, div().text_size(11).child(SORT_LABEL[sort] ?? sort), "Sort: click for the next", (_e, cx) => this.dispatch({ type: "sort", value: null }, cx)))
        .child(this.headerButton("wranglr-group", t, svg(icon("folder-plus")).size(14), "New group", () => openInput({ title: "New group", value: "", action: { type: "addCustom" } })))
        .child(this.headerButton("wranglr-settings", t, svg(icon("settings")).size(14), "Wranglr settings", () => this.openSettings())))
      .child(this.headerButton("space-new", t, svg(icon("plus")).size(14), "New space", () => run("space.new")));
    const warning = this.errors.length && !collapsed
      ? h_flex().id("wranglr-errors").mx(8).mb(4).px(8).h(24).flex_none().gap(6).items_center().rounded(6).bg(t.raised)
        .text_size(11).text_color(t.blocked).tooltip(this.errors.join("\n"))
        .child(div().flex_1().truncate().child(`wranglr.json: ${this.errors.length} problem${this.errors.length > 1 ? "s" : ""}`))
      : null;
    const body = !this.tree
      ? [h_flex().h(28).px(collapsed ? 0 : 8).items_center().when(collapsed, (el) => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…")]
      : collapsed ? this.railRows(d) : this.list(d);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_mouse_up("left", (_e, cx) => { if (this.pressed) { this.pressed = this.over = null; cx.notify(); } })
      .child(header)
      .when(Boolean(warning), (el) => el.child(warning))
      .child(v_flex().id("wranglr-list").flex_1().min_h(0).px(collapsed ? 0 : 8).pb(6).overflow_y_scrollbar().mode("always")
        .children(body))
      .child(v_flex().flex_none().pb(8).children(this.machineLines(t, collapsed)));
  }

  // Herdr re-rendered: a sync or an overlay's action may be due. It runs in a task, never here.
  kick(cx) {
    if (this.kicked || !this.loaded) return;
    const msg = shared("wranglr.action");
    const waiting = typeof msg?.n === "number" && msg.n !== this.handled;
    if (!waiting && this.inputsKey(this.world(null)) === this.syncedKey) return;
    this.kicked = true;
    try { cx.spawn(async (cx) => this.tick(cx)); } catch { this.kicked = false; }
  }

  // Overlays

  initInput(cx) {
    const p = props() ?? {};
    const move = this.dialog === "move";
    this.text = move ? "" : p.value ?? "";
    this.input = InputState.new(move ? { placeholder: "Filter groups…" } : { value: this.text });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.at = null;
    this.scroll = ScrollHandle.new();
  }

  // Move dialog choices: "No group", then each Group and its Subgroups, filtered by words.
  choices() {
    const view = shared("wranglr.view") ?? { groups: [] };
    const all = [{ group: "", sub: null, label: "No group", words: "no group loose" }];
    for (const g of view.groups ?? []) {
      all.push({ group: g.id, sub: null, label: g.name, kind: g.kind, words: g.name });
      for (const s of g.subgroups ?? []) all.push({ group: g.id, sub: s.id, label: s.name, parent: g.name, words: `${g.name} ${s.name}` });
    }
    const words = this.text.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((c) => words.every((w) => c.words.toLowerCase().includes(w)));
  }

  submit() {
    const p = props() ?? {};
    if (this.dialog === "move") {
      const c = this.choices()[this.at ?? 0];
      if (c) send({ type: "move", space: p.space, group: c.group, sub: c.sub });
    } else {
      const text = this.text.trim();
      if (text) send({ ...p.action, [textKey(p.action)]: text });
    }
    closeOverlay(p.overlay);
  }

  renderMove() {
    const t = theme();
    const p = props() ?? {};
    const list = this.choices();
    const here = p.at ?? null;
    if (this.at === null) this.at = Math.max(0, list.findIndex((c) => here && c.group === here.group && (c.sub ?? null) === (here.sub ?? null)));
    this.at = Math.max(0, Math.min(this.at, list.length - 1));
    const name = spaces().find((s) => s.id === p.space)?.name ?? "space";
    return v_flex().id("wranglr-move").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(p.overlay);
        else if (e.key === "down" && list.length) this.at = (this.at + 1) % list.length;
        else if (e.key === "up" && list.length) this.at = (this.at + list.length - 1) % list.length;
        else return;
        this.scroll.scroll_to_item(this.at);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().truncate().text_size(15).font_semibold().text_color(t.foreground).child(`Move ${name}`))
        .child(div().id("wm-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(p.overlay)).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg(icon("search")).size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(v_flex().id("wm-list").max_h(300).min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(list.map((c, i) => {
          const current = here && c.group === here.group && (c.sub ?? null) === (here.sub ?? null);
          return h_flex().id(`wm-${i}`).h(30).flex_none().mx(2).px(10).gap(8).items_center().rounded(7).cursor_pointer()
            .when(c.sub != null, (el) => el.pl(30))
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .on_click(() => { this.at = i; this.submit(); })
            .when(c.sub == null, (el) => el.child(svg(icon(c.kind ? KIND_ICON[c.kind] : "minus")).size(13).flex_none().text_color(t.dim)))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.label))
            .when(Boolean(current), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("current")));
        })));
  }

  renderInput() {
    const t = theme();
    const p = props() ?? {};
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("wranglr-input").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(p.title ?? ""))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child(textKey(p.action) === "branch" ? "Branch" : "Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("wi-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("wi-save", "Save", true, () => this.submit())));
  }

  // The settings menu: the `settings` block of wranglr.json. Save writes only what changed.
  initSettings(cx) {
    const s = props()?.settings ?? DEFAULT_SETTINGS;
    this.was = { sort: s.sort, plus: s.plus, autoname: s.autoname };
    this.pick = { ...this.was };
    this.wasText = { worktrees: s.worktrees ?? "", ticket: s.ticket ?? "", agent: (s.agent ?? []).join(" ") };
    this.text = { ...this.wasText };
    this.bad = {};
    this.inputs = {};
    const hint = { worktrees: DEFAULT_SETTINGS.worktrees, ticket: DEFAULT_SETTINGS.ticket, agent: "A plain terminal" };
    for (const key of Object.keys(this.text)) {
      const input = InputState.new({ value: this.text[key], placeholder: hint[key] });
      input.on("change", (_e, cx) => { this.text[key] = input.value(); delete this.bad[key]; cx.notify(); });
      input.on("submit", (_e, cx) => { this.saveSettings(); cx?.notify?.(); });
      this.inputs[key] = input;
    }
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  saveSettings() {
    const values = {}, bad = {};
    for (const key of Object.keys(this.pick)) if (this.pick[key] !== this.was[key]) values[key] = this.pick[key];
    for (const key of Object.keys(this.text)) {
      const raw = this.text[key].trim();
      if (raw === this.wasText[key].trim()) continue;
      // An empty field is the default: a plain terminal for the agent.
      const value = key === "agent" ? (raw ? raw.split(/\s+/) : null) : raw || DEFAULT_SETTINGS[key];
      const why = settingError(key, value);
      if (why) bad[key] = why;
      else values[key] = value;
    }
    this.bad = bad;
    if (Object.keys(bad).length) return;
    if (Object.keys(values).length) send({ type: "settings", values });
    closeOverlay(props()?.overlay);
  }

  renderSettings() {
    const t = theme();
    const p = props() ?? {};
    const field = (label, control, key, about) => v_flex().gap(6)
      .child(div().text_size(11.5).text_color(t.dim).child(label))
      .child(control)
      .when(Boolean(this.bad[key] || about), (el) => el.child(div().text_size(11).text_color(this.bad[key] ? t.blocked : t.dim).child(this.bad[key] ? `This ${this.bad[key]}.` : about)));
    const pick = (key, options) => h_flex().gap(5).children(options.map(([value, label]) => {
      const on = this.pick[key] === value;
      return h_flex().id(`ws-${key}-${value}`).h(28).px(11).items_center().rounded(7).border_1().cursor_pointer()
        .border_color(on ? t.accent : t.input).bg(on ? t.selected : t.raised).text_size(12).text_color(on ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.pick[key] = value; cx.notify(); })
        .child(label);
    }));
    const text = (key) => Input.new(this.inputs[key]).h(32).px(10).rounded(8).border_1().border_color(this.bad[key] ? t.blocked : t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
    const button = (id, label, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(label);
    return v_flex().id("wranglr-settings").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).gap(14).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Wranglr settings"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(field("Sort", pick("sort", Object.entries(SORT_LABEL)), "sort"))
      .child(field("+ on a Repo group", pick("plus", [["open", "Open the main checkout"], ["worktree", "New worktree"]]), "plus", "Right-click + for the other one."))
      .child(field("Name new spaces from their branch", pick("autoname", [[true, "On"], [false, "Off"]]), "autoname"))
      .child(field("Worktree location", text("worktrees"), "worktrees", "{clone} is the Repo's main checkout, {branch} the branch, {repo} the Repo's name. A Repo's own pattern in wranglr.json wins."))
      .child(field("Ticket pattern", text("ticket"), "ticket", "A regular expression matched against the branch. Its first group is the ticket id."))
      .child(field("New spaces run", text("agent"), "agent", "A command and its arguments, split at spaces. Empty is a plain terminal."))
      .child(h_flex().pt(4).gap(8).justify_end()
        .child(button("ws-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("ws-save", "Save", true, (_e, cx) => { this.saveSettings(); cx.notify(); })));
  }

  choose(item) {
    closeOverlay(props()?.overlay);
    if (!item) return;
    if (item.input) openInput(item.input);
    else if (item.action) send(item.action);
  }

  menuIcon(item) {
    const type = item.input?.action?.type ?? item.action?.type;
    if (type === "plus") return item.input ? "git-branch" : "plus";
    if (/^remove|^dismiss/.test(type)) return "x";
    if (/^rename/.test(type)) return "square-pen";
    return "folder-plus";
  }

  renderMenu() {
    const t = theme();
    const list = props()?.items ?? [];
    return v_flex().id("wranglr-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down" && list.length) this.at = (this.at + 1) % list.length;
        else if (e.key === "up" && list.length) this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(list[this.at]);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else {
          const hit = list.find((it) => it.key && it.key === String(e.key ?? "").toLowerCase());
          if (!hit) return;
          this.choose(hit);
        }
        cx.stop_propagation();
        cx.notify();
      })
      .children(list.map((it, i) => h_flex().id(`wmi-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
        .when(i === this.at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.choose(it))
        .child(svg(icon(this.menuIcon(it))).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().truncate().child(it.label))
        .when(Boolean(it.key), (el) => el.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).child(String(it.key).toUpperCase())))));
  }

  render(cx) {
    if (this.dialog === "move") return this.renderMove();
    if (this.dialog === "input") return this.renderInput();
    if (this.dialog === "menu") return this.renderMenu();
    if (this.dialog === "settings") return this.renderSettings();
    if (this.dialog) return div();
    return this.renderOwner(cx);
  }
}
