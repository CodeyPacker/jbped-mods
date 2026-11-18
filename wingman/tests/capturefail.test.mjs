// capturefail: a failing repo's capture is isolated, retried on a slower schedule, and shown as a notice.
import { retryMs, passDue, tryPass, captureErrors, captureNotices, RETRY_MAX, ERRORS_STALE } from "../mods/wingman/captureplan.js";
import assert from "node:assert/strict";

// ---- retryMs / passDue --------------------------------------------------------------------------
{
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(retryMs), [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000]);
  assert.equal(retryMs(1000), RETRY_MAX, "no overflow past the cap");
  assert.equal(passDue(null, 0), true, "a healthy repo is always due");
  const fail = { at: 10000, count: 3 }; // next try 12 s after the last
  assert.equal(passDue(fail, 10000 + 6000), false);
  assert.equal(passDue(fail, 10000 + 11000), true, "a tick up to a second early still counts");
  assert.equal(passDue(fail, 10000 + 12000), true);
  assert.equal(passDue(fail, 10000 + 1, true), true, "a turn start always tries");
}

// ---- tryPass with a fake Capture ---------------------------------------------------------------
/** A fake Capture whose snapshot throws `fails` times, then succeeds. Counts snapshots. */
function fakeCapture(root, fails = 0) {
  const disk = { tree: "a".repeat(40) }; // a saved snapshot: every pass snapshots and adopts
  const f = {
    store: { root, on: null, branch: async () => "main" }, snaps: 0,
    state: async () => ({ ...disk }),
    setState: async (next) => { Object.assign(disk, next); },
    snapshot: async () => {
      f.snaps++;
      if (fails-- > 0) throw new Error(`snapshot failed: warning: noise\nfatal: index.lock exists in ${root}`);
      return "b".repeat(40);
    },
    adopt: async () => 0,
  };
  return f;
}
const record = (capture, spaces) => ({ capture, spaces, active: true, after: false, by: null, space: null, fresh: false });

{
  let now = 0;
  const clock = () => now, lines = [], log = (l) => lines.push(l);
  const good = record(fakeCapture("/r/good"), ["s1"]), bad = record(fakeCapture("/r/bad", 5), ["s1", "s2"]);
  const records = new Map([["good", good], ["bad", bad]]);
  const tries = []; // times bad's snapshot was tried
  // 3 s ticks, as collectAll: both records' passes, the failing one never stopping the other.
  for (let tick = 0; tick <= 60; tick++) {
    now = tick * 3000;
    const before = bad.capture.snaps;
    await Promise.all([...records.values()].map((c) => tryPass(c, false, log, clock)));
    if (bad.capture.snaps > before) tries.push(now / 1000);
    if (tick === 4) {
      // While failing: the error is on the record and shared, capped and counted.
      assert.equal(bad.fail.count, 3);
      assert.equal(bad.fail.since, 0);
      assert.ok(bad.fail.message.endsWith("index.lock exists in /r/bad") && bad.fail.message.split("\n").length <= 3);
      const errs = captureErrors(records);
      assert.deepEqual(Object.keys(errs), ["bad"]);
      assert.deepEqual({ ...errs.bad, message: undefined }, { root: "/r/bad", on: null, spaces: ["s1", "s2"], message: undefined, since: 0, count: 3 });
    }
  }
  assert.equal(good.capture.snaps, 61, "the healthy repo passed every tick");
  assert.equal(good.fail, undefined);
  // Failures at 0, 3, 9, 21, 45 (gaps 3, 6, 12, 24), then the success at 93 (gap 48), then every tick.
  assert.deepEqual(tries.slice(0, 7), [0, 3, 9, 21, 45, 93, 96]);
  assert.equal(bad.fail, null, "cleared on the first pass that succeeds");
  assert.deepEqual(captureErrors(records), {});
  assert.deepEqual(lines.filter((l) => l.includes("/r/bad")), [
    "/r/bad: capture failing: snapshot failed: warning: noise\nfatal: index.lock exists in /r/bad",
    "/r/bad: capture recovered after 5 failed passes",
  ], "logged once when it starts failing and once when it recovers");
}
{
  // A turn start retries at once, even inside the backoff; the error clears when it succeeds.
  let now = 0;
  const clock = () => now;
  const c = record(fakeCapture("/r/x", 3), ["s1"]);
  c.capture.state = async () => ({ tree: null }); // no snapshot yet: a pass takes one while active
  for (const t of [0, 3000, 9000]) { now = t; await tryPass(c, false, () => {}, clock); }
  assert.equal(c.fail.count, 3);
  now = 10000;
  assert.equal(await tryPass(c, false, () => {}, clock), "skipped", "inside the backoff");
  assert.equal(await tryPass(c, true, () => {}, clock), "ok", "a turn start tries now");
  assert.equal(c.fail, null);
  assert.equal(c.capture.snaps, 4);
}
{
  // A failure before snapshot (state read) is kept the same way; a message-less throw still has text.
  const c = record(fakeCapture("/r/y"), ["s1"]);
  c.capture.state = async () => { throw "boom"; };
  assert.equal(await tryPass(c, false, () => {}, () => 5), "failed");
  assert.deepEqual(c.fail, { message: "boom", since: 5, at: 5, count: 1 });
  c.capture.state = async () => { throw new Error(""); };
  await tryPass(c, true, () => {}, () => 6);
  assert.equal(c.fail.message, "unknown error");
  assert.equal(c.fail.count, 2);
}

// ---- captureNotices: space -> repos -> errors ------------------------------------------------------
{
  const now = 100000;
  const value = { by: "lead", at: now - 1000, repos: {
    "C:/dev/sonja-client": { root: "C:/dev/sonja-client", on: null, spaces: ["s1"], message: "snapshot failed: warning: x\nfatal: bad index", since: 1, count: 4 },
    "wsl\u0000/home/u/api": { root: "/home/u/api", on: "wsl", spaces: ["s2"], message: "timed out", since: 1, count: 1 },
  } };
  assert.deepEqual(captureNotices(value, "s1", [], now), [{ key: "C:/dev/sonja-client", text: "sonja-client: capture failing \u2014 fatal: bad index (retrying)" }],
    "only the shown space's repos, last line of the error");
  assert.deepEqual(captureNotices(value, "s2", [], now).map((n) => n.text), ["api on wsl: capture failing \u2014 timed out (retrying)"]);
  assert.deepEqual(captureNotices(value, "s3", [], now), [], "another space: nothing");
  assert.deepEqual(captureNotices(value, "s3", ["C:/dev/sonja-client"], now).map((n) => n.key), ["C:/dev/sonja-client"], "a repo the copy shows counts too");
  assert.deepEqual(captureNotices(value, "s1", [], now - 1000 + ERRORS_STALE + 1), [], "a stale value (leader gone) shows nothing");
  assert.deepEqual(captureNotices(undefined, "s1", [], now), []);
  assert.deepEqual(captureNotices({ by: "lead", at: now, repos: {} }, "s1", [], now), []);
}
console.log("capturefail ok");
