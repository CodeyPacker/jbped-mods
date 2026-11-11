// The undo history's bound: each step keeps a whole file state, so a copy's history keeps at most
// UNDO.steps steps and about UNDO.bytes of text, dropping the oldest first. Pure.

export const UNDO = { steps: 200, bytes: 24e6 };

const len = (s) => (typeof s === "string" ? s.length : 0);

/**
 * A step's rough size in characters of text. An edit step ({ edit, state }) counts its file's
 * current text: typing never changes the baseline, which every step of the file shares. A review
 * step ({ snaps }) counts both texts of each file it changed (Accept writes the baseline, Reject the file).
 */
export function stepCost(step) {
  if (step?.edit) return len(step.state?.Ctext) + 1;
  return (step?.snaps ?? []).reduce((n, f) => n + len(f.Btext) + len(f.Ctext), 0) + 1;
}

/**
 * Drops the oldest steps of `list` (in place) until it has at most `limits.steps` steps and their
 * costs add up to at most `limits.bytes`; the newest step always stays. Each step's cost is kept on
 * it (`cost`), so a step is measured once. Returns how many steps were dropped.
 */
export function capSteps(list, limits = UNDO) {
  let total = 0;
  for (const s of list) total += (s.cost ??= stepCost(s));
  let n = 0;
  while (list.length - n > 1 && (list.length - n > limits.steps || total > limits.bytes)) total -= list[n++].cost;
  if (n) list.splice(0, n);
  return n;
}
