// Makes a worktree for a branch in a Repo, on the Repo's Machine.
// A local branch is checked out. A branch that is only on the remote is tracked.
// A new branch starts from the Repo's `from`, else the Repo's default branch.
import { git } from "./repos.js";

const out = (r) => r.stdout.trim();
const said = (r) => (r.stderr || r.stdout || `git exited ${r.code}`).trim();

/** { ok, warning?, error? }. `from`: the ref a new branch starts from, or null. */
export async function addWorktree({ main, branch, path, from = null }, machine = null) {
  const run = (args, timeout) => git(args, { cwd: main, machine, timeout });
  const has = async (ref) => (await run(["show-ref", "--verify", "--quiet", ref])).code === 0;
  const add = async (args) => {
    const r = await run(["worktree", "add", ...args]);
    return r.code === 0 ? { ok: true } : { ok: false, error: said(r) };
  };

  if (await has(`refs/heads/${branch}`)) return add([path, branch]);

  const remotes = out(await run(["remote"])).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0] ?? null;
  if (remote) {
    // Only on the remote: the fetch fails when it is not there, and that is the answer.
    await run(["fetch", "--quiet", remote, branch], 60000).catch(() => null);
    if (await has(`refs/remotes/${remote}/${branch}`)) return add(["--track", "-b", branch, path, `${remote}/${branch}`]);
  }

  let start = from, warning;
  if (!start) {
    const head = remote ? await run(["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`]) : null;
    if (head && head.code === 0 && out(head)) start = out(head);
    else if (await has("refs/heads/main")) start = "main";
    else if (await has("refs/heads/master")) start = "master";
  }
  // A ref on a remote is fetched first, so the branch starts from what the remote has now.
  const owner = start ? remotes.find((r) => start.startsWith(`${r}/`)) : null;
  if (owner) {
    const fetched = await run(["fetch", "--quiet", owner, start.slice(owner.length + 1)], 60000).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
    if (fetched.code !== 0) warning = `Could not fetch ${start}, so ${branch} starts from the local copy.`;
  }
  // --no-track: the new branch must not push to the branch it started from.
  const made = await add(["--no-track", "-b", branch, path, ...(start ? [start] : [])]);
  return made.ok && warning ? { ...made, warning } : made;
}
