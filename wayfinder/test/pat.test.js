import { test } from "node:test";
import assert from "node:assert/strict";
import { azure, base64 } from "../mods/wayfinder/providers/azure.js";
import { parseConfig } from "../mods/wayfinder/config.js";

test("base64 matches Node's, including non-ASCII", () => {
  for (const s of [":abc", ":a", ":ab", ":pät€😀", ""]) assert.equal(base64(s), Buffer.from(s, "utf8").toString("base64"));
});

test("a PAT Account reads the variable through the runner's login shell and sends Basic auth", async () => {
  const runs = [], heads = [];
  const io = {
    profile: "work",
    run: async (cmd, args) => { runs.push([cmd, ...args]); return { code: 0, stdout: "secret\n", stderr: "" }; },
    fetch: async (_u, opts) => { heads.push(opts.headers.Authorization); return { ok: true, status: 200, text: async () => JSON.stringify({ value: [] }) }; },
  };
  const account = { org: "https://dev.azure.com/o", patEnv: "ADO_PAT" };
  await azure.repos(account, io);
  assert.deepEqual(runs[0], ["bash", "-lc", 'printenv "$1"', "wayfinder-env", "ADO_PAT"]); // the PAT never goes in argv
  assert.equal(heads[0], `Basic ${Buffer.from(":secret").toString("base64")}`);
  assert.deepEqual(await azure.signInState(account, io), { ok: true });
  const unset = { ...io, run: async () => ({ code: 1, stdout: "", stderr: "" }) };
  const st = await azure.signInState(account, unset);
  assert.equal(st.ok, false); assert.match(st.reason, /ADO_PAT isn't set/);
});

test("patEnv must be a variable name, and a PAT value is still refused", () => {
  const cfg = (a) => parseConfig(JSON.stringify({ profiles: { p: { accounts: [{ id: "a", provider: "azure", org: "https://dev.azure.com/o", ...a }] } } }), "linux").errors;
  assert.deepEqual(cfg({ patEnv: "ADO_PAT" }), []);
  assert.ok(cfg({ patEnv: "$(rm)" }).some((e) => /patEnv/.test(e)));
  assert.ok(cfg({ pat: "x" }).some((e) => /doesn't store secrets/.test(e)));
});
