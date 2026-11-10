import { test } from "node:test";
import assert from "node:assert/strict";
import { imageName, attachedImages, azure } from "../mods/wayfinder/providers/azure.js";
import { ticketImages, loadImages } from "../mods/wayfinder/flow.js";

const account = { id: "ado", provider: "azure", org: "https://dev.azure.com/o" };
const att = "https://dev.azure.com/o/p1/_apis/wit/attachments/99AAC3A3-9da9-4f67-a55c-832f7df3a88d";

test("imageName: only this organization's image attachments", () => {
  assert.equal(imageName(account, `${att}?fileName=image.PNG`), "99aac3a3-9da9-4f67-a55c-832f7df3a88d.png");
  assert.equal(imageName(account, `${att}?fileName=notes.txt`), null);
  assert.equal(imageName(account, att), null); // no name, no type
  assert.equal(imageName(account, `https://dev.azure.com/other/p1/_apis/wit/attachments/99aac3a3-9da9-4f67-a55c-832f7df3a88d?fileName=a.png`), null);
  assert.equal(imageName(account, `https://dev.azure.com/o2/_apis/wit/attachments/99aac3a3-9da9-4f67-a55c-832f7df3a88d?fileName=a.png`), null);
  assert.equal(imageName(account, "https://dev.azure.com/o/p1/_apis/wit/attachments/../../x?fileName=a.png"), null);
});

test("attachedImages keeps image files and names the type in the URL", () => {
  const rel = [
    { rel: "AttachedFile", url: att, attributes: { name: "shot 1.png" } },
    { rel: "AttachedFile", url: att, attributes: { name: "log.txt" } },
    { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/a%2Fb%2F1", attributes: {} },
  ];
  assert.deepEqual(attachedImages(rel), [{ url: `${att}?fileName=shot%201.png`, name: "shot 1.png" }]);
});

test("ticketImages: inline images from every text, then attachments, once each", () => {
  const tk = { description: `a ![x](<${att}?fileName=a.png>) b`, acceptanceCriteria: null,
    comments: [{ body: `![y](<${att}?fileName=a.png>)` }], images: [{ url: `${att}?fileName=b.png` }] };
  assert.deepEqual(ticketImages(tk), [`${att}?fileName=a.png`, `${att}?fileName=b.png`]);
});

test("loadImages downloads the provider's images into the folder and skips others", async () => {
  const runs = [];
  const io = { profile: "work", run: async (cmd, args) => { runs.push(args); return { code: 0, stdout: "", stderr: "" }; } };
  const profile = { name: "work", accounts: [account], boards: [] };
  const tk = { description: `![x](<${att}?fileName=a.png>) ![z](<https://example.test/z.png>)`, comments: [], images: [] };
  const got = [];
  await loadImages(profile, { id: "b", account: "ado" }, tk, "/home/h/data/imgs", io, (url, name, err) => got.push([url, name, err]));
  assert.deepEqual(got, [[`${att}?fileName=a.png`, "99aac3a3-9da9-4f67-a55c-832f7df3a88d.png", null]]);
  const args = runs[0];
  assert.ok(args.includes("/home/h/data/imgs/99aac3a3-9da9-4f67-a55c-832f7df3a88d.png"));
  assert.ok(args.some((a) => a.startsWith(`${att}?fileName=a.png&api-version=`)));
  assert.ok(!args.some((a) => /Bearer|accessToken/.test(a))); // az signs the request: no token in argv
  await assert.rejects(azure.downloadImage(account, "https://example.test/z.png", "/x", io));
});
