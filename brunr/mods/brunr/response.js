// The Response pane, laid out like Bruno's response area: a top line with the Request, status,
// time and size, then Response, Headers, Timeline and Tests. A folder or Collection Run lists its
// Requests on the left. Its data lives only in memory (store.js) and goes when the pane closes.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { focused, panes, props, settings, theme } from "herdr";
import * as store from "./store.js";
import { formatSize, formatTime } from "./report.js";
import { methodBadge } from "./panel.js";

const MAX_TEXT = 400000;
const PARTS = ["response", "headers", "timeline", "tests"];
const mono = () => String(settings()?.font_family ?? settings()?.font ?? "JetBrains Mono");

export function init(self, cx) {
  const p = props() ?? {};
  self.tab = (p.pane && panes().find((x) => x.pane === p.pane)?.tab) || p.tab || focused()?.tab || null;
  self.v = null;
  self.seen = null;
  self.sel = 0;
  self.part = "response";
  self.editor = null;
  sync(self);
  cx.spawn(async (cx) => { for (;;) { await store.nextChange(); sync(self); cx.notify(); } });
}

export function close(self) {
  self.editor?.release();
  self.editor = null;
  store.clearView(self.tab);
}

/** Takes the tab's latest Run from the store, selecting the first failed Request. */
function sync(self) {
  const v = store.getView(self.tab);
  if (!v) { self.v = null; self.seen = null; setEditor(self, null); return; }
  if (v.n === self.seen) return;
  self.seen = v.n;
  self.v = v;
  if (v.kind === "file") { setEditor(self, { language: v.file.language, value: v.file.text }); return; }
  const list = v.result?.responses ?? [];
  const failed = list.findIndex((r) => !r.ok);
  self.sel = failed >= 0 ? failed : 0;
  self.part = "response";
  showBody(self);
}

function showBody(self) {
  const r = self.v?.result?.responses?.[self.sel];
  setEditor(self, r ? { language: r.language === "text" ? "text" : r.language, value: r.body } : null);
}

function setEditor(self, spec) {
  self.editor?.release();
  self.editor = null;
  if (!spec) return;
  const t = theme();
  const value = spec.value.length > MAX_TEXT ? `${spec.value.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters)` : spec.value;
  self.editor = EditorState.new({ language: spec.language, value, readonly: true, font_family: mono(), font_size: 12, soft_wrap: true,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6 } });
}

export function statusColor(t, status) {
  if (status == null) return t.blocked;
  if (status >= 200 && status < 300) return t.done;
  if (status >= 300 && status < 400) return t.ansi3;
  return t.blocked;
}

const lines = (text) => String(text ?? "").replace(/\r\n/g, "\n").split("\n");

export function render(self) {
  const t = theme();
  const root = v_flex().id("brunr-response").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(12.5)
    .on_size_change((size, cx) => { self.size = size; cx.notify(); });
  const v = self.v;
  if (!v) return root.child(center(t, "No Response here yet. Run a Request from the Brunr panel."));
  if (v.kind === "file") {
    return root.child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).child("Read only"))
      .child(div().flex_1().min_w(0).truncate().text_ellipsis_start().font_family(mono()).text_size(11.5).child(v.file.path)))
      .child(self.editor ? Editor.new(self.editor).flex_1().min_h(0) : center(t, "Empty file"));
  }
  const info = v.info;
  if (v.state === "running") {
    const waiting = v_flex().flex_1().items_center().justify_center().gap(10).text_color(t.muted)
      .child(spinner(t, 22))
      .child(div().child(`Running ${info.label}${info.environment ? ` against ${info.environment}` : ""}…`));
    const p = v.progress;
    if (info.kind === "request" || !p) return root.child(topLine(t, info.label, info.method, info.url, null)).child(waiting);
    // Requests are listed as they finish. Rows do nothing until the Run ends and the report is read.
    const rows = p.finished.map((f, i) => listRow(t, i, { ok: f.ok, method: f.method, name: f.name, status: f.status }, false, null));
    if (p.running) rows.push(listRow(t, rows.length, { running: true, method: null, name: p.running.name, status: undefined }, false, null));
    return root.child(progressLine(t, p)).child(withList(self, t, rows, waiting));
  }
  const result = v.result;
  const list = result.responses ?? [];
  if (result.message) {
    return root.child(topLine(t, info.label, info.method, info.url, null))
      .when(result.summary?.requests > 0, (el) => el.child(summaryLine(t, result.summary)))
      .child(v_flex().id("brunr-message").flex_1().min_h(0).overflow_y_scrollbar().m(12).p(12).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .font_family(mono()).text_size(11.5).text_color(t.foreground).children(lines(result.message).map((l) => div().min_h(16).child(l))));
  }
  const many = info.kind !== "request" || list.length > 1;
  const detail = list[self.sel] ? responseView(self, t, list[self.sel]) : center(t, "No Request was sent.");
  if (!many) return root.child(detail);
  const rows = list.map((r, i) => listRow(t, i, r, i === self.sel, (cx) => { self.sel = i; showBody(self); cx.notify(); }));
  return root.child(summaryLine(t, result.summary)).child(withList(self, t, rows, detail));
}

const spinner = (t, size) => svg("mods/brunr/icons/spinner.svg").size(size).flex_none().text_color(t.working).spin(900);

/** The list of Requests beside the views. Wide: on the left. Narrow: on top, so the views keep the pane's width. */
function withList(self, t, rows, detail) {
  const wide = (self.size?.width ?? 0) >= 720;
  const listBox = v_flex().id("brunr-runlist").flex_none().min_h(0).overflow_y_scrollbar().p(4).border_color(t.border)
    .when(wide, (el) => el.w(240).border_r(1)).when(!wide, (el) => el.w_full().max_h(Math.min(180, 12 + rows.length * 28)).border_b(1));
  return (wide ? h_flex() : v_flex()).flex_1().min_h(0).items_stretch()
    .child(listBox.children(rows))
    .child(v_flex().flex_1().min_w(0).min_h(0).child(detail));
}

/** One Request in the list: its mark (a spinner while it runs), method, name and status. */
function listRow(t, i, r, selected, click) {
  return h_flex().id(`resp-${i}`).h(28).flex_none().px(8).gap(6).items_center().rounded(5)
    .when(Boolean(click), (el) => el.cursor_pointer().hover((s) => s.bg(selected ? t.selected : t.hover)).on_click((_e, cx) => click(cx)))
    .when(selected, (el) => el.bg(t.selected))
    .child(r.running ? div().w(12).flex_none().flex().items_center().child(spinner(t, 11))
      : div().w(12).flex_none().text_color(r.ok ? t.done : t.blocked).child(r.ok ? "✓" : "✗"))
    .child(methodBadge(t, r.method))
    .child(div().flex_1().min_w(0).truncate().text_color(r.running ? t.muted : t.foreground).child(r.name))
    .when(r.status !== undefined, (el) => el.child(div().flex_none().text_size(10.5).text_color(statusColor(t, r.status)).child(r.status == null ? "ERR" : String(r.status))));
}

/** The summary line while a folder or Collection Run is in progress: a spinner and the count. */
function progressLine(t, p) {
  return h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(11.5)
    .child(spinner(t, 12))
    .child(div().text_color(t.muted).child(`${p.done} of ${p.total}`))
    .child(div().flex_1());
}

function center(t, text) {
  return v_flex().flex_1().items_center().justify_center().p(20).text_color(t.dim).child(div().child(text));
}

function summaryLine(t, s) {
  const part = (n, label, color) => div().text_color(n ? color : t.dim).child(`${n} ${label}`);
  return h_flex().h(30).flex_none().px(12).gap(12).items_center().border_b(1).border_color(t.border).text_size(11.5)
    .child(div().text_color(t.muted).child(`${s.requests} ${s.requests === 1 ? "Request" : "Requests"}`))
    .child(part(s.passed, "passed", t.done)).child(part(s.failed, "failed", t.blocked)).child(part(s.skipped, "skipped", t.ansi3))
    .child(div().flex_1()).child(div().text_color(t.dim).child(formatTime(s.duration)));
}

function topLine(t, name, method, url, r) {
  const line = h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
    .child(div().min_w(0).max_w(220).truncate().font_semibold().child(name ?? ""))
    .when(Boolean(method), (el) => el.child(methodBadge(t, method, 44)))
    .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(11.5).text_color(t.muted).child(url ?? ""));
  if (!r) return line;
  // The status, time and size never give way: the name and URL shorten instead.
  return line.child(h_flex().flex_none().gap(8).items_center()
    .child(div().px(6).h(20).flex().items_center().rounded(4).bg(t.raised).font_semibold().text_size(11.5).text_color(statusColor(t, r.status))
      .child(r.status == null ? "Error" : `${r.status} ${r.statusText ?? ""}`.trim()))
    .when(r.time != null, (el) => el.child(div().text_size(11.5).text_color(t.muted).child(formatTime(r.time))))
    .when(r.size != null, (el) => el.child(div().text_size(11.5).text_color(t.muted).child(formatSize(r.size)))));
}

function responseView(self, t, r) {
  const passed = r.tests.filter((x) => x.ok).length;
  const label = { response: "Response", headers: `Headers ${r.headers.length}`, timeline: "Timeline", tests: `Tests ${passed}/${r.tests.length}` };
  const tabs = h_flex().h(32).flex_none().px(8).gap(2).items_end().border_b(1).border_color(t.border).text_size(12)
    .children(PARTS.map((p) => h_flex().id(`part-${p}`).h_full().px(10).items_center().cursor_pointer()
      .when(p === self.part, (el) => el.border_b(2).border_color(t.accent).text_color(t.foreground))
      .when(p !== self.part, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .when(p === "tests" && r.tests.some((x) => !x.ok), (el) => el.text_color(t.blocked))
      .on_click((_e, cx) => { self.part = p; cx.notify(); })
      .child(label[p])));
  const body = self.part === "headers" ? headersView(t, r.headers)
    : self.part === "timeline" ? timelineView(t, r)
    : self.part === "tests" ? testsView(t, r)
    : self.editor && r.body ? Editor.new(self.editor).flex_1().min_h(0)
    : center(t, r.error ?? "No body");
  return v_flex().flex_1().min_h(0).child(topLine(t, r.name, r.method, r.url, r)).child(tabs).child(body);
}

function headersView(t, headers) {
  if (!headers.length) return center(t, "No headers");
  return v_flex().id("brunr-headers").flex_1().min_h(0).overflow_y_scrollbar().p(8).font_family(mono()).text_size(11.5)
    .children(headers.map(([k, v], i) => h_flex().id(`h-${i}`).flex_none().px(6).py(4).gap(12).items_start().border_b(1).border_color(t.border)
      .child(div().w(200).flex_none().text_color(t.muted).child(k)).child(div().flex_1().min_w(0).child(String(v)))));
}

function timelineView(t, r) {
  const box = v_flex().id("brunr-timeline").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(4).font_family(mono()).text_size(11.5);
  box.child(h_flex().gap(8).child(methodBadge(t, r.method, 44)).child(div().flex_1().min_w(0).child(r.url)));
  for (const [k, v] of r.requestHeaders) box.child(div().pl(12).text_color(t.muted).child(`${k}: ${v}`));
  if (r.requestBody) {
    box.child(div().pt(6).text_color(t.dim).child("Body"));
    for (const l of lines(r.requestBody)) box.child(div().pl(12).min_h(16).child(l));
  }
  box.child(div().h(10));
  if (r.status == null) box.child(div().text_color(t.blocked).child(r.error ?? "No response"));
  else box.child(h_flex().gap(10).child(div().text_color(statusColor(t, r.status)).child(`${r.status} ${r.statusText ?? ""}`.trim())).when(r.time != null, (el) => el.child(div().text_color(t.muted).child(formatTime(r.time)))));
  return box;
}

function testsView(t, r) {
  const box = v_flex().id("brunr-tests").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(2);
  if (r.error) box.child(div().px(8).py(6).text_color(t.blocked).child(r.error));
  if (!r.tests.length) return box.child(div().px(8).py(6).text_color(t.dim).child("No assertions or tests."));
  return box.children(r.tests.map((x, i) => v_flex().id(`test-${i}`).flex_none().px(8).py(6).gap(3).rounded(5).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center()
      .child(div().w(12).flex_none().text_color(x.ok ? t.done : t.blocked).child(x.ok ? "✓" : "✗"))
      .child(div().flex_1().min_w(0).font_family(mono()).text_size(11.5).child(x.name || "(unnamed)"))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(x.kind === "assert" ? "assertion" : "test")))
    .when(Boolean(x.error), (el) => el.child(div().pl(20).text_size(11.5).text_color(t.blocked).child(String(x.error))))));
}
