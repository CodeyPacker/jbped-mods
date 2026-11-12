// A Workspace's `<name>.code-workspace` file in its Workspace home, one folder per Repo known there.
import { exec, readTextFile, writeTextFile } from "herdr";

const trim = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");

/** The file's JSON text for that Machine. A Repo under `homeDir` gets a relative path. Pure. */
export function workspaceFileText(workspace, mk, cloned, homeDir) {
  const known = cloned?.[mk] ?? {}, home = homeDir == null ? null : trim(homeDir);
  const folders = [];
  for (const identity of workspace.repos ?? []) {
    const at = known[identity];
    if (!at) continue;
    const p = trim(at);
    const path = home !== null && p === home ? "." : home !== null && p.startsWith(home + "/") ? p.slice(home.length + 1) : at;
    folders.push({ path, name: identity.split("/").pop() });
  }
  return JSON.stringify({ folders, settings: {} }, null, 2) + "\n";
}

// $1 the file, $2 the text: written to a temp file beside it, then moved over it.
const WRITE_SH = 'tmp="$1.wranglr-$$" && printf %s "$2" > "$tmp" && mv -f "$tmp" "$1"';

/** Writes the file on that Machine when its content differs. Returns true when it wrote. */
export async function writeWorkspaceFile(workspace, machine, cloned, homeDir) {
  if (homeDir == null) return false;
  const text = workspaceFileText(workspace, machine ?? "", cloned, homeDir);
  const file = `${trim(homeDir)}/${workspace.name.replace(/[\\/:*?"<>|]/g, "-")}.code-workspace`; // a name is not a path
  const old = await readTextFile(file, machine ? { on: machine } : {});
  if (old === text) return false;
  if (!machine) { await writeTextFile(file, text, old); return true; }
  const r = await exec("sh", ["-c", WRITE_SH, "wranglr", file, text], { on: machine });
  if (r.code !== 0) throw new Error(`could not write ${file} on ${machine}: ${r.stderr.trim()}`);
  return true;
}
