// Fitting a bar of buttons into its width. Pure. As the width shrinks the bar degrades in order:
// key hints go first, then labels shorten, then the least needed items go whole. A button never
// shows a label cut mid-word: it shows a shorter label or isn't shown (its key still works).

// Text width estimate for the app's UI font: a little over its measured average (about 0.44 em
// per character on Windows), so a label that's estimated to fit does fit.
const EM = 0.5;

/** Estimated width of `text` at font size `size`, in logical pixels. */
export const textW = (text, size = 11) => [...String(text)].length * size * EM;

/**
 * Picks each item's label for a bar `width` wide. `items`: { id, labels: [full, ...shorter],
 * size (font), pad (left + right padding), drop (order in which the item goes whole: lower goes
 * first; Infinity never), group (optional: items of one group go together, e.g. Reject and
 * Accept) }. `fixed`: width the bar spends on other things (gaps, padding, a flexible
 * area's minimum). Level k shows each item's labels[min(k, last)]; when the shortest labels don't
 * fit, items go by `drop`. Returns Map id -> label (absent: not shown). An unknown width (0 or
 * undefined: not measured yet) shows everything in full.
 */
export function fitBar(width, items, fixed = 0, gap = 4) {
  const out = new Map();
  if (!(width > 0)) { for (const it of items) out.set(it.id, it.labels[0]); return out; }
  const w = (it, label) => textW(label, it.size ?? 11) + (it.pad ?? 20) + gap;
  const levels = Math.max(1, ...items.map((it) => it.labels.length));
  for (let k = 0; k < levels; k++) {
    const pick = items.map((it) => it.labels[Math.min(k, it.labels.length - 1)]);
    if (fixed + items.reduce((n, it, i) => n + w(it, pick[i]), 0) <= width) { items.forEach((it, i) => out.set(it.id, pick[i])); return out; }
  }
  const shortest = (it) => it.labels[it.labels.length - 1];
  const kept = new Set(items);
  let total = fixed + items.reduce((n, it) => n + w(it, shortest(it)), 0);
  for (const it of [...items].filter((x) => x.drop !== Infinity).sort((a, b) => (a.drop ?? 0) - (b.drop ?? 0))) {
    if (total <= width) break;
    for (const x of it.group ? items.filter((y) => y.group === it.group) : [it]) if (kept.has(x)) { kept.delete(x); total -= w(x, shortest(x)); }
  }
  for (const it of items) if (kept.has(it)) out.set(it.id, shortest(it));
  return out;
}

const TITLE_W = 64, SWITCH_W = 120, SWITCH_NARROW_W = 52, HEADER_PAD = 24, HEADER_GAP = 10;
/** Items with this `drop` or higher are the header's last ones (Comments, Settings): they shorten before anything else of theirs goes. */
export const LAST_DROP = 99;

/**
 * The pane header's buttons (fitBar) for a header `width` wide. `panel`: a panel copy (no
 * Review/Edit switch); `subtitle`: the room the subtitle keeps while the title shows. When the
 * last items (drop >= LAST_DROP: Comments, Settings) don't fit beside the title, the title goes and
 * the switch shortens (`narrow`), so they still fit, as icons, down to 180 px. `fixed`: the width
 * the bar keeps for the rest. Returns { labels, narrow, fixed }.
 */
export function fitHeader(width, items, { panel = true, subtitle = 80 } = {}) {
  const used = (labels, fixed) => fixed + items.filter((it) => labels.has(it.id)).reduce((n, it) => n + textW(labels.get(it.id), it.size ?? 11) + (it.pad ?? 20) + HEADER_GAP, 0);
  const wideFixed = HEADER_PAD + TITLE_W + HEADER_GAP + subtitle + HEADER_GAP + (panel ? 0 : SWITCH_W + HEADER_GAP);
  const wide = fitBar(width, items, wideFixed, HEADER_GAP);
  if (!(width > 0) || (used(wide, wideFixed) <= width && items.every((it) => (it.drop ?? 0) < LAST_DROP || wide.has(it.id)))) return { labels: wide, narrow: false, fixed: wideFixed };
  const fixed = HEADER_PAD + (panel ? 0 : SWITCH_NARROW_W + HEADER_GAP);
  return { labels: fitBar(width, items, fixed, HEADER_GAP), narrow: true, fixed };
}

/** The Settings dialog's sections (main.js renderSettings); Machine only for a space on another machine. */
export const settingsTabs = (machine) => [
  { id: "general", label: "General" }, { id: "editing", label: "Editing" }, { id: "inline", label: "Inline edit" }, { id: "problems", label: "Problems" },
  ...(machine ? [{ id: "machine", label: "Machine" }] : []),
];

/** The Settings dialog's height (element px): fits an 820 px window at zoom 1.2. */
export const SETTINGS_H = 620;

/**
 * The Settings dialog's height for a pane `paneH` element px tall (null: not measured). The window is
 * at least the pane's height plus the bars around it, so a short pane caps the dialog; a section
 * that doesn't fit then scrolls inside it.
 */
export const settingsHeight = (paneH) => (paneH > 0 ? Math.max(360, Math.min(SETTINGS_H, Math.round(paneH + 40))) : SETTINGS_H);

// FIND_PAD: the bar's 16 px of padding plus 10 px for glyphs wider than textW thinks (seen on screen).
const FIND_PAD = 26, FIND_GAP = 6, FIND_INPUT_MIN = 100, FIND_INPUT_MAX = 240;

/**
 * One row of the find bar (a text box then buttons, a spacer, and more buttons) in a bar `width`
 * wide: which items show with which label (fitBar), and the box's width: 240 when there's room,
 * down to 100. `items` as fitBar's. An unknown width (0) shows everything in full.
 */
export function fitFindRow(width, items) {
  const labels = fitBar(width, items, FIND_PAD + FIND_INPUT_MIN + 2 * FIND_GAP, FIND_GAP);
  if (!(width > 0)) return { labels, inputW: FIND_INPUT_MAX };
  const used = items.reduce((n, it) => (labels.has(it.id) ? n + textW(labels.get(it.id), it.size ?? 11) + (it.pad ?? 20) + FIND_GAP : n), 0);
  const room = width - FIND_PAD - used - 2 * FIND_GAP;
  return { labels, inputW: Math.max(FIND_INPUT_MIN, Math.min(FIND_INPUT_MAX, Math.floor(room))) };
}

/**
 * The find row's items: the match count (`counts`: [full, short]), the option toggles, the
 * previous and next arrows, the Replace toggle (`replaceLabels`) and the close button. They go in
 * this order as the bar narrows: count, toggles (regex first), Replace toggle. The arrows and close stay.
 */
export function findRowItems(counts, replaceLabels) {
  return [
    { id: "count", labels: counts, drop: 1, pad: Math.max(0, 70 - textW(counts[0])) },
    { id: "find-regex", labels: [".*"], drop: 2, pad: 16 },
    { id: "find-word", labels: ["W"], drop: 3, pad: 16 },
    { id: "find-cased", labels: ["Aa"], drop: 4, pad: 16 },
    { id: "find-mode", labels: replaceLabels, drop: 5, pad: 26 },
    { id: "find-prev", labels: ["↑"], drop: Infinity, pad: 26 },
    { id: "find-next", labels: ["↓"], drop: Infinity, pad: 26 },
    { id: "find-close", labels: ["×"], drop: Infinity, pad: 26 },
  ];
}

/** The replace row's items: the group hint goes first, then Replace and All shorten. */
export function replaceRowItems(allLabels, hint) {
  return [
    ...(hint ? [{ id: "hint", labels: [hint], drop: 1, pad: 0 }] : []),
    { id: "replace-one", labels: ["Replace"], drop: Infinity },
    { id: "replace-all", labels: allLabels, drop: Infinity },
  ];
}

/** "label  key" when there's a key, else the label. */
export const withKey = (label, key) => (key ? `${label}  ${key}` : label);

/**
 * The buttons on a change's header row in the diff (Reject, Accept, Ask, Comment), for a diff
 * `width` wide: their width, and whether they show their keys. The row's click map (rowButton)
 * uses the same widths. `gutter`: the line number column; `gap`: between buttons.
 */
export function hunkButtons(width, gutter, gap, count = 4) {
  const room = (bw) => gutter + count * (bw + gap);
  if (!(width > 0) || room(110) + 90 <= width) return { w: 110, keys: true, note: true, shown: count };
  if (room(72) + 90 <= width) return { w: 72, keys: false, note: true, shown: count };
  // Narrower still: no "change n of m", and the last buttons go when even the narrowest don't fit.
  const w = Math.max(56, Math.min(72, Math.floor((width - gutter) / count) - gap));
  return { w, keys: false, note: false, shown: Math.max(1, Math.min(count, Math.floor((width - gutter) / (w + gap)))) };
}
