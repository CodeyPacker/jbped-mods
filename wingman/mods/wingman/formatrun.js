// Format on save, the part that runs tools. The buffer goes to a temp file beside the target (a mod's
// exec has no stdin), the tool formats that file where the repo's tools run (git.js decides: this
// computer, WSL, or another machine), the result is read back, and the temp file is removed in every
// outcome. The temp file stays inside the repo root and its name is made here (format.js tempName).
import { inRepo, ownerOf, onWindows, wslArg } from "./git.js";
import { pathKind, readText, writeText, deleteFile, join } from "./fsx.js";
import { inside } from "./fileops.js";
import { FORMAT_MS, formattersFor, extOf, tempName, newId } from "./format.js";

/** What a space remembers between formats: the tool found for each folder, and which files a tool ignores. */
export const newFormatCache = () => ({ tools: new Map(), info: new Map() });

const firstLine = (s) => String(s ?? "").replace(/\u001b?\[[0-9;]*m/g, "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? ""; // colour codes out
const timedOut = (e) => /time(d)? ?out/i.test(String(e?.message ?? e));

/**
 * Formats `text` for the file `rel` of the repo at `root` (on machine `on`, if set).
 * Resolves { status: "none" } (no formatter for it here, or the tool ignores the file: `ignoredBy`),
 * { status: "ok", text, tool } or { status: "failed", reason, tool }; `leftover` is set when the
 * temp file could not be removed. Never throws.
 */
export async function formatText({ root, on = null, rel, text, cache = newFormatCache(), id = newId() }) {
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "", ext = extOf(rel);
  const candidates = formattersFor(rel);
  if (!candidates.length) return { status: "none" };
  const started = Date.now(), left = () => Math.max(1000, FORMAT_MS - (Date.now() - started));
  let tool = null;
  try {
    const owner = await ownerOf(root, on), windowsNative = !on && onWindows() && owner === "native";
    const env = { root, dir, windowsNative, kind: (p) => pathKind(p, { on }), read: (p) => readText(p, { on }) };
    for (const f of candidates) {
      const key = `${f.id}|${windowsNative}|${dir}`;
      if (!cache.tools.has(key)) cache.tools.set(key, f.find(env).catch(() => null));
      tool = await cache.tools.get(key);
      if (tool) break;
    }
    if (!tool) return { status: "none" };
    // WSL runs the program by its WSL path (inRepo converts the arguments, not the program).
    if (owner === "wsl" && !on) tool = { ...tool, cmd: wslArg(tool.cmd) };
    const folder = join(root, dir), cwd = tool.cwd ?? (folder || root), file = join(root, rel);
    // Does the tool ignore this file (Prettier: .prettierignore, or no parser for it)? Asked once per file.
    if (tool.info) {
      const ik = `${tool.name}|${file}`;
      if (!cache.info.has(ik)) {
        cache.info.set(ik, inRepo(tool.cmd, tool.info(file), { cwd, timeout: left(), on }).then((r) => (r.code === 0 && tool.ignored(r.stdout)), () => false));
      }
      if (await cache.info.get(ik)) return { status: "none", ignoredBy: tool.name };
    }
    const tmp = join(folder, tempName(id, ext));
    if (!inside(tmp, root)) return { status: "failed", reason: "temp file would be outside the repo", tool: tool.name };
    return await run(tool, { root, on, tmp, cwd, text, left, rel });
  } catch (e) {
    return { status: "failed", reason: timedOut(e) ? `${tool?.name ?? "the formatter"} timed out` : String(e?.message ?? e).slice(0, 200), tool: tool?.name };
  }
}

async function run(tool, { root, on, tmp, cwd, text, left, rel }) {
  let result = { status: "failed", reason: "no result", tool: tool.name };
  try {
    await writeText(tmp, text, null, { on });
    let r;
    try { r = await inRepo(tool.cmd, tool.write(tmp), { cwd, timeout: left(), on }); }
    catch (e) { return (result = { status: "failed", reason: timedOut(e) ? `${tool.name} timed out` : String(e?.message ?? e).slice(0, 200), tool: tool.name }); }
    if (r.code !== 0) {
      const why = firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;
      const base = rel.split("/").pop();
      return (result = { status: "failed", reason: `${tool.name}: ${why.replaceAll(tmp.split("/").pop(), base).replace(/^\[error\]\s*/, "")}`.slice(0, 200), tool: tool.name });
    }
    const out = await readText(tmp, { on });
    if (out == null) return (result = { status: "failed", reason: `${tool.name}: the formatted file could not be read`, tool: tool.name });
    return (result = { status: "ok", text: out, tool: tool.name });
  } finally {
    // The temp file goes in every outcome: a failed or timed out run, an unreadable result, a failed write.
    try { await deleteFile(tmp, root, { on }); }
    catch (e) { if (!/no longer exists/.test(String(e?.message ?? e))) result.leftover = `${tmp.split("/").pop()}: ${String(e?.message ?? e).slice(0, 120)}`; }
  }
}
