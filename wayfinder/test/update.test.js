import { test } from "node:test";
import assert from "node:assert/strict";
import { azure } from "../mods/wayfinder/providers/azure.js";
import { github } from "../mods/wayfinder/providers/github.js";

const recorder = (answer = "{}") => {
  const sent = [];
  return {
    sent,
    io: {
      profile: "work",
      run: async () => ({ code: 0, stdout: "tok\n", stderr: "" }),
      fetch: async (url, opts) => { sent.push({ url, ...opts, json: JSON.parse(opts.body ?? "null") }); return { ok: true, status: 200, text: async () => answer }; },
    },
  };
};

test("Azure: a title edit is one patch, a comment posts markdown to the comments API", async () => {
  const a = { org: "https://dev.azure.com/o" }, ref = { id: 5, project: "My P" };
  let r = recorder();
  await azure.update(a, ref, { title: "  New title " }, r.io);
  assert.equal(r.sent[0].method, "PATCH");
  assert.deepEqual(r.sent[0].json, [{ op: "add", path: "/fields/System.Title", value: "New title" }]);
  await assert.rejects(azure.update(a, ref, { title: " " }, r.io), /can't be empty/);
  r = recorder();
  await azure.comment(a, ref, "**done**", r.io);
  assert.equal(r.sent[0].method, "POST");
  assert.match(r.sent[0].url, /\/My%20P\/_apis\/wit\/workItems\/5\/comments\?format=markdown&api-version=7\.1-preview\.4$/);
  assert.deepEqual(r.sent[0].json, { text: "**done**" });
});

test("GitHub: titles by content type, comments on issues and PRs only", async () => {
  let r = recorder(JSON.stringify({ data: {} }));
  await github.update({ login: "me" }, { kind: "PullRequest", contentId: "PR1" }, { title: "T" }, r.io);
  assert.match(r.sent[0].json.query, /updatePullRequest/);
  assert.deepEqual(r.sent[0].json.variables, { id: "PR1", title: "T" });
  await github.comment({ login: "me" }, { kind: "Issue", contentId: "I1" }, "hi", r.io);
  assert.match(r.sent[1].json.query, /addComment/);
  assert.deepEqual(r.sent[1].json.variables, { id: "I1", body: "hi" });
  await assert.rejects(github.comment({ login: "me" }, { kind: "DraftIssue", contentId: "D" }, "hi", r.io), /Draft issues/);
});
