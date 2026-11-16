// E5: line wrap for the built-in editor. Pure. A long line becomes segments that each fit
// `width` display columns, broken after a space when there is one (else mid-word, like VS Code).
// Continuation segments are indented like the line itself ("same" wrapping indent) unless that
// indent takes half the width or more.
import { TAB } from "./edit.js";

/**
 * The line's segments: [{ from, to, ind }] (character range, indent in display columns).
 * It runs inside render() for every line of the file, and Herdr stops a render after about 50 ms
 * ("This view could not be re-rendered", interrupted), so the work per line is kept small: a line
 * without tabs (column = character index) costs a few string calls per segment, and a line with
 * tabs one pass over its characters. Measuring every column from the line start (edit.js
 * visualCol) took about 4.5 s for main.js in Herdr and froze the Edit view.
 */
export function segments(text, width) {
  width = Math.max(8, Math.floor(width));
  const len = text.length, tabs = text.includes("\t");
  if (len <= width && (!tabs || len * TAB <= width)) return [{ from: 0, to: len, ind: 0 }];
  // vc[i]: the display column of character i (edit.js visualCol), only needed with tabs.
  let vc = null;
  if (tabs) {
    vc = new Array(len + 1);
    vc[0] = 0;
    for (let i = 0; i < len; i++) vc[i + 1] = text.charCodeAt(i) === 9 ? vc[i] + TAB - (vc[i] % TAB) : vc[i] + 1;
    if (vc[len] <= width) return [{ from: 0, to: len, ind: 0 }];
  }
  const lead0 = /^\s*/.exec(text)[0].length, lead = vc ? vc[lead0] : lead0;
  const ind = lead < width / 2 ? lead : 0;
  const out = [];
  let from = 0;
  while (from < len) {
    const room = out.length ? width - ind : width;
    let to = from;
    if (!vc) to = Math.min(len, from + room);
    else { const v0 = vc[from]; while (to < len && vc[to + 1] - v0 <= room) to++; }
    if (to === from) to = from + 1; // one character wider than the room (a tab at a narrow width)
    if (to < len) {
      // Break after the last space in the segment, keeping at least one other character on it.
      const seg = text.slice(from, to), sp = seg.lastIndexOf(" ");
      if (sp >= 0 && seg.slice(0, sp).trim()) to = from + sp + 1;
    }
    out.push({ from, to, ind: out.length ? ind : 0 });
    from = to;
  }
  return out;
}

/** The segment holding column `col`: the one it starts or sits inside; the line end goes to the last. */
export function segmentOf(segs, col) {
  for (let i = 0; i < segs.length; i++) if (col < segs[i].to || i === segs.length - 1) return i;
  return segs.length - 1;
}
