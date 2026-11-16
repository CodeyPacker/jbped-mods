// Wayfindr's keys, as CodeyPacker's mods and Dockr have them: what a keystroke does in each layer, and
// what the legend and the "?" list say. One function decides both, so the legend never names a key
// that does nothing. No Herdr calls here.
//
// Layers: "board", "ticket" (the detail panel open), "move" (the Move list open), "launch" (the Launch
// card open), "prs" (the Pull Request list), "pr" (the overlay or the pane copy), "review" (the Post review
// screen), "confirm" (the Post confirm), "help" (the "?" list), "settings".
// Facts, all booleans: url, canLaunch, canReview, canUpdate, canMove, canComment, canPost, pane, full,
// hasFile (a file is shown, not the Overview), hasRows. In "review", canPost means the review is ready to post.

/** The letters the "prs" layer's own keys use, so no Pull Request row gets one as its hint. */
export const RESERVED = "jkghlbpsoyrqnv";

const NAV = {
  j: "next", down: "next", "ctrl-n": "next",
  k: "prev", up: "prev", "ctrl-p": "prev",
  g: "first", home: "first",
  "shift-g": "last", end: "last",
};
const HELP = new Set(["?", "shift-/"]);
const LAYERS = ["board", "ticket", "move", "launch", "prs", "pr", "review", "confirm", "help", "settings"];

const act = (action, arg) => (arg === undefined ? { action } : { action, arg });
const when = (ok, action) => (ok ? act(action) : null);

/**
 * What keystroke `k` does in `layer`: { action, arg? }, or null when it does nothing there.
 * `k` is the keystroke as Herdr gives it ("j", "shift-g", "shift-/", "ctrl-n", "down", "enter", "escape").
 * A modifier makes another key: "ctrl-left" is not "left".
 * @param {string} layer
 * @param {string} k
 * @param {Record<string, boolean>} [facts]
 * @returns {{ action: string, arg?: string } | null}
 */
export function keyAction(layer, k, facts = {}) {
  const f = facts ?? {};
  if (layer === "help") return HELP.has(k) || k === "q" || k === "escape" ? act("hide") : null;
  if (layer === "settings") return k === "q" || k === "escape" ? act("back") : null;
  if (HELP.has(k)) return LAYERS.includes(layer) ? act("help") : null;
  if (layer === "confirm") {
    if (k === "y") return act("yes");
    if (k === "n" || k === "q" || k === "escape") return act("no");
    return null;
  }
  if (layer === "launch") {
    if (k === "enter") return act("start");
    if (k === "q" || k === "escape") return act("close");
    return null;
  }
  if (layer === "move") {
    if (NAV[k]) return act(NAV[k]);
    if (k === "enter") return act("pick");
    if (k === "q" || k === "escape") return act("close");
    return null;
  }
  if (layer === "review") {
    if (k === "p" || k === "enter") return when(f.canPost, "ask");
    if (k === "q" || k === "escape") return act("back");
    if (NAV[k]) return act(NAV[k]);
    if (k === "r") return act("refresh");
    return null;
  }
  if (layer === "pr") {
    if (NAV[k]) return act(NAV[k]);
    if (k === "v") return when(f.hasFile, "viewed");
    if (k === "c") return act("checks");
    if (k === "p") return when(f.canPost, "post");
    if (k === "f") return when(!f.pane, "full");
    if (k === "o") return when(f.url, "browser");
    if (k === "y") return when(f.url, "copy");
    if (k === "s") return when(f.canReview && !f.pane, "review");
    if (k === "r") return act("refresh");
    if (k === "q") return when(!f.pane, "close");
    return null;
  }
  if (layer === "prs") {
    if (NAV[k] || k === "enter") return when(f.hasRows, NAV[k] ?? "open");
    if (k === "o") return when(f.url, "browser");
    if (k === "y") return when(f.url, "copy");
    if (k === "s") return when(f.canReview, "review");
    if (k === "b") return act("viewBoard");
    if (k === "p") return act("viewPrs");
    if (k === "r") return act("refresh");
    if (k === "q") return act("close");
    if (/^[a-z]$/.test(k) && !RESERVED.includes(k)) return when(f.hasRows, "letter");
    return null;
  }
  if (layer === "board" || layer === "ticket") {
    if (NAV[k] || k === "enter") return when(f.hasRows, NAV[k] ?? "open");
    if (k === "h" || k === "left") return when(f.hasRows, "colPrev");
    if (k === "l" || k === "right") return when(f.hasRows, "colNext");
    if (k === "shift-h" || k === "shift-left") return when(f.canMove, "moveLeft");
    if (k === "shift-l" || k === "shift-right") return when(f.canMove, "moveRight");
    if (k === "o") return when(f.url, "browser");
    if (k === "y") return when(f.url, "copy");
    if (k === "s") return when(f.canLaunch, "launch");
    if (k === "b") return act("viewBoard");
    if (k === "p") return act("viewPrs");
    if (k === "r") return act("refresh");
    if (k === "q") return act("close");
    if (layer === "ticket") {
      if (k === "c") return when(f.canComment, "comment");
      if (k === "e") return when(f.canUpdate, "edit");
      if (k === "m") return when(f.canMove, "move");
    }
    return null;
  }
  return null;
}

/** The keystroke a hint's label stands for, where the label is not itself one. */
export const HINT_KEYS = { "j/k": "j", "g/G": "g", "h/l": "h", "H/L": "shift-h", "a letter": "a", "?": "?" };

// Every hint each layer can show, in order: [label, what]. keyHints keeps the ones whose key does something.
const ALL = {
  board: [["j/k", "card"], ["h/l", "column"], ["g/G", "first / last"], ["enter", "open"], ["H/L", "move card"],
    ["s", "launch"], ["o", "browser"], ["y", "copy URL"], ["b", "Board"], ["p", "Pull Requests"], ["r", "refresh"], ["q", "close"]],
  ticket: [["j/k", "card"], ["h/l", "column"], ["g/G", "first / last"], ["enter", "open"], ["H/L", "move card"],
    ["c", "comment"], ["e", "edit title"], ["m", "move to"], ["s", "launch"], ["o", "browser"], ["y", "copy URL"],
    ["b", "Board"], ["p", "Pull Requests"], ["r", "refresh"], ["q", "close"]],
  move: [["j/k", "column"], ["g/G", "first / last"], ["enter", "move here"], ["q", "close"]],
  launch: [["enter", "launch"], ["q", "close"]],
  prs: [["j/k", "move"], ["a letter", "open that row"], ["g/G", "first / last"], ["enter", "open"], ["s", "review"],
    ["o", "browser"], ["y", "copy URL"], ["b", "Board"], ["p", "Pull Requests"], ["r", "refresh"], ["q", "close"]],
  pr: [["j/k", "file"], ["g/G", "Overview / last file"], ["v", "viewed"], ["c", "checks"], ["p", "post review"],
    ["s", "review"], ["f", "fullscreen"], ["o", "browser"], ["y", "copy URL"], ["r", "refetch"], ["q", "close"]],
  review: [["p", "post"], ["enter", "post"], ["j/k", "file"], ["r", "refetch"], ["q", "back"]],
  confirm: [["y", "yes, post"], ["n", "no"], ["q", "no"]],
  help: [["?", "hide this list"], ["q", "hide this list"]],
  settings: [["q", "back"]],
};

// The few each layer's legend shows.
const CORE = {
  board: ["h/l", "j/k", "enter", "s", "q"],
  ticket: ["j/k", "c", "s", "m", "q"],
  move: ["j/k", "enter", "q"],
  launch: ["enter", "q"],
  prs: ["j/k", "a letter", "enter", "s", "q"],
  pr: ["j/k", "v", "p", "s", "q"],
  review: ["p", "q"],
  confirm: ["y", "n"],
  help: ["q"],
  settings: ["q"],
};

const works = (layer, label, facts) => keyAction(layer, HINT_KEYS[label] ?? label, facts) != null;

/**
 * Every key that does something in `layer` now: [label, what] pairs, plus "?" when it works there.
 * @param {string} layer
 * @param {Record<string, boolean>} [facts]
 * @returns {[string, string][]}
 */
export function keyHints(layer, facts = {}) {
  const out = (ALL[layer] ?? []).filter(([label]) => works(layer, label, facts));
  if (layer !== "help" && works(layer, "?", facts)) out.push(["?", "all keys"]);
  return out;
}

/**
 * The legend's few keys for `layer`, then "?" when it works there.
 * @param {string} layer
 * @param {Record<string, boolean>} [facts]
 * @returns {[string, string][]}
 */
export function coreHints(layer, facts = {}) {
  const core = new Set(CORE[layer] ?? []);
  const seen = new Set();
  const out = keyHints(layer, facts).filter(([label]) => core.has(label) && label !== "?" && !seen.has(label) && seen.add(label));
  if (layer !== "help" && works(layer, "?", facts)) out.push(["?", "all keys"]);
  return out;
}
