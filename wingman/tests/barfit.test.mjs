// D2/D3: a bar of buttons degrades in order as its width shrinks: key hints, then long labels,
// then whole buttons by their drop order. A label is never cut: it's a shorter one or none.
import assert from "node:assert";
import { fitFindRow, findRowItems, replaceRowItems, fitBar, fitHeader, hunkButtons, textW, withKey, LAST_DROP, settingsTabs, settingsHeight, SETTINGS_H } from "../mods/wingman/barfit.js";

const items = [
  { id: "pos", labels: ["1/3 · ctrl-shift-↑/ctrl-shift-↓", "1/3"], drop: 2, size: 10, pad: 12 },
  { id: "reject-file", labels: [withKey("Reject file", "ctrl-shift-⌫"), "Reject file", "Reject"], drop: 5 },
  { id: "accept-file", labels: [withKey("Accept file", "ctrl-shift-⏎"), "Accept file", "Accept"], drop: 6 },
  { id: "save", labels: [withKey("Save", "ctrl-s"), "Save"], drop: Infinity },
  { id: "vscode", labels: [withKey("VS Code", "ctrl-e"), "VS Code"], drop: 1 },
];
const need = (m) => 156 + [...m].reduce((n, [id, l]) => n + textW(l, items.find((x) => x.id === id).size ?? 11) + (items.find((x) => x.id === id).pad ?? 20) + 4, 0);

// Unknown width (not measured yet): everything in full.
assert.equal(fitBar(undefined, items).get("vscode"), "VS Code  ctrl-e");

// Wide: everything with its keys.
let m = fitBar(2000, items, 156);
assert.equal(m.get("reject-file"), "Reject file  ctrl-shift-⌫");
assert.equal(m.get("pos"), "1/3 · ctrl-shift-↑/ctrl-shift-↓");

// Shrinking: each level is used only when the one before doesn't fit, and what's shown fits.
let last = Infinity, seen = [];
for (let w = 1200; w >= 200; w -= 10) {
  m = fitBar(w, items, 156);
  const shown = [...m];
  if (shown.length) assert.ok(need(m) <= w || shown.every(([id]) => items.find((x) => x.id === id).drop === Infinity), `fits at ${w}`);
  const level = m.get("reject-file") === "Reject file  ctrl-shift-⌫" ? 0 : m.get("reject-file") === "Reject file" ? 1 : m.get("reject-file") === "Reject" ? 2 : 3;
  assert.ok(level >= (seen.at(-1) ?? 0), "never goes back to a longer label as the width shrinks");
  seen.push(level);
  // Keys go before any label shortens: no key shown while a label is short.
  if (m.get("reject-file") === "Reject") for (const [, l] of m) assert.ok(!/ctrl/.test(l), `a key shown beside a short label at ${w}`);
  // Items go by drop order: VS Code (1) before the position (2) before Reject (5); Save never.
  if (!m.has("pos")) assert.ok(!m.has("vscode"));
  if (!m.has("reject-file")) assert.ok(!m.has("pos") && !m.has("vscode"));
  assert.ok(m.has("save"));
  last = w;
}
assert.deepEqual([...new Set(seen)], [0, 1, 2, 3], "every level is reached");

// Every shown label is one of the item's own labels (never a cut one).
for (let w = 200; w <= 1200; w += 7) for (const [id, l] of fitBar(w, items, 156)) assert.ok(items.find((x) => x.id === id).labels.includes(l));

// A group goes whole: Reject and Accept never show one without the other.
const pair = [{ id: "r", labels: ["Reject all files", "Reject all"], drop: 2, group: "all" }, { id: "a", labels: ["Accept all files", "Accept all"], drop: 3, group: "all" }, { id: "s", labels: ["⚙"], drop: Infinity }];
for (let w = 40; w <= 400; w += 5) { const g = fitBar(w, pair, 0); assert.equal(g.has("r"), g.has("a"), `pair split at ${w}`); }

// The change header row: keys go, then "change n of m", then the last buttons.
assert.deepEqual(hunkButtons(900, 58, 6), { w: 110, keys: true, note: true, shown: 4 });
assert.deepEqual(hunkButtons(500, 58, 6), { w: 72, keys: false, note: true, shown: 4 });
let h = hunkButtons(380, 58, 6);
assert.equal(h.note, false); assert.equal(h.shown, 4); assert.ok(58 + 4 * (h.w + 6) <= 380);
h = hunkButtons(240, 58, 6);
assert.ok(h.shown < 4 && 58 + h.shown * (h.w + 6) <= 240, "the buttons shown fit");
assert.equal(hunkButtons(undefined, 58, 6).w, 110);

// X6: the pane header. Comments and Settings shorten to icons and the title goes, so nothing
// overflows from 460 px down to 180 px, in a panel copy and in a pane copy (with its Review/Edit switch).
{
  const header = (n) => [
    { id: "reject-all", labels: ["Reject all files", "Reject all"], drop: 2, group: "all", size: 11, pad: 20 },
    { id: "accept-all", labels: ["Accept all files", "Accept all"], drop: 2, group: "all", size: 11, pad: 20 },
    { id: "checkpoints", labels: ["Checkpoints 3"], drop: 3, size: 11, pad: 20 },
    { id: "comments", labels: [withKey(`Comments ${n}`, "alt-shift-m"), `Comments ${n}`, `💬 ${n}`], drop: LAST_DROP, size: 11, pad: 20 },
    { id: "settings", labels: ["⚙ Settings", "⚙"], drop: Infinity, size: 11, pad: 20 },
  ];
  const used = (fixed, labels, items) => fixed + items.filter((it) => labels.has(it.id)).reduce((s, it) => s + textW(labels.get(it.id), 11) + 20 + 10, 0);
  for (const panel of [true, false]) {
    for (const w of [460, 300, 230, 200, 180]) {
      const items = header(12), { labels, narrow, fixed } = fitHeader(w, items, { panel, subtitle: 80 });
      assert.ok(used(fixed, labels, items) <= w, `fits at ${w} (panel ${panel}): ${[...labels.values()].join(" | ")}`);
      assert.ok(labels.has("settings"), `settings stays at ${w}`);
      assert.ok(labels.has("comments"), `comments stays at ${w} (panel ${panel})`);
      if (w >= 460) assert.equal(narrow, false, `wide at ${w}`); if (w <= 230) assert.equal(narrow, true, `narrow at ${w}`);
    }
  }
  // Wide: everything in full with the title; narrow: icons, no title.
  assert.equal(fitHeader(1200, header(2), { panel: true }).labels.get("comments"), withKey("Comments 2", "alt-shift-m"));
  const tight = fitHeader(180, header(2), { panel: true });
  assert.equal(tight.narrow, true);
  assert.equal(tight.labels.get("settings"), "⚙");
  assert.ok(!tight.labels.has("reject-all") && !tight.labels.has("checkpoints"), "the droppable buttons go first");
  // Narrower than the icons need: Comments goes, Settings stays.
  assert.ok(!fitHeader(120, header(2), { panel: false }).labels.has("comments"));
  assert.ok(fitHeader(120, header(2), { panel: false }).labels.has("settings"));
  // Not measured yet: everything in full.
  assert.equal(fitHeader(0, header(2)).narrow, false);
}
// X7: the Settings dialog fits an 820 px window at zoom 1.2 (its height is element px), less when
// the pane shows the window is shorter; its sections, Machine only for a space on another machine.
assert.ok(SETTINGS_H * 1.2 <= 820 - 40);
assert.equal(settingsHeight(null), SETTINGS_H);
assert.equal(settingsHeight(900), SETTINGS_H);
assert.equal(settingsHeight(400), 440);
assert.equal(settingsHeight(100), 360);
assert.deepEqual(settingsTabs(false).map((x) => x.id), ["general", "editing", "inline", "problems"]);
assert.deepEqual(settingsTabs(true).map((x) => x.id), ["general", "editing", "inline", "problems", "machine"]);
// The find bar: nothing runs past the edge from 1000 px down to 300 px; the count and the option
// toggles go before the arrows and close; the box shrinks from 240 to 100.
{
  const used = (r, items) => 16 + r.inputW + 12 + items.reduce((n, it) => (r.labels.has(it.id) ? n + textW(r.labels.get(it.id), it.size ?? 11) + (it.pad ?? 20) + 6 : n), 0);
  const mk = () => findRowItems(["12 of 120", "12/120"], ["Replace  ctrl-h", "Replace", "⇄"]);
  const rk = () => replaceRowItems(["All  ctrl-alt-enter", "All"], "$1, $2… insert groups");
  assert.equal(fitFindRow(0, mk()).inputW, 240);
  assert.equal(fitFindRow(1000, mk()).labels.get("find-mode"), "Replace  ctrl-h");
  assert.equal(fitFindRow(1000, mk()).inputW, 240);
  let seen = new Set();
  for (let w = 1000; w >= 300; w -= 5) {
    for (const mkItems of [mk, rk]) {
      const items = mkItems(), r = fitFindRow(w, items);
      assert.ok(used(r, items) <= w, `fits at ${w}`);
      assert.ok(r.inputW >= 100 && r.inputW <= 240);
      for (const id of ["find-prev", "find-next", "find-close", "replace-one", "replace-all"]) if (items.some((x) => x.id === id)) assert.ok(r.labels.has(id), `${id} stays at ${w}`);
      if (mkItems === mk) {
        // Order of going: count, regex, word, case, Replace; the arrows and close stay.
        const order = ["count", "find-regex", "find-word", "find-cased", "find-mode"];
        for (let k = 1; k < order.length; k++) if (r.labels.has(order[k - 1])) assert.ok(r.labels.has(order[k]), `${order[k - 1]} outlived ${order[k]} at ${w}`);
        seen.add(order.filter((id) => r.labels.has(id)).length);
      }
    }
  }
  assert.ok(seen.has(5) && seen.has(2), "the full row at the wide end, and items gone by 300 px");
  // 440 px (the reported width) fits with the arrows, close and the Replace toggle in view.
  const r440 = fitFindRow(440, mk());
  for (const id of ["find-prev", "find-next", "find-close"]) assert.ok(r440.labels.has(id));
}
console.log("barfit ok");
