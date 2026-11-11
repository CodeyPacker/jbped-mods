// Generic capture, for any agent: while an agent in the space is working, files that
// differ from the working-tree snapshot taken when it started become reviewable, with
// their snapshot content as the baseline. Uses only git and Herdr's file APIs. A store on
// another machine (`store.on`) is captured there: git runs there and the review store's
// files are written there (fsx.writeText).
import { exec, readTextFile, appHome } from "herdr";
import { inRepo, ownerOf, knownDistro } from "./git.js";
import { parkStale, sumOf, MAX_TEXT } from "./store.js";
import { writeText, execOn } from "./fsx.js";
import { mapLimit, REMOTE } from "./remote.js";
import { byteLength } from "./sha256.js";

const isWindows = (p) => /^[A-Za-z]:/.test(p);

/**
 * A terminal's folder as this machine's git sees it. Herdr on Windows reports WSL
 * folders as /mnt/c/... or \\wsl.localhost\<distro>\mnt\c\...; both become C:/...
 */
export function hostPath(cwd) {
  if (!cwd) return null;
  let p = cwd.replace(/\\/g, "/");
  const unc = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)$/i.exec(p);
  if (unc) p = unc[2];
  if (!isWindows(appHome())) return p;
  const mnt = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (mnt) return `${mnt[1].toUpperCase()}:${mnt[2] ?? "/"}`;
  // A folder inside WSL's own files: Windows opens it through \\wsl.localhost\<distro>.
  const distro = unc?.[1] ?? knownDistro();
  return p.startsWith("/") && distro ? `//wsl.localhost/${distro}${p}` : p;
}

/** A temp file of fsx.writeText's (`.wingman-<token>.tmp`): never reviewed, even if a snapshot catches one. */
export const isWriteTemp = (rel) => /(^|\/)\.wingman-[0-9a-z]+\.tmp$/.test(rel);

let snapshotText = null; // snapshot.sh, read once, for machines that don't have it

export class Capture {
  /** `log(line)`: where a skipped file is reported (once per working period). */
  constructor(store, log = () => {}) { this.store = store; this.log = log; this.skipped = new Set(); }

  /** Tree id of the working tree right now (index copy + add -A + write-tree). */
  async snapshot() {
    const { gitDir, root, on } = this.store, dir = `${appHome()}/mods/wingman`;
    let r;
    if (on) {
      // Another machine doesn't have the script: its text goes as sh's script, the folders as its arguments.
      snapshotText ??= (await readTextFile(`${dir}/snapshot.sh`))?.replace(/\r\n/g, "\n") ?? null;
      if (!snapshotText) throw new Error("snapshot.sh is missing from the mod folder");
      r = await execOn("sh", ["-c", snapshotText, "snapshot.sh", gitDir, root], { cwd: root, on, timeout: 120000 });
    } else r = (await ownerOf(root)) === "wsl" ? await inRepo("sh", [`${dir}/snapshot.sh`, gitDir, root], { cwd: root })
      : isWindows(root)
      ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${dir}/snapshot.ps1`, gitDir, root])
      : await exec("sh", [`${dir}/snapshot.sh`, gitDir, root]);
    const tree = r.stdout.trim().split(/\s+/).pop();
    if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree ?? "")) throw new Error(`snapshot failed: ${(r.stderr || r.stdout).trim()}`);
    return tree;
  }

  /** Paths that differ between two trees, with git's status letter (A, M, D, T). */
  async changed(from, to) {
    if (from === to) return [];
    const r = await this.store.git(["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to]);
    if (r.code !== 0) throw new Error(r.stderr.trim());
    const parts = r.stdout.split("\0").filter(Boolean), out = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
    return out;
  }

  /** Saved capture state: the snapshot tree of the current working period, if any. On another
   *  machine the file's text is kept after the first read (only the capture leader writes it). */
  async state() {
    const t = this.store.on && this.text !== undefined ? this.text : await this.store.read(`${this.store.dir}/capture.json`);
    if (this.store.on) this.text = t;
    return t ? JSON.parse(t) : { tree: null };
  }

  async setState(next) {
    const path = `${this.store.dir}/capture.json`, text = JSON.stringify(next, null, 2) + "\n";
    const before = this.store.on && this.text !== undefined ? this.text : await this.store.read(path);
    // A kept text that's stale (another leader wrote meanwhile) fails the swap: read again next time.
    try { await writeText(path, text, before, { on: this.store.on }); } catch (e) { this.text = undefined; throw e; }
    if (this.store.on) this.text = text;
    if (!next.tree) this.skipped.clear(); // a new working period looks at every file again
  }

  /**
   * Adds files that changed since `base` to the review index, each with its content in
   * `base` as baseline (empty and `created` for new files). Files already under review
   * keep their baseline, so the review stays a net diff. Returns how many were added.
   * `by`: the terminal to credit (the one Claude working in the space), or null.
   */
  async adopt(base, now, by = null, space = null) {
    const changes = await this.changed(base, now);
    if (!changes.length) return 0;
    const indexPath = `${this.store.dir}/index.json`, before = await this.store.read(indexPath);
    const index = before ? JSON.parse(before) : { version: 1, files: {} };
    const branch = await this.store.branch(), head = await this.store.head();
    let parked = false;
    const todo = [];
    for (const c of changes) {
      if (isWriteTemp(c.path)) continue;
      if (parkStale(index, c.path, branch)) parked = true;
      if (!index.files[c.path] && !this.skipped.has(c.path)) todo.push(c);
    }
    // Each file's blobs, read and baseline write: one after another here, a few at a time on
    // another machine (each is a call there). The index is written once, after.
    const stamp = Date.now().toString(36);
    const entries = await mapLimit(todo, this.store.on ? REMOTE.parallel : 1, async ({ status, path }, i) => {
      const created = status === "A";
      // Binary files (a NUL byte, as git decides) aren't reviewed, before or after the change. Nor
      // is a text over 1 MiB, which Herdr doesn't read: it's skipped (and logged), the pass goes on.
      const after = status === "D" ? null : await this.store.git(["cat-file", "blob", `${now}:${path}`]);
      if (after && (after.code !== 0 || after.stdout.includes("\0"))) return null;
      if (after && byteLength(after.stdout) > MAX_TEXT) return this.skip(path);
      let text = "";
      if (!created) {
        // The baseline as the working tree had it: git's own checkout conversion of the snapshot's
        // blob (core.autocrlf, core.eol, .gitattributes eol and filters), never a guess from the disk.
        const r = await this.store.git(["cat-file", "--filters", `${base}:${path}`]);
        if (r.code !== 0 || r.stdout.includes("\0")) return null; // unreadable or binary: not reviewed
        if (byteLength(r.stdout) > MAX_TEXT) return this.skip(path);
        text = r.stdout;
      }
      const name = `b${stamp}-${i}.txt`;
      await writeText(`${this.store.dir}/baselines/${name}`, text, null, { on: this.store.on });
      // sum: what the agent's change is, so Store.committed knows it in HEAD later.
      return [path, { baseline: name, created, ...(by ? { by } : {}), branch, head, ...(space ? { space } : {}), sum: await sumOf(after?.stdout ?? null) }];
    });
    let added = 0;
    for (const e of entries) if (e) { index.files[e[0]] = e[1]; added++; }
    if (added || parked) await writeText(indexPath, JSON.stringify(index, null, 2) + "\n", before, { on: this.store.on });
    return added;
  }

  /** Leaves a file over 1 MiB out of the review for this working period, saying so once. */
  skip(path) {
    this.skipped.add(path);
    this.log(`${this.store.root}: ${path} is over 1 MB, not reviewed`);
    return null;
  }
}
