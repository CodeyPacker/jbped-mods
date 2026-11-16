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
