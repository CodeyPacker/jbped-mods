// pa-probe: a target for private-app's input commands (click, drag, wheel, key, type).
// It fills the window (probe.json layout) in four equal bands, top to bottom:
//   1. a button: left and right presses, clicks and their click_count
//   2. a text box, centred in the band; its value is recorded
//   3. a scroll area: wheel events
//   4. a pad: presses, moves with the button held, releases (a drag); a press gives it the keyboard
//      and records its bounds (window px), from which the other bands' places follow
// Every event is written to <app home>/data/pa-probe.json, which selftest.sh reads.
import { View, div } from "gpui-kit";
import { v_flex, InputState, Input } from "gpui-base";
import { appHome, checking, theme } from "herdr";
import * as fs from "fs/promises";

const MAX_LOG = 200;

export default class Probe extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "type here" });
    this.input.on("change", (_e, cx) => { this.state.input = this.input.value(); this.save(cx); });
    this.state = { pad: null, clicks: 0, left: 0, right: 0, maxCount: 0, input: "", keys: [], wheel: [], drag: [], seq: 0 };
    this.writing = null;
    this.again = false;
  }

  log(kind, data, cx) {
    const list = this.state[kind];
    list.push(data);
    if (list.length > MAX_LOG) list.shift();
    this.save(cx);
  }

  // One write at a time; a change meanwhile writes once more after.
  save(cx) {
    this.state.seq++;
    if (checking()) return;
    if (this.writing) { this.again = true; return; }
    this.writing = true;
    cx.spawn(async () => {
      const dir = `${appHome()}/data`;
      do {
        this.again = false;
        await fs.mkdir(dir, { recursive: true }).catch(() => {});
        await fs.writeFile(`${dir}/pa-probe.json`, JSON.stringify(this.state)).catch(() => {});
      } while (this.again);
      this.writing = null;
    });
    cx.notify();
  }

  render(cx) {
    const t = theme(), s = this.state;
    const band = (id) => div().id(id).flex_1().w_full().p(8).border_b(1).border_color(t.border);
    const pt = (p) => p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
    return v_flex().id("probe-root").size_full().bg(t.background).text_color(t.foreground).text_size(14)
      .child(band("probe-button").bg(t.raised)
        .on_mouse_down("left", (_e, cx) => { s.left++; this.save(cx); })
        .on_mouse_down("right", (_e, cx) => { s.right++; this.save(cx); })
        .on_click((e, cx) => { s.clicks++; s.maxCount = Math.max(s.maxCount, e.click_count); this.save(cx); })
        .child(`button: clicks ${s.clicks}, left ${s.left}, right ${s.right}, max click_count ${s.maxCount}`))
      .child(band("probe-input").flex().items_center()
        .child(div().w_full().child(Input.new(this.input))))
      .child(band("probe-wheel").overflow_y_scroll()
        .on_scroll_wheel((e, cx) => this.log("wheel", { dx: e.delta.x, dy: e.delta.y }, cx))
        .child(`wheel events ${s.wheel.length}`))
      .child(band("probe-pad").track_focus(this.handle)
        .on_key_down((e, cx) => this.log("keys", { keystroke: e.keystroke, key: e.key, key_char: e.key_char ?? null }, cx))
        .on_mouse_down("left", (e, cx) => { this.handle.focus(); this.held = true; s.pad = e.bounds ? { ...pt(e.bounds), width: Math.round(e.bounds.width), height: Math.round(e.bounds.height) } : null;
          this.log("drag", { ev: "down", at: pt(e.position), shift: e.modifiers.shift }, cx); })
        .on_mouse_move((e, cx) => { if (this.held) this.log("drag", { ev: "move", at: pt(e.position) }, cx); })
        .on_mouse_up("left", (e, cx) => { this.held = false; this.log("drag", { ev: "up", at: pt(e.position) }, cx); })
        .child(`pad: keys ${s.keys.length} (last ${s.keys.at(-1)?.keystroke ?? "-"}), drag events ${s.drag.length}`));
  }
}
