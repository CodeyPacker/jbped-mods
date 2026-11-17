// Where Gitr's Repos come from and how it starts a space or a Worktree: through Wranglr when it is in the
// shown layout, else by itself and the shipped worktree mod.
import { layout, shared, setShared, spaces, panes, run, openOverlay } from "herdr";
import { makeResolver } from "./repos.js";

const mkey = (machine) => machine ?? "";
const identityOf = (repo) => (typeof repo === "string" ? repo : repo?.identity);

// A block of `mod` is in the layout tree, hidden or not.
function hasBlock(node, mod) {
  if (!node || typeof node !== "object") return false;
  if (node.content?.mod === mod) return true;
  return Array.isArray(node.children) && node.children.some((c) => hasBlock(c, mod));
}

// The folder a space's first terminal is in now, else where the space was made.
function dirOf(space, paneList) {
  for (const tab of space.tabs ?? []) {
    const p = paneList.find((x) => x.tab === tab.id && x.terminal && x.cwd);
    if (p) return p.cwd;
  }
  return space.folder || null;
}

/** `settings`: the current Gitr settings, or a function returning them. Only the standalone source reads `run` from it. */
export function makeSource({ settings } = {}) {
  const resolver = makeResolver();
  const cfg = () => (typeof settings === "function" ? settings() : settings) ?? {};
  const view = () => shared("wranglr.view");
  const send = (action) => setShared("wranglr.action", { n: (shared("wranglr.action")?.n ?? 0) + 1, action });
  const argvOf = () => cfg().run ?? null;

  const source = {
    kind() {
      return hasBlock(layout(), "wranglr") && Array.isArray(view()?.repos) ? "wranglr" : "standalone";
    },
    enter(s) {
      if (source.kind() === "wranglr") return view().plus === "worktree" ? "worktree" : "checkout";
      return s?.enter === "checkout" ? "checkout" : "worktree";
    },
    async repos() {
      if (source.kind() === "wranglr") return view().repos;
      const list = spaces(), paneList = panes();
      const found = await Promise.all(list.map((s) => {
        const dir = dirOf(s, paneList);
        return dir ? resolver.want(dir, s.machine ?? null) : null;
      }));
      const out = new Map();
      list.forEach((s, i) => {
        const r = found[i];
        if (!r) return;
        const e = out.get(r.identity) ?? { identity: r.identity, name: r.name, on: {} };
        e.on[mkey(s.machine)] ??= r.main;
        out.set(r.identity, e);
      });
      return [...out.values()];
    },
    async startSpace({ repo, machine = null, dir }) {
      if (source.kind() === "wranglr") { send({ type: "start", repo: identityOf(repo), machine, folder: dir }); return; }
      const argv = argvOf();
      run("space.new", { folder: dir, machine: mkey(machine), ...(argv ? { argv } : {}) });
    },
    async makeWorktree({ repo, machine = null, main, branch }) {
      if (source.kind() === "wranglr") {
        send({ type: "plus", group: `repo:${identityOf(repo)}`, sub: null, mode: "worktree", machine, branch });
        return;
      }
      const argv = argvOf();
      openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { folder: main, machine, branch, ...(argv ? { argv } : {}) } });
    },
  };
  return source;
}
