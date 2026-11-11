// captureplan: one capture record per repo, shared by every space that includes it.
import { capturePlan, applyPlan, capturePass } from "../mods/wingman/captureplan.js";
import assert from "node:assert/strict";

const ACTIVE = new Set(["working", "blocked"]);
const agent = (address, space, status, app = "claude-code") => ({ address, space, status, app });

// ---- capturePlan ------------------------------------------------------------------------------
{
  // The bug's shape: three spaces on one repo, one agent working, two idle.
  const plan = capturePlan(
    [{ id: "s1", roots: ["R"] }, { id: "s2", roots: ["R"] }, { id: "s3", roots: ["R", "Q"] }],
    [agent("t1", "s1", "working"), agent("t2", "s2", "idle"), agent("t3", "s3", "done")], ACTIVE);
  assert.equal(plan.size, 2, "one entry per repo");
  assert.deepEqual(plan.get("R"), { spaces: ["s1", "s2", "s3"], active: true, by: "t1", space: "s1" });
  assert.deepEqual(plan.get("Q"), { spaces: ["s3"], active: false, by: null, space: "s3" }, "idle repo of one space");
}
{
  // Working agents in two spaces on one repo: nobody to credit, no space (shows in both).
  const plan = capturePlan([{ id: "s1", roots: ["R"] }, { id: "s2", roots: ["R"] }],
    [agent("t1", "s1", "working"), agent("t2", "s2", "blocked")], ACTIVE);
  assert.deepEqual(plan.get("R"), { spaces: ["s1", "s2"], active: true, by: null, space: null });
}
{
  // Two working agents in one space: the space, no `by`. A lone non-Claude: no `by`.
  let plan = capturePlan([{ id: "s1", roots: ["R"] }, { id: "s2", roots: ["R"] }],
    [agent("t1", "s1", "working"), agent("t2", "s1", "working")], ACTIVE);
  assert.deepEqual(plan.get("R"), { spaces: ["s1", "s2"], active: true, by: null, space: "s1" });
  plan = capturePlan([{ id: "s1", roots: ["R"] }], [agent("t1", "s1", "working", "codex")], ACTIVE);
  assert.deepEqual(plan.get("R"), { spaces: ["s1"], active: true, by: null, space: "s1" });
}
{
  // Agents of a space that doesn't include the repo don't count; nobody working in two spaces: no space.
  const plan = capturePlan([{ id: "s1", roots: ["R"] }, { id: "s2", roots: ["R"] }, { id: "s3", roots: [] }],
    [agent("t3", "s3", "working")], ACTIVE);
  assert.deepEqual(plan.get("R"), { spaces: ["s1", "s2"], active: false, by: null, space: null });
}

// ---- applyPlan --------------------------------------------------------------------------------
{
  const c = { active: false, by: null, space: null, fresh: true, after: false };
  assert.equal(applyPlan(c, { spaces: ["s1"], active: false, by: null, space: "s1" }), null);
  assert.equal(c.space, "s1", "a new record takes its space at once");
  assert.equal(applyPlan(c, { spaces: ["s1", "s2"], active: true, by: "t2", space: "s2" }), "started");
  assert.deepEqual([c.by, c.space, c.active], ["t2", "s2", true]);
  assert.equal(applyPlan(c, { spaces: ["s1", "s2"], active: true, by: "t2", space: "s2" }), null, "still working");
  assert.equal(applyPlan(c, { spaces: ["s1", "s2"], active: false, by: null, space: null }), "stopped");
  assert.deepEqual([c.by, c.space, c.active, c.after], ["t2", "s2", false, true], "credit kept for the last pass");
}

// ---- capturePass against a fake Capture -------------------------------------------------------
/** A fake Capture over a shared capture.json (`disk`), counting snapshots saved and clears. */
function fakeCapture(disk, counts) {
  let n = 0;
  return {
    store: { on: null, branch: async () => "main" },
    state: async () => ({ ...disk.state }),
    setState: async (next) => { disk.state = { ...next }; if (next.tree) counts.saved++; else counts.cleared++; },
    snapshot: async () => `tree${n++ % 2 ? "b" : "a"}`.padEnd(40, "0"),
    adopt: async (base, now, by, space) => { counts.adopts.push({ by, space }); return 0; },
  };
}

/** One leader tick: plan from `spaces`/`agents`, apply to `records`, start passes, then a collect pass each. */
async function tick(records, spaces, agents) {
  const plan = capturePlan(spaces, agents, ACTIVE);
  for (const [k, p] of plan) if (applyPlan(records.get(k), p) === "started") await capturePass(records.get(k), true);
  for (const c of records.values()) if (c.active || c.after) await capturePass(c);
}

{
  // Two spaces on one repo, one working and one idle: one record, active, never cleared while the agent works.
  const disk = { state: { tree: null } }, counts = { saved: 0, cleared: 0, adopts: [] };
  const spaces = [{ id: "s1", roots: ["R"] }, { id: "s2", roots: ["R"] }];
  const records = new Map([["R", { capture: fakeCapture(disk, counts), active: false, by: null, space: null, fresh: true, after: false }]]);
  let agents = [agent("t1", "s1", "working"), agent("t2", "s2", "idle")];
  for (let i = 0; i < 10; i++) await tick(records, spaces, agents);
  assert.equal(records.size, 1);
  assert.equal(records.get("R").active, true);
  assert.equal(counts.saved, 1, "one snapshot for the turn, no re-snapshot loop");
  assert.equal(counts.cleared, 0, "never cleared while the agent works");
  assert.ok(counts.adopts.length >= 9 && counts.adopts.every((a) => a.by === "t1" && a.space === "s1"), "credited to the working agent");
  // The agent stops: one last pass (credited), then the state is cleared, and nothing more.
  agents = [agent("t1", "s1", "idle"), agent("t2", "s2", "idle")];
  const adopts = counts.adopts.length;
  for (let i = 0; i < 5; i++) await tick(records, spaces, agents);
  assert.equal(counts.adopts.length, adopts + 1, "one pass after the turn");
  assert.deepEqual(counts.adopts.at(-1), { by: "t1", space: "s1" });
  assert.equal(counts.cleared, 1);
  assert.equal(counts.saved, 1);
  assert.equal(disk.state.tree, null);
}
{
  // The old shape for contrast: a record per space on the same capture.json re-snapshots every tick.
  const disk = { state: { tree: null } }, counts = { saved: 0, cleared: 0, adopts: [] };
  const working = { capture: fakeCapture(disk, counts), active: true, after: false };
  const idle = { capture: fakeCapture(disk, counts), active: false, after: true };
  for (let i = 0; i < 5; i++) { await capturePass(working); await capturePass(idle); idle.after = true; }
  assert.ok(counts.saved >= 5 && counts.cleared >= 4, "records per space clear each other's snapshot");
}
console.log("captureplan ok");
