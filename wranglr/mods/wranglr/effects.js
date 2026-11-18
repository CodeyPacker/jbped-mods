// Runs the model's effects through Herdr, in order. A failing effect is reported and the rest run.
import { run, notify, hc } from "herdr";
import { addWorktree } from "./worktree.js";
import { askName as realAskName } from "./namer.js";
import { saveSetting as realSaveSetting, saveSettings as realSaveSettings, saveGroup as realSaveGroup } from "./config.js";

// A worktree for a start effect. False, with git's error shown, when it could not be made.
async function makeWorktree(worktree, machine) {
  const r = await addWorktree(worktree, machine);
  if (r.warning) notify({ title: "Wranglr", body: r.warning, level: "warning" });
  if (!r.ok) notify({ title: "Worktree not made", body: r.error, level: "error" });
  return r.ok;
}

async function runOne(e, { dispatch, askName, saveSetting, saveSettings, saveGroup }) {
  switch (e.type) {
    case "select": run("space.select", { id: e.id }); return;
    case "close": for (const id of e.ids) run("space.close", { id, confirmed: true }); return;
    case "revive": {
      // Typed into the terminal's new shell, then Enter.
      const r = await hc(["send", e.terminal, e.command]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc send failed").trim());
      return;
    }
    case "rename": run("space.rename", { id: e.id, name: e.name }); return;
    case "start": {
      if (e.worktree) {
        const made = await makeWorktree(e.worktree, e.machine ?? null);
        // Said either way: the model files the space that comes next, and the list drops its "making" row.
        dispatch({ type: "made", ok: made, group: e.place?.group ?? null, sub: e.place?.sub ?? null, machine: e.machine ?? null, folder: e.folder });
        if (!made) return;
      }
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
    case "settings": await saveSettings(e.values); return;
    case "group": await saveGroup(e.kind, e.key, e.values); return;
    case "toast": notify({ title: e.title, body: e.body, level: e.level }); return;
    default: throw new Error(`unknown effect ${e.type}`);
  }
}

export async function runEffects(effects, deps = {}) {
  const d = { dispatch: () => {}, askName: realAskName, saveSetting: realSaveSetting, saveSettings: realSaveSettings, saveGroup: realSaveGroup, ...deps };
  for (const e of effects ?? []) {
    try { await runOne(e, d); }
    catch (err) {
      const saving = e?.type === "setting" || e?.type === "settings" || e?.type === "group";
      notify({ title: "Wranglr", body: saving ? `Not saved: ${err?.message ?? err}.` : `${e?.type ?? "effect"} failed: ${err?.message ?? err}`, level: "error" });
    }
  }
}
