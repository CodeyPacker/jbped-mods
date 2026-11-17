// Wayfindr's own record of the Review panes it opened (#30), so a pane that comes back without its props
// after a restart can be re-made. Pure: no Herdr imports, so it runs under node for tests.
// The file: { version: 1, panes: { "<tab id>": { space, account, pr, at } } }, one Review pane per tab.
import { reviewPaneSpot } from "./launch.js";

export const panesFile = (home) => `${home}/data/wayfindr/panes.json`;
const EMPTY = () => ({ version: 1, panes: {} });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validEntry = (e) => isObj(e) && typeof e.account === "string" && isObj(e.pr) && typeof e.pr.key === "string";

// Unreadable, another version or a bad entry: those parts are dropped, never thrown.
export function parsePanes(text) {
  let raw;
  try { raw = JSON.parse(text ?? ""); } catch { return EMPTY(); }
  if (!isObj(raw) || raw.version !== 1 || !isObj(raw.panes)) return EMPTY();
  const panes = {};
  for (const [tab, e] of Object.entries(raw.panes)) if (validEntry(e)) panes[tab] = e;
  return { version: 1, panes };
}

export const serializePanes = (rec) => JSON.stringify(rec, null, 2) + "\n";

export function addPane(rec, tab, { space, account, pr, at }) {
  return { version: 1, panes: { ...rec.panes, [tab]: { space, account, pr, at } } };
}

// Keeps the records whose tab still exists.
export function prunePanes(rec, tabIds) {
  const keep = new Set(tabIds);
  return { version: 1, panes: Object.fromEntries(Object.entries(rec.panes).filter(([tab]) => keep.has(tab))) };
}

export const lookupPane = (rec, tab) => rec.panes[tab] ?? null;

// Every tab id in spaces().
export const tabIdsOf = (spaceList) => (spaceList ?? []).flatMap((s) => (s.tabs ?? []).map((t) => t.id));

// Wayfindr panes in a recorded tab: what an orphaned pane copy (no props after a restart) looks for.
export const recordedPanes = (rec, paneList) => (paneList ?? []).filter((p) => p.mod === "wayfindr" && rec.panes[p.tab]);

// What re-making the recorded panes takes, per tab: the Wayfindr panes there to close, and the split that
// opens the pane again with its props. The split goes right of the tab's own terminal pane, else the
// space's first terminal pane (reviewPaneSpot). A tab with no terminal to split from is left alone.
export function remakePlan(rec, spaceList, paneList) {
  const plan = [];
  const byTab = new Map();
  for (const p of recordedPanes(rec, paneList)) byTab.set(p.tab, [...(byTab.get(p.tab) ?? []), p.pane]);
  for (const [tab, close] of byTab) {
    const e = rec.panes[tab];
    const terminal = (paneList ?? []).find((p) => p.tab === tab && p.terminal != null)?.pane ?? reviewPaneSpot(spaceList, paneList, e.space)?.terminal ?? null;
    if (!terminal) continue;
    plan.push({ tab, close, split: { pane: terminal, direction: "right", mod: "wayfindr", props: { pr: { account: e.account, pr: e.pr } } } });
  }
  return plan;
}
