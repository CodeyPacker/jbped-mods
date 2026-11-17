// Notifyr: keeps every notification Herdr shows, and lists them later.
//
// One mod, three views, chosen by props:
//   toast  the layout root's "toast": "notifyr". Draws the notification as Herdr's own
//          toast mod does, and records it. This is the only place that sees every one.
//   bell   props { bell: true }. A small block for the layout: a bell and the unread count.
//   list   opened by the bell or by mod.open: the record, newest first.
//
// The record is the shared value "notifyr.log": [{ id, at, overlay, title, body, level, icon, action }].

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, closeOverlay, layout, props, run, setShared, shared, theme } from "herdr";

const LOG = "notifyr.log";
const SEEN = "notifyr.seen";
const MAX = 200;
const BODY_MAX = 600;
const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function entries() {
  const v = shared(LOG);
  return Array.isArray(v) ? v : [];
}

function seenAt() {
  return Number(shared(SEEN)) || 0;
}

/** Adds one toast to the record. A toast whose copy starts again (a hot reload) is not added twice. */
function record(p) {
  const now = Date.now();
  const log = entries();
  if (log.some((e) => e.overlay === p.overlay && e.title === (p.title ?? "") && now - e.at < 60000)) return;
  const entry = {
    id: `${now}-${p.overlay ?? ""}`,
    at: now,
    overlay: p.overlay ?? null,
    title: String(p.title ?? ""),
    body: p.body ? String(p.body).slice(0, BODY_MAX) : "",
    level: p.level ?? "info",
    icon: p.icon ?? null,
    action: p.action?.name ? { name: p.action.name, args: p.action.args ?? {} } : null,
  };
  setShared(LOG, [entry, ...log].slice(0, MAX));
}

const two = (n) => String(n).padStart(2, "0");

function clock(at) {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "now", "5m", "3h", then "Nov 16". */
function ago(at, now) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = new Date(at);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function stamp(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${clock(at)}`;
}

function mark(t, e, size) {
  return e.icon
    ? image(e.icon).w(size + 8).h(size + 8).flex_none()
    : div().size(size).rounded(size / 2).flex_none().bg(t[DOT[e.level] ?? "accent"]);
}

export default class Notifyr extends View {
  init(_props, _cx) {
    const p = props() ?? {};
    const toast = p.title != null || p.body != null || p.level != null;
    this.view = p.bell ? "bell" : toast && !p.list ? "toast" : "list";
    if (checking()) return;
    if (this.view === "toast") record(p);
    if (this.view === "list") {
      // What was unread when the list opened stays marked while it is open.
      this.unreadSince = seenAt();
      setShared(SEEN, Date.now());
    }
  }

  async close(_cx) {
    // Toasts that arrived while the list was open were read in it.
    if (this.view === "list" && !checking()) setShared(SEEN, Date.now());
  }

  render(cx) {
    const t = theme();
    if (this.view === "bell") return this.renderBell(t);
    if (this.view === "toast") return this.renderToast(t);
    return this.renderList(t);
  }

  /** Herdr's own toast, unchanged: click runs the action and dismisses it. */
  renderToast(t) {
    const p = props() ?? {};
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    return h_flex()
      .id("toast")
      .size_full()
      .px(18)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]))
      .child(
        v_flex()
          .flex_1()
          .overflow_hidden()
          .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : p.title ?? ""))
          .when(!login && Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? "")))
          .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
            .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
              .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
              .child(this.copied ? "Copied" : "Copy")))),
      );
  }

  /** The layout's mark. props { bare: true } drops the status-bar background and top border. */
  renderBell(t) {
    const p = props() ?? {};
    const seen = seenAt();
    const all = entries();
    const unread = all.filter((e) => e.at > seen).length;
    const color = unread ? t.accent : t.muted;
    const tip = unread ? `${unread} new ${unread === 1 ? "notification" : "notifications"}` : all.length ? "No new notifications" : "No notifications yet";
    return h_flex()
      .id("notifyr-bell")
      .size_full()
      .gap(5)
      .items_center()
      .justify_center()
      .when(!p.bare, (el) => el.bg(t.chrome).border_t(1).border_color(t.border))
      .text_size(11.8)
      .text_color(color)
      .cursor_pointer()
      .hover((x) => x.text_color(t.foreground))
      .tooltip(`${tip}. Click to open the list (ctrl-shift-i)`)
      .on_click(() => run("mod.open", { name: "notifyr" }))
      .child(svg("mods/notifyr/bell.svg").size(14).flex_none().text_color(color))
      .when(unread > 0, (el) => el.child(div().child(unread > 99 ? "99+" : String(unread))));
  }

  renderList(t) {
    const p = props() ?? {};
    const log = entries();
    const now = Date.now();
    const since = this.unreadSince ?? seenAt();
    const wired = layout()?.toast === "notifyr";
    const close = () => { if (p.overlay != null) closeOverlay(p.overlay); };

    const row = (e, i) => {
      const act = Boolean(e.action?.name);
      const unread = e.at > since;
      return h_flex()
        .id(`notifyr-row-${e.id ?? i}`)
        .flex_none()
        .px(14)
        .py(9)
        .gap(10)
        .items_start()
        .border_b(1)
        .border_color(t.border)
        .when(act, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => { close(); run(e.action.name, e.action.args ?? {}); }))
        .child(h_flex().flex_none().h(18).w(16).items_center().justify_center().child(mark(t, e, 8)))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .gap(2)
            .child(div().font_semibold().text_size(13).text_color(t.foreground).child(e.title || "(no title)"))
            .when(Boolean(e.body), (el) => el.child(div().text_size(12).text_color(t.muted).child(e.body))),
        )
        .child(
          h_flex().flex_none().h(18).gap(6).items_center()
            .when(unread, (el) => el.child(div().size(6).rounded(3).flex_none().bg(t.accent)))
            .child(div().text_size(11).text_color(unread ? t.accent : t.dim).tooltip(stamp(e.at)).child(ago(e.at, now))),
        );
    };

    return v_flex()
      .id("notifyr-list")
      .size_full()
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .flex_none()
          .h(40)
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().text_size(13).child("Notifications"))
          .child(div().flex_1().text_size(11.5).text_color(t.dim).child(log.length ? String(log.length) : ""))
          .when(log.length > 0, (el) => el.child(
            div().id("notifyr-clear").flex_none().px(8).py(3).rounded(4).bg(t.raised)
              .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => { setShared(LOG, []); cx.notify(); })
              .child("Clear"),
          )),
      )
      .when(!wired, (el) => el.child(
        div().flex_none().px(14).py(8).border_b(1).border_color(t.border).text_size(11.5).text_color(t.working)
          .child('This layout does not record notifications. Set "toast": "notifyr" on its root.'),
      ))
      .child(
        log.length
          ? v_flex().id("notifyr-rows").flex_1().min_h(0).overflow_y_scrollbar().children(log.map(row))
          : v_flex().flex_1().items_center().justify_center().text_size(12).text_color(t.dim).child("No notifications yet."),
      );
  }
}
