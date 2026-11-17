// Runs the model's effects, in order, through git, Herdr and a Source. The first failure stops the list.
import { run, notify, closeOverlay } from "herdr";
import { git } from "./repos.js";

const said = (r) => (r.stderr || r.stdout || `git exited with code ${r.code}`).trim();
const FETCH_MS = 60000;

// A failure the list stops on. `refuse` hands the action back to the view with git's message.
class Stop extends Error {
  constructor(message, refuse) { super(message); this.refuse = refuse; }
}

// git in the Main checkout (or `cwd`) on ctx.machine. Returns git's result without judging the exit code.
const inMain = (ctx, args, cwd) => git(args, { cwd: cwd ?? ctx.main, machine: ctx.machine ?? null });

// The first (topmost) stash entry whose subject ends with `message`: its hash, else null.
async function findEntry(ctx, message) {
  const r = await inMain(ctx, ["stash", "list", "--format=%H%x00%gs"]);
  if (r.code !== 0) return null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const [hash, subject = ""] = line.split("\0");
    if (hash && subject.endsWith(message)) return hash;
  }
  return null;
}

// Reapplies the entry by hash, then drops it by its current index. Returns a warning toast, or null when all went well.
// A failed apply keeps the entry. The stack is shared with every Worktree: never pop, never assume stash@{0}.
export async function reapplyEntry(ctx, hash, message) {
  const applied = await inMain(ctx, ["stash", "apply", hash]);
  if (applied.code !== 0) {
    return { level: "warning", title: "Stash kept: changes not reapplied", body: `Your changes are in the stash entry "${message}" (${hash.slice(0, 8)}). ${said(applied)}` };
  }
  const list = await inMain(ctx, ["stash", "list", "--format=%H"]);
  const at = list.code === 0 ? list.stdout.split(/\r?\n/).indexOf(hash) : -1;
  if (at < 0) return null;
  const dropped = await inMain(ctx, ["stash", "drop", `stash@{${at}}`]);
  return dropped.code === 0 ? null : { level: "warning", title: "Stash entry not dropped", body: `"${message}" (${hash.slice(0, 8)}) was reapplied. ${said(dropped)}` };
}

/** `checkout` in the Main checkout. With stash: push, find the entry, checkout, reapply, drop.
 *  `tap(step)` is called after each step ("push", "find", "checkout", "reapply"), for tests that act in between.
 *  Returns the toasts to show. Throws Stop on failure. */
export async function checkoutEffect(e, ctx, tap = async () => {}) {
  const toasts = [];
  if (!e.stash) {
    const r = await inMain(ctx, ["checkout", e.branch, "--"]);
    if (r.code !== 0) throw new Stop(said(r));
    return toasts;
  }
  const head = await inMain(ctx, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const from = head.code === 0 && head.stdout.trim() ? head.stdout.trim() : "(detached)";
  const message = `gitr ${new Date(ctx.now ?? Date.now()).toISOString()} ${from} to ${e.branch}`;
  const pushed = await inMain(ctx, ["stash", "push", "-m", message]);
  if (pushed.code !== 0) throw new Stop(said(pushed));
  await tap("push");
  // Nothing to save leaves no entry.
  const hash = await findEntry(ctx, message);
  await tap("find");
  const co = await inMain(ctx, ["checkout", e.branch, "--"]);
  await tap("checkout");
  if (co.code !== 0) {
    if (hash) {
      const w = await reapplyEntry(ctx, hash, message);
      if (w) toasts.push(w);
    }
    const err = new Stop(said(co));
    err.toasts = toasts;
    throw err;
  }
  if (hash) {
    const w = await reapplyEntry(ctx, hash, message);
    await tap("reapply");
    if (w) toasts.push(w);
  }
  return toasts;
}

// `origin/main` to ["origin", "main"], or null for a ref with no remote part.
function splitRef(ref) {
  const i = String(ref).indexOf("/");
  return i > 0 ? [ref.slice(0, i), ref.slice(i + 1)] : null;
}

async function runOne(e, ctx, toasts) {
  const toast = (t) => { toasts.push(t); notify({ title: t.title, body: t.body, level: t.level }); };
  switch (e.type) {
    case "git": {
      const r = await git(e.args, { cwd: e.cwd ?? ctx.main, machine: ctx.machine ?? null, timeout: e.timeout });
      if (r.code !== 0) throw new Stop(said(r), e.refuse);
      return;
    }
    case "checkout":
      try { for (const t of await checkoutEffect(e, ctx, ctx.tap)) toast(t); }
      catch (err) { for (const t of err.toasts ?? []) toast(t); throw err; }
      return;
    case "fetch": {
      const parts = splitRef(e.ref);
      if (!parts) return; // A local ref: nothing to fetch.
      const r = await git(["fetch", "--quiet", parts[0], parts[1]], { cwd: ctx.main, machine: ctx.machine ?? null, timeout: FETCH_MS });
      if (r.code !== 0) toast({ level: "warning", title: `Could not fetch ${e.ref}`, body: `The new Branch may be behind the remote. ${said(r)}` });
      return;
    }
    case "worktree":
      await ctx.source.makeWorktree({ repo: ctx.repo, machine: ctx.machine ?? null, main: ctx.main, branch: e.branch });
      return;
    case "space.start":
      await ctx.source.startSpace({ repo: ctx.repo, machine: ctx.machine ?? null, dir: e.dir });
      return;
    case "space.select": run("space.select", { id: e.id }); return;
    case "space.close": run("space.close", { id: e.id, confirmed: true }); return;
    case "close": closeOverlay(ctx.overlay); return;
    case "refresh": await ctx.onRefresh?.(); return;
    case "set": ctx.onSet?.(e.key, e.value); return;
    case "toast": toast({ level: e.level, title: e.title, ...(e.body === undefined ? {} : { body: e.body }) }); return;
    default: throw new Stop(`unknown effect ${e?.type}`);
  }
}

/** Runs `effects` in order. Never throws.
 *  { ok: true, toasts } | { ok: false, error, toasts } | { ok: false, next, said, toasts } (a refused git effect). */
export async function runEffects(effects, ctx) {
  const toasts = [];
  for (const e of effects ?? []) {
    try {
      await runOne(e, ctx, toasts);
    } catch (err) {
      const message = String(err?.message ?? err);
      if (err instanceof Stop && err.refuse) return { ok: false, next: err.refuse, said: message, toasts };
      return { ok: false, error: message, toasts };
    }
  }
  return { ok: true, toasts };
}
