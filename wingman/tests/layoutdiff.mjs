// Lists the nodes that changed, were added or were removed between two Herdr layout files, by node id.
//   node wingman/tests/layoutdiff.mjs before.json after.json [--json]
// A node's own fields are compared (everything but `children`), so moving a child in or out shows as
// that child added or removed, not as its parent changing. Floating blocks (`floating`) count as nodes.
// A node without an id is named by its place: "#children.0.children.2".
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function nodes(layout) {
  const out = new Map();
  const visit = (n, path) => {
    if (!n || typeof n !== "object" || Array.isArray(n)) return;
    const id = typeof n.id === "string" ? n.id : `#${path}`;
    if (out.has(id)) throw new Error(`layout has the id "${id}" twice`);
    const own = {};
    for (const [k, v] of Object.entries(n)) if (k !== "children" && k !== "floating") own[k] = v;
    out.set(id, own);
    (n.children ?? []).forEach((c, i) => visit(c, `${path}.children.${i}`.replace(/^\./, "")));
    (n.floating ?? []).forEach((c, i) => visit(c, `${path}.floating.${i}`.replace(/^\./, "")));
  };
  visit(layout, "");
  return out;
}

/** Dotted paths of the leaves that differ between two JSON values (`a` or `b` may be absent). */
function fieldDiff(a, b, path = "") {
  const obj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (obj(a) && obj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => fieldDiff(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [path];
}

/** { changed: [{ id, fields }], added: [id], removed: [id] }, each sorted by id. */
export function diffLayouts(before, after) {
  const a = nodes(before), b = nodes(after);
  const added = [...b.keys()].filter((id) => !a.has(id)).sort();
  const removed = [...a.keys()].filter((id) => !b.has(id)).sort();
  const changed = [];
  for (const [id, own] of a) {
    if (!b.has(id)) continue;
    const fields = fieldDiff(own, b.get(id)).sort();
    if (fields.length) changed.push({ id, fields });
  }
  changed.sort((x, y) => (x.id < y.id ? -1 : 1));
  return { changed, added, removed };
}

export const sameLayout = (d) => !d.changed.length && !d.added.length && !d.removed.length;

export function formatDiff(d) {
  if (sameLayout(d)) return "no differences";
  return [
    ...d.changed.map((c) => `changed ${c.id}: ${c.fields.join(", ")}`),
    ...d.added.map((id) => `added   ${id}`),
    ...d.removed.map((id) => `removed ${id}`),
  ].join("\n");
}

export function readLayout(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [a, b, flag] = process.argv.slice(2);
  if (!a || !b) { console.error("usage: layoutdiff.mjs before.json after.json [--json]"); process.exit(2); }
  const d = diffLayouts(readLayout(a), readLayout(b));
  console.log(flag === "--json" ? JSON.stringify(d, null, 2) : formatDiff(d));
}
