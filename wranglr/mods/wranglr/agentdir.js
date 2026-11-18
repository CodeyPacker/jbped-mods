// Where a Claude Code agent is working now, on its Machine. Claude Code changes folder inside
// itself and its process stays where it started, so Herdr only knows the starting folder.
// Claude Code's own files say the rest: ~/.claude/sessions/<pid>.json names the session of a
// process, and that session's transcript records the folder on every entry. These files are
// Claude Code's private ones and can change, so every step that fails gives null.
import { exec, hc } from "herdr";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The pid and the session id are passed as arguments, never put into the script text.
const SESSION = 'cat "$HOME/.claude/sessions/$1.json"';
const FOLDER = 'for f in "$HOME"/.claude/projects/*/"$1".jsonl; do [ -r "$f" ] && tail -c 262144 "$f" | grep -o \'"cwd":"[^"]*"\' | tail -n 1; done';

const absolute = (p) => typeof p === "string" && /^(?:[A-Za-z]:)?[\\/]/.test(p) && !/[\r\n\0]/.test(p);

/** The last `"cwd":"…"` line of `text` as a folder, or null. Pure. */
export function lastCwd(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const dir = JSON.parse(`{${line}}`).cwd;
      if (absolute(dir)) return dir;
    } catch {}
  }
  return null;
}

/**
 * What is known of the Claude Code agent in `terminal`, or null when it cannot be told:
 * { pid: the terminal's own process, session, cwd: where the session was started, flags: its command line, dir: where it works now, or null }.
 */
export async function agentFacts(terminal, machine = null) {
  try {
    const opt = { ...(machine ? { on: machine } : {}), timeout: 10000 };
    // The app's own hc, with the terminal's full address: hc may not be on the Machine's path.
    const got = await hc(["get", String(terminal), "--json"]);
    if (got.code !== 0) return null;
    const info = JSON.parse(got.stdout);
    const front = info?.foreground;
    if (front?.name !== "claude" || !Number.isInteger(front.pid) || front.pid <= 0) return null;
    const session = await exec("sh", ["-c", SESSION, "sh", String(front.pid)], opt);
    if (session.code !== 0) return null;
    const record = JSON.parse(session.stdout);
    const id = record?.sessionId;
    if (typeof id !== "string" || !UUID.test(id)) return null;
    const folder = await exec("sh", ["-c", FOLDER, "sh", id], opt).catch(() => null);
    return {
      pid: Number.isInteger(info.pid) && info.pid > 0 ? info.pid : null,
      session: id,
      cwd: absolute(record.cwd) ? record.cwd : null,
      flags: Array.isArray(front.argv) ? front.argv.slice(1).filter((x) => typeof x === "string") : [],
      dir: folder && folder.code === 0 ? lastCwd(folder.stdout) : null,
    };
  } catch {
    return null;
  }
}

/** The folder the Claude Code agent in `terminal` is in now, or null when it cannot be told. */
export const agentDir = async (terminal, machine = null) => (await agentFacts(terminal, machine))?.dir ?? null;

/**
 * A terminal as it is now: { pid, idle } with idle true when nothing runs in front of its shell,
 * { gone: true } when the core says there is no such terminal, or null when it could not be asked.
 */
export async function terminalNow(terminal) {
  try {
    const got = await hc(["get", String(terminal), "--json"]);
    if (got.code !== 0) {
      // Only the core's own "no such terminal" counts as gone. Anything else is asked again later.
      let kind = null;
      try { kind = JSON.parse(got.stdout || got.stderr)?.error?.kind; } catch {}
      return kind === "not_found" ? { gone: true } : null;
    }
    const info = JSON.parse(got.stdout);
    if (info?.state && info.state !== "live") return { gone: true };
    if (!Number.isInteger(info?.pid) || info.pid <= 0) return null;
    return { pid: info.pid, idle: info.foreground?.pid === info.pid };
  } catch {
    return null;
  }
}
