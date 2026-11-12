// Runs a program for a Profile. Providers and flows use this, never exec directly.
import { exec, window as herdrWindow } from "herdr";
import { invocation } from "./command.js";

export function createRunner(runner) {
  const platform = herdrWindow().platform;
  return {
    runner,
    // Resolves with { code, stdout, stderr }. A program that can't start gives code 127.
    async run(cmd, args = [], { env, cwd, timeout } = {}) {
      let call;
      try { call = invocation(runner, platform, cmd, args, { env, cwd }); } catch (e) {
        return { code: 127, stdout: "", stderr: String(e.message ?? e) };
      }
      try {
        return await exec(call.command, call.args, { cwd: call.cwd, timeout });
      } catch (e) {
        return { code: 127, stdout: "", stderr: String(e.message ?? e) };
      }
    },
  };
}
