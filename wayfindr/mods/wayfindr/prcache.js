// The Pull Request detail cache (#31): one file per PR under data/wayfindr/prs/, named like its viewed marks.
// Shown at once on open; refetched only when the list says the PR moved, the copy is old, or on Refresh.
// After every list fetch, the files of PRs no longer listed are pruned. Pure: no Herdr imports.
import { viewedKey } from "./prfiles.js";

export const PR_CACHE_DIR = "data/wayfindr/prs";
const VERSION = 1;

export const prCacheFile = (home, pr) => `${home}/${PR_CACHE_DIR}/${viewedKey(pr)}.json`;

// { at, data } when the file is this version and this PR's, else null.
export function parsePrCache(text, key) {
  try {
    const c = JSON.parse(text);
    if (c?.version === VERSION && c.key === key && typeof c.at === "number" && c.data && typeof c.data === "object") return { at: c.at, data: c.data };
  } catch { /* missing or broken: no cached copy */ }
  return null;
}

export const serializePrCache = (key, at, data) => JSON.stringify({ version: VERSION, key, at, data }) + "\n";

// Whether the detail needs a fetch: no cached copy, one older than pollMs, or the list row (a PrSummary) says the
// PR moved (its head or updated time differs). A null head or updatedAt in the row says nothing.
export function detailStale(cached, summary, now, pollMs) {
  if (!cached?.data || typeof cached.at !== "number") return true;
  if (now - cached.at > pollMs) return true;
  if (typeof summary?.head === "string" && summary.head !== cached.data.head) return true;
  if (typeof summary?.updatedAt === "string" && summary.updatedAt !== cached.data.updatedAt) return true;
  return false;
}

// The file names (a readdir of prs/ or viewed/) that belong to no listed PR. Only "<viewedKey>.json" names are
// Wayfindr's: other names are left alone.
export function prunePrKeys(fileNames, summaries) {
  const keep = new Set((summaries ?? []).map((s) => `${viewedKey(s)}.json`));
  return (fileNames ?? []).filter((n) => typeof n === "string" && n.endsWith(".json") && !keep.has(n));
}
