// Runs the model's effects through Herdr, in order. A failing effect is reported and the rest run.
import { run, notify } from "herdr";
import { addWorktree } from "./worktree.js";
import { askName as realAskName } from "./namer.js";
import { saveSetting as realSaveSetting } from "./config.js";

// A worktree for a start effect. False, with git's error shown, when it could not be made.
async function makeWorktree(worktree, machine) {
  const r = await addWorktree(worktree, machine);
  if (r.warning) notify({ title: "Wranglr", body: r.warning, level: "warning" });
  if (!r.ok) notify({ title: "Worktree not made", body: r.error, level: "error" });
  return r.ok;
}

async function runOne(e, { dispatch, askName, saveSetting }) {
  switch (e.type) {
    case "select": run("space.select", { id: e.id }); return;
    case "rename": run("space.rename", { id: e.id, name: e.name }); return;
    case "start": {
      if (e.worktree && !(await makeWorktree(e.worktree, e.machine ?? null))) return;
      const args = {};
      if (e.folder) args.folder = e.folder;
      // Always say which Machine: without it Herdr starts the space on the focused space's Machine. "" is this computer.
      args.machine = e.machine ?? "";
      if (e.argv != null) args.argv = e.argv;
      if (e.name != null) args.name = e.name;
      run("space.new", args);
      return;
    }
    case "ask": {
      const words = await askName(e.branch, e.title).catch(() => null);
      dispatch({ type: "named", space: e.space, words });
      return;
    }
    case "setting": await saveSetting(e.key, e.value); return;
    case "toast": notify({ title: e.title, body: e.body, level: e.level }); return;
    default: throw new Error(`unknown effect ${e.type}`);
  }
}

export async function runEffects(effects, deps = {}) {
  const d = { dispatch: () => {}, askName: realAskName, saveSetting: realSaveSetting, ...deps };
  for (const e of effects ?? []) {
    try { await runOne(e, d); }
    catch (err) { notify({ title: "Wranglr", body: `${e?.type ?? "effect"} failed: ${err?.message ?? err}`, level: "error" }); }
  }
}
