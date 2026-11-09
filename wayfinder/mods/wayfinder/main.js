// Wayfinder: one Profile's Boards and Pull Requests, outside any space.
// The layout holds it in a stack beside the work area (STACK below): "Wayfinder: Open" selects it,
// and the close button, Esc or "Wayfinder: Close" select the work area again.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { run, theme, appHome, readTextFile, writeTextFile, nextCommand, notify, window as herdrWindow } from "herdr";
import { parseConfig } from "./config.js";
import { createRunner } from "./runner.js";

const STACK = "wayfinder-stack", WORK = "work";
const VIEW_KEY = "wayfinder.view.v1";
const configPath = () => `${appHome()}/data/wayfinder.json`;

const EXAMPLE = `{
  "activeProfile": "work",
  "profiles": {
    "work": {
      "runner": "wsl:Ubuntu",
      "accounts": [{ "id": "gh-work", "provider": "github", "login": "<gh user>" }],
      "repos": [],
      "boards": []
    }
  }
}`;

const stop = (_e, cx) => cx.stop_propagation();
const getView = () => { try { return localStorage.getItem(VIEW_KEY) === "prs" ? "prs" : "board"; } catch { return "board"; } };
const setView = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer nicety only */ } };

function button(id, label, t, onClick) {
  return h_flex().id(id).h(26).px(10).flex_none().items_center().rounded(6)
    .text_size(12).text_color(t.muted).cursor_pointer()
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
      .child(label);
  }));
}

export default class Wayfinder extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.view = getView();
    this.state = { status: "loading" };
    this.checks = null;
    this.load(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand()).replace(/^wayfinder\./, "");
        if (c === "focus") this.handle.focus();
        else if (c === "close") this.close_();
        else if (c === "refresh") this.load(cx);
        else if (c === "profile") await this.nextProfile(cx);
        cx.notify();
      }
    });
  }

  close_() { run("layout.select", { stack: STACK, child: WORK }); }

  load(cx) {
    this.state = { status: "loading" };
    cx.spawn(async (cx) => {
      const path = configPath();
      let text = null;
      try { text = await readTextFile(path); } catch (e) { this.state = { status: "invalid", path, errors: [String(e.message ?? e)] }; cx.notify(); return; }
      if (text == null) { this.state = { status: "missing", path }; cx.notify(); return; }
      const parsed = parseConfig(text, herdrWindow().platform);
      this.state = parsed.errors.length
        ? { status: "invalid", path, errors: parsed.errors }
        : { status: "ok", path, text, ...parsed };
      cx.notify();
      if (this.state.status === "ok") await this.check(this.state.profile, cx);
    });
  }

  // Confirms the Profile's runner can reach the CLIs Wayfinder signs in with.
  async check(profile, cx) {
    const r = createRunner(profile.runner);
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
    const next = names[(names.indexOf(s.profile.name) + 1) % names.length];
    const updated = JSON.stringify({ ...s.config, activeProfile: next }, null, 2) + "\n";
    try { await writeTextFile(s.path, updated, s.text); } catch (e) {
      notify({ title: "Wayfinder", body: `Couldn't switch profile: ${e.message ?? e}`, level: "error" });
    }
    this.load(cx);
  }

  header(t) {
    const s = this.state;
    return h_flex().h(44).px(12).gap(10).flex_none().items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Wayfinder"))
      .child(segmented("wf-view", [["board", "Board"], ["prs", "Pull Requests"]], this.view, t, (key, cx) => {
        this.view = key; setView(key); cx.notify();
      }))
      .child(div().flex_1())
      .when(s.status === "ok", (el) => el.child(div().text_size(12).text_color(t.muted).child(s.profile.name)))
      .child(button("wf-refresh", "Refresh", t, (cx) => this.load(cx)))
      .child(button("wf-close", "Close", t, () => this.close_()));
  }

  message(t, title, lines) {
    return v_flex().gap(8).max_w(640).child(div().text_size(14).font_semibold().text_color(t.foreground).child(title))
      .children(lines.map((l) => div().text_size(12).text_color(t.muted).child(l)));
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

    const what = this.view === "board" ? "Boards" : "Pull Requests";
    const lines = [`Profile ${s.profile.name}, runner ${s.profile.runner}.`];
    if (this.view === "board" && s.profile.boards.length === 0) lines.push("No Boards configured for this profile.");
    else lines.push(`${what} arrive in a later step.`);
    const c = this.checks;
    const check = (name, r) => r ? `${name}: ${r.ok ? r.text : `not reachable (${r.text})`}` : `${name}: checking…`;
    lines.push(check("gh", c?.gh), check("az", c?.az));
    return this.message(t, what, lines);
  }

  render(cx) {
    const t = theme();
    return v_flex().id("wf-root").size_full().bg(t.background)
      .track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e) => { if (e.key === "escape") this.close_(); })
      .child(this.header(t))
      .child(v_flex().id("wf-body").flex_1().p(16).overflow_y_scrollbar().child(this.body(t)));
  }
}
