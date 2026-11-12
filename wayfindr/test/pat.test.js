import { test } from "node:test";
import assert from "node:assert/strict";
import { azure, base64 } from "../mods/wayfindr/providers/azure.js";
import { parseConfig } from "../mods/wayfindr/config.js";

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
  assert.deepEqual(runs[0], ["bash", "-lc", 'printenv "$1"', "wayfindr-env", "ADO_PAT"]); // the PAT never goes in argv
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
  // A pasted token (lower case, or too long) is refused, and the error doesn't repeat it (F2, F7).
  const pat52 = "k7x2qz4w5mabcdefghijklmnopqrstuvwxyz234567abcdefghij";
  for (const v of ["ado_pat", pat52, "PK_" + "A".repeat(40)]) {
    const e = cfg({ patEnv: v });
    assert.ok(e.some((x) => /patEnv: must be an environment variable name in upper case/.test(x)), v);
    assert.ok(!e.join("\n").includes(v));
  }
  assert.ok(cfg({ pat: "x" }).some((e) => /doesn't store secrets/.test(e)));
});

const patIo = (stdout, fetch) => ({
  profile: "work",
  run: async () => ({ code: 0, stdout, stderr: "" }),
  fetch: fetch ?? (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ value: [] }) })),
});

test("the PAT is the last non-empty line, and a value with spaces is refused without showing it", async () => {
  const account = { org: "https://dev.azure.com/o", patEnv: "ADO_PAT" }, heads = [];
  await azure.repos(account, patIo("motd line\n\nsecret\n", async (_u, o) => { heads.push(o.headers.Authorization); return { ok: true, status: 200, text: async () => "{}" }; }));
  assert.equal(heads[0], `Basic ${Buffer.from(":secret").toString("base64")}`);
  await assert.rejects(azure.repos(account, patIo("sec ret\n")), (e) => /ADO_PAT holds spaces or control characters/.test(e.message) && !/sec/.test(e.message.replace("ADO_PAT", "")));
  await assert.rejects(azure.repos(account, patIo("sec\u0007ret")), /control characters/);
  // A runtime check of the name, in case config was bypassed, doesn't show it either.
  await assert.rejects(azure.repos({ ...account, patEnv: "pk_123" }, patIo("x")), (e) => !/pk_123/.test(e.message));
});

test("a fetch that throws is reported without its text", async () => {
  const boom = async () => { throw new Error('Headers.append: "motd\nsecret" is an invalid header value.'); };
  for (const a of [{ org: "https://dev.azure.com/o", patEnv: "ADO_PAT" }, { org: "https://dev.azure.com/o" }]) {
    await assert.rejects(azure.repos(a, patIo("secret", boom)), (e) => e.message === "The request to Azure DevOps failed before it was answered");
    await assert.rejects(azure.update(a, { id: 1 }, { title: "t" }, patIo("secret", boom)), (e) => !/secret/.test(e.message));
  }
});

test("a refused PAT names the variable, and signInState checks it with connectionData (F4)", async () => {
  const account = { org: "https://dev.azure.com/o", patEnv: "ADO_PAT" }, urls = [];
  const no = async (u) => { urls.push(u); return { ok: false, status: 401, text: async () => "" }; };
  await assert.rejects(azure.repos(account, patIo("p", no)), /refused the PAT in ADO_PAT\. Make a new one and export it again\.$/);
  await assert.rejects(azure.update(account, { id: 1 }, { title: "t" }, patIo("p", no)), /refused the PAT in ADO_PAT/);
  urls.length = 0;
  const st = await azure.signInState(account, patIo("p", no));
  assert.deepEqual(st, { ok: false, reason: "Azure DevOps refused the PAT in ADO_PAT. Make a new one and export it again.", command: null });
  assert.match(urls[0], /^https:\/\/dev\.azure\.com\/o\/_apis\/connectionData\?api-version=7\.1-preview$/);
  // An az Account still gets the az login command.
  await assert.rejects(azure.repos({ org: "https://dev.azure.com/o" }, patIo("tok", no)), /refused the login \(401\)\. Run: .*az login/);
});
