// The Run planner: a Collection, a target and the chosen Environments to the `bru run` command.
// Pure: no Herdr, no Node APIs.
import { countRequests, findNode } from "./parser.js";

/** ms for a single Request Run. */
export const SINGLE_TIMEOUT = 60000;
/** ms for a folder or Collection Run, which is also the exec cap. */
export const MULTI_TIMEOUT = 600000;

const relPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");

/**
 * `{ cmd, args, cwd, timeout, count, confirm }` for one Run. `target` is `{ kind: "collection" }`
 * or `{ kind: "folder" | "request", path }`. Each argument is one array item and is never quoted.
 */
export function planRun({ collection, target, environment = null, globalEnvironment = null, workspacePath = null, reportPath }) {
  const kind = target?.kind === "folder" || target?.kind === "request" ? target.kind : "collection";
  const path = kind === "collection" ? "" : relPath(target.path);
  const args = ["run"];
  if (path) args.push(path);
  if (kind === "folder") args.push("-r");
  if (environment) args.push("--env", environment);
  if (globalEnvironment && workspacePath) {
    args.push("--global-env", globalEnvironment, "--workspace-path", String(workspacePath).replace(/\\/g, "/"));
  }
  args.push("--reporter-json", String(reportPath ?? ""));
  const count = runCount(collection, kind, path);
  return {
    cmd: "bru", args, cwd: collection?.root ?? "",
    timeout: kind === "request" ? SINGLE_TIMEOUT : MULTI_TIMEOUT,
    count,
    confirm: kind === "request" ? null : { count, environment: environment || null },
  };
}

function runCount(collection, kind, path) {
  if (kind === "collection") return countRequests(collection);
  const node = findNode(collection, path);
  if (node) return countRequests(node);
  return kind === "request" ? 1 : 0;
}
