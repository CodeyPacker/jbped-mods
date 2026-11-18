// Where the repo's tools live: the one way Inline edit, Format on save and Problems run a program
// (claude, prettier, eslint, tsc, dotnet) on Linux, macOS, WSL and another machine. Pure: no Herdr
// imports; toolrun.js runs it.
//
// A GUI app's PATH, a non-interactive `sh -lc`'s, and wsl.exe's lack what an interactive shell adds:
// nvm, fnm and volta put node there from ~/.bashrc or ~/.zshrc. So the user's own shell is asked
// once per machine (PROBE_SH: `$SHELL -lic`, which reads the login and the interactive startup
// files) for its PATH, and every later call hands that PATH to a fixed wrapper (TOOL_SH) as an
// argument. Measured on this PC: the probe takes 0.2 s in Linux and 0.5 s through wsl.exe (bash
// with nvm); after it, a call costs one more argument. When the probe fails (another shell, a
// startup file that never returns, no marker in the output), TOOL_SH adds the usual Node
// locations itself: the newest ~/.nvm/versions/node/*/bin, ~/.volta/bin and fnm's default.
//
// Nothing the user typed and no file name is ever in a script: both scripts are fixed text, the
// PATH and the program's argv are arguments ("$1", "$@"), which sh never parses.

/** How long the PATH probe may take, in ms. */
export const PROBE_MS = 10000;
/** A failed probe is tried again after this long (a success is kept for the session). */
export const PROBE_RETRY_MS = 60000;
/** The longest PATH taken from a probe. */
export const MAX_PATH = 16384;

const START = "__WINGMAN_PATH__", END = "__WINGMAN_END__";

/**
 * Prints the PATH of the user's login + interactive shell between two markers, so a banner or
 * anything else the startup files print can't be mistaken for it. Only shells that read `-lic` and
 * `"$PATH"` the POSIX way are asked (fish prints a list); any other exits 3 and the fallback applies.
 */
export const PROBE_SH = `case "\${SHELL##*/}" in bash|zsh|sh|dash|ksh|mksh|ash|yash) ;; *) exit 3 ;; esac
exec "$SHELL" -lic 'printf "\\n%s%s%s\\n" ${START} "$PATH" ${END}'`;

/**
 * The wrapper every tool runs under: $1 is the probed PATH ("" when the probe failed), the rest is
 * the program and its arguments, run as given. ~/.local/bin and ~/.claude/local (where Claude Code
 * installs) come first, as before.
 */
export const TOOL_SH = `p=$1; shift
if [ -n "$p" ]; then PATH=$p
else
  for d in "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/.fnm/aliases/default/bin"; do [ -d "$d" ] && PATH="$d:$PATH"; done
  best=; bn=-1
  for d in "$HOME"/.nvm/versions/node/v*/bin; do
    [ -x "$d/node" ] || continue
    v=\${d%/bin}; v=\${v##*/v}
    case $v in ''|*[!0-9.]*|0[0-9]*) continue ;; esac
    a=\${v%%.*}; r=\${v#*.}; b=\${r%%.*}; c=\${r#*.}; c=\${c%%.*}
    case $b$c in ''|*[!0-9]*) continue ;; esac
    n=$(( a * 1000000 + b * 1000 + c ))
    if [ "$n" -gt "$bn" ]; then bn=$n; best=$d; fi
  done
  [ -n "$best" ] && PATH="$best:$PATH"
fi
PATH="$HOME/.local/bin:$HOME/.claude/local:$PATH"; export PATH
exec "$@"`;

/**
 * The PATH in a probe's output, or null. Only the last marked line counts; only absolute entries
 * without control characters are kept, once each, and at most MAX_PATH characters of them.
 */
export function parseProbe(stdout) {
  const all = [...String(stdout ?? "").matchAll(new RegExp(`${START}([^\\n]*?)${END}`, "g"))];
  const m = all.pop();
  if (!m) return null;
  const seen = new Set(), out = [];
  let size = 0;
  for (const p of m[1].split(":")) {
    if (!p.startsWith("/") || /[\x00-\x1F\x7F]/.test(p) || seen.has(p)) continue;
    if (size + p.length + 1 > MAX_PATH) break;
    seen.add(p); out.push(p); size += p.length + 1;
  }
  return out.length ? out.join(":") : null;
}

/** Which machine a probe answers for: "local" (Linux, macOS), "wsl:<distro>", "on:<machine>", or null (a native Windows program: no probe). */
export function probeKey(where) {
  if (where.on) return `on:${where.on}`;
  if (!where.windows) return "local";
  return where.how === "wsl" ? `wsl:${where.distro ?? ""}` : null;
}

/**
 * Where and how `argv` runs: { how, cmd, args, opts }. `where` (toolrun.js toolWhere):
 * - another machine (`on`): sh -lc TOOL_SH there, in `cwd`;
 * - Linux and macOS here: sh -lc TOOL_SH;
 * - Windows: through wsl.exe for a repo WSL owns, or when there's no native .exe (`nativeExe`
 *   null), else the native .exe directly. `wslCwd`/`distro`: the folder as WSL sees it.
 * `path`: the probed PATH for TOOL_SH ("" or absent: its fallback).
 */
export function plan(argv, { windows = false, on = null, owner = "native", nativeExe = null, cwd = null, wslCwd = null, distro = null, timeout, path = "" } = {}) {
  const shArgs = ["-lc", TOOL_SH, "wingman", path ?? "", ...argv];
  const t = timeout ? { timeout } : {};
  if (on) return { how: "remote", cmd: "sh", args: shArgs, opts: { ...(cwd ? { cwd } : {}), on, ...t } };
  if (!windows) return { how: "sh", cmd: "sh", args: shArgs, opts: { ...(cwd ? { cwd } : {}), ...t } };
  if (owner !== "wsl" && nativeExe) return { how: "native", cmd: nativeExe, args: argv.slice(1), opts: { ...(cwd ? { cwd } : {}), ...t } };
  const at = wslCwd ? ["--cd", wslCwd] : [];
  return { how: "wsl", cmd: "wsl.exe", args: [...(distro ? ["-d", distro] : []), ...at, "-e", "sh", ...shArgs], opts: { ...t } };
}

/** The first .exe of a `where` listing, or null. */
export function exeFrom(whereOut) {
  return String(whereOut ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l)) ?? null;
}
