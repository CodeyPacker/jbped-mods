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

/** The folder the Claude Code agent in `terminal` is in now, or null when it cannot be told. */
export async function agentDir(terminal, machine = null) {
  try {
    const opt = { ...(machine ? { on: machine } : {}), timeout: 10000 };
    // The app's own hc, with the terminal's full address: hc may not be on the Machine's path.
    const got = await hc(["get", String(terminal), "--json"]);
    if (got.code !== 0) return null;
    const front = JSON.parse(got.stdout)?.foreground;
    if (front?.name !== "claude" || !Number.isInteger(front.pid) || front.pid <= 0) return null;
    const session = await exec("sh", ["-c", SESSION, "sh", String(front.pid)], opt);
    if (session.code !== 0) return null;
    const id = JSON.parse(session.stdout)?.sessionId;
    if (typeof id !== "string" || !UUID.test(id)) return null;
    const folder = await exec("sh", ["-c", FOLDER, "sh", id], opt);
    return lastCwd(folder.stdout);
  } catch {
    return null;
  }
}
