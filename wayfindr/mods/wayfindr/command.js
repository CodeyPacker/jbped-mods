// Builds the program call for a Profile's runner. Pure: no Herdr imports, so it runs under node.
//   native        runs cmd directly (through `env` when there are variables to set)
//   wsl:<distro>  runs cmd inside that WSL distro: wsl.exe -d <distro> [--cd dir] --exec env K=V cmd args

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// A shell command line (a fixed one from a Provider, like a sign-in command) for a terminal tab,
// through the runner. Herdr runs a tab's argv in the user's interactive shell, which stays open after.
export function shellInvocation(runner, platform, line) {
  if (runner === "native" && platform === "windows") return invocation(runner, platform, "cmd.exe", ["/c", line]);
  return invocation(runner, platform, /^wsl:/.test(runner) ? "bash" : "sh", ["-lc", line]);
}

export function invocation(runner, platform, cmd, args = [], { env = {}, cwd } = {}) {
  const vars = Object.entries(env).filter(([, v]) => v != null);
  for (const [k] of vars) if (!ENV_NAME.test(k)) throw new Error(`Bad environment variable name: ${k}`);
  const kv = vars.map(([k, v]) => `${k}=${v}`);

  const wsl = /^wsl:(\S+)$/.exec(runner);
  if (wsl) {
    const pre = ["-d", wsl[1], ...(cwd ? ["--cd", cwd] : []), "--exec"];
    return { command: "wsl.exe", args: kv.length ? [...pre, "env", ...kv, cmd, ...args] : [...pre, cmd, ...args], cwd: undefined };
  }
  if (runner !== "native") throw new Error(`Unknown runner: ${runner}`);
  if (!kv.length) return { command: cmd, args, cwd };
  if (platform === "windows") throw new Error("The native runner can't set environment variables on Windows. Use wsl:<distro>.");
  return { command: "env", args: [...kv, cmd, ...args], cwd };
}
