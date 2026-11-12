// Asks a small model for one to four words naming a space's work, from its branch and agent title.
import { exec, window } from "herdr";

export function namePrompt(branch, title) {
  return [
    "Name this piece of software work in one to four plain words.",
    `Git branch: ${branch ?? ""}`,
    `Agent session title: ${title ?? ""}`,
    "Reply with the words only: no punctuation, no quotes, nothing else on the line.",
  ].join("\n");
}

/** The first non-empty line, quotes and trailing punctuation stripped, or null. */
export function cleanWords(stdout) {
  const line = String(stdout ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l);
  if (!line) return null;
  const w = line.replace(/^["'`“‘*]+|["'`”’*]+$/g, "").replace(/[.!?,;:]+$/, "").replace(/["'`”’*]+$/, "").trim();
  return w || null;
}

/** The words, or null when the call fails or answers nothing. */
export async function askName(branch, title) {
  const prompt = namePrompt(branch, title);
  let r;
  try {
    r = await exec("claude", ["-p", prompt, "--model", "haiku"], { timeout: 60000 });
  } catch {
    if (window().platform !== "windows") return null;
    try {
      r = await exec("wsl.exe", ["-e", "bash", "-lc", 'claude -p "$1" --model haiku', "_", prompt], { timeout: 60000 });
    } catch { return null; }
  }
  return r.code === 0 ? cleanWords(r.stdout) : null;
}
