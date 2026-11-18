// The "Agent files" list in the Edit tab's left column and Review's backfill note: reads the shown
// space's Claude session logs (sessionlog.js) while a copy shows one of them, and draws. One per
// copy (main.js: this.agentFiles). Its tick runs on main.js's 5 s timer; each agent's log is read
// at most every sessionlog.EVERY_MS however many copies ask, and nothing runs once the copy closes.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, terminals, layout } from "herdr";
import { agentTouches, isClaude, startedAt, forgetLogs } from "./sessionlog.js";
import { mergeResults, listRows, relTime, unrecorded, backfillText, headLine, wants } from "./agentfiles.js";
import { pathFor } from "./workspace.js";
import { viewShown } from "./panelview.js";
import { STATUS, parseStatus } from "./changes.js";
import { idOf } from "./remote.js";

/** An agent's folder in the mod's form (as captureloop.agentFolders reads it). */
const folderOf = (a, sp) => pathFor(sp)(panes().find((p) => p.pane === a.pane)?.cwd ?? terminals().find((t) => t.address === a.address)?.cwd);

export class AgentFiles {
  constructor(host) { this.host = host; this.state = null; this.busy = false; }

  enabled() { return this.host.settings?.sessionLog !== false; }

  /** "edit", "review" or null: what this copy shows of the source now. */
  where() {
    const h = this.host;
    let visible = true;
    if (h.view) { try { visible = viewShown(layout(), h.view) !== false; } catch {} }
    return wants({ enabled: this.enabled(), space: h.spaceId, mode: h.mode, left: h.search?.left, column: h.treeOn || h.treeOnly?.(), visible });
  }

  /** The 5 s pass: the shown space's Claude logs, then (Review) which edited files git still shows changed. */
  tick(cx) {
    const where = this.where();
    if (!where) { if (!this.enabled() && this.state) { this.state = null; forgetLogs(); } return; }
    if (this.busy) return;
    const h = this.host, sp = h.space(), space = h.spaceId;
    if (!sp) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const on = sp.machine ?? null, mine = agents().filter((a) => a.space === space && isClaude(a));
        // Other Claudes in the same folder, any space, on the same machine: then a log can't be told apart by folder.
        const all = agents().filter(isClaude).map((a) => {
          const s = { machine: a.address.includes("/") ? a.address.split("/")[0] : null };
          return { a, cwd: folderOf(a, a.space === space ? sp : s) };
        });
        const results = [];
        for (const a of mine) {
          const cwd = folderOf(a, sp);
          const others = all.filter((x) => x.a !== a && x.cwd && x.cwd === cwd).length;
          results.push(await agentTouches(a, { cwd, on, others, since: startedAt(terminals().find((t) => t.address === a.address)), enabled: this.enabled() }));
        }
        if (h.spaceId !== space) return;
        const files = mergeResults(results), rows = listRows(files, h.stores, on, (s, r) => h.own(s, r));
        let backfill = 0;
        if (where === "review") {
          const reviewed = new Set(h.files.map((f) => f.key));
          const cand = rows.filter((r) => r.store && !r.store.plain && r.file.edited && !reviewed.has(r.key));
          const dirty = new Map();
          for (const st of new Set(cand.map((r) => r.store))) {
            const s = await h.git(st, STATUS).catch(() => null);
            if (s?.code === 0) dirty.set(idOf(st), new Set(parseStatus(s.stdout).map((x) => x.rel)));
          }
          backfill = unrecorded(cand, reviewed, (st) => dirty.get(idOf(st))).length;
        }
        if (h.spaceId !== space) return;
        const sig = JSON.stringify([rows.map((r) => [r.key, r.mark, r.file.lastAt]), backfill, results.map((r) => [r?.ambiguous, r?.partial, r?.error, !!r?.log])]);
        const changed = sig !== this.state?.sig || this.state?.space !== space;
        this.state = { space, sig, rows, backfill, head: headLine({ agents: mine.length, results, enabled: this.enabled() }) };
        if (changed) h.paint(cx);
      } catch (e) {
        if (h.spaceId === space) { this.state = { space, sig: null, rows: this.state?.rows ?? [], backfill: 0, head: String(e?.message ?? e).slice(0, 200) }; h.paint(cx); }
      } finally { this.busy = false; }
    });
  }

  /** The list was just shown: read now rather than at the next tick. */
  show(cx) { this.tick(cx); }

  /** The list body for the Edit tab's left column. */
  render(t) {
    const h = this.host, s = this.state?.space === h.spaceId ? this.state : null, now = Date.now();
    const head = !this.enabled() ? headLine({ enabled: false }) : s ? s.head : "Reading the agent's session log…";
    const marks = { read: t.dim, edited: t.ansi3, new: t.ansi2 };
    const counts = (r) => {
      const f = r.store && h.files.find((x) => x.key === r.key);
      const add = f?.hunks?.reduce((n, x) => n + x.nc, 0) ?? 0, del = f?.hunks?.reduce((n, x) => n + x.oc, 0) ?? 0;
      const letter = r.store ? h.ftrees?.get(idOf(r.store))?.marks?.get(r.rel) ?? null : null;
      return { letter, add, del };
    };
    const row = (r) => {
      const c = counts(r), cut = r.rel.lastIndexOf("/") + 1, multi = h.stores.length > 1;
      return h_flex().id(`agent-${r.key}`).h(24).flex_none().px(8).gap(6).items_center().text_size(12)
        .when(!!r.store, (e) => e.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => cx.spawn(async (cx) => h.openFile(r.store, r.rel, cx))))
        .child(div().w(40).flex_none().text_size(10).text_color(marks[r.mark]).child(r.mark))
        .child(h_flex().flex_1().min_w(0).gap(6).items_center()
          .child(div().flex_none().text_color(r.store ? t.foreground : t.dim).child(r.rel.slice(cut)))
          .child(div().min_w(0).truncate().text_size(10.5).text_color(t.dim).child((multi && r.store ? r.store.root.split("/").pop() + "/" : "") + r.rel.slice(0, Math.max(0, cut - 1)))))
        .when(!!c.letter, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi3).child(c.letter)))
        .when(c.add + c.del > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.ansi2).child(`+${c.add}`)).child(div().flex_none().text_size(10).text_color(t.ansi1).child(`−${c.del}`)))
        .child(div().w(28).flex_none().text_size(10).text_color(t.dim).child(relTime(r.file.lastAt, now)));
    };
    return v_flex().id("agent-files").flex_1().min_h(0)
      .child(div().flex_none().px(8).py(4).text_size(11).text_color(t.muted).child(head || `${s?.rows.length ?? 0} files`))
      .child(v_flex().id("agent-files-list").flex_1().min_h(0).overflow_y_scrollbar().children((s?.rows ?? []).map(row)));
  }

  /** Review's note, as a list of 0 or 1 rows. */
  reviewLine(t) {
    const s = this.state, text = s && s.space === this.host.spaceId && this.enabled() ? backfillText(s.backfill) : null;
    return text ? [h_flex().id("agent-backfill").flex_none().px(12).py(4).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
      .child(div().flex_1().min_w(0).truncate().child(text))] : [];
  }
}
