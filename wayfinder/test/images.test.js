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
  // Dot segments that would leave the org, plain or encoded (security F5).
  const g = "99aac3a3-9da9-4f67-a55c-832f7df3a88d";
  assert.equal(imageName(account, `https://dev.azure.com/o/../other/_apis/wit/attachments/${g}?fileName=a.png`), null);
  assert.equal(imageName(account, `https://dev.azure.com/o/%2e%2e/other/_apis/wit/attachments/${g}?fileName=a.png`), null);
  assert.equal(imageName(account, `https://dev.azure.com/o/%2E%2E/other/_apis/wit/attachments/${g}?fileName=a.png`), null);
  assert.equal(imageName(account, `https://dev.azure.com/o/./p/_apis/wit/attachments/${g}?fileName=a.png`), null);
  assert.equal(imageName(account, `https://dev.azure.com/o\\..\\other/_apis/wit/attachments/${g}?fileName=a.png`), null);
  // A PAT Account has no az to sign the download, so its images stay links.
  assert.equal(imageName({ ...account, patEnv: "ADO_PAT" }, `${att}?fileName=a.png`), null);
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

test("loadImages skips a PAT Account's images, so they render as links", async () => {
  const runs = [], got = [];
  const io = { profile: "work", run: async (cmd, args) => { runs.push(args); return { code: 0, stdout: "", stderr: "" }; } };
  const pat = { ...account, patEnv: "ADO_PAT" };
  const tk = { description: `![x](<${att}?fileName=a.png>)`, comments: [], images: [] };
  await loadImages({ name: "work", accounts: [pat], boards: [] }, { id: "b", account: "ado" }, tk, "/d", io, (...a) => got.push(a));
  assert.deepEqual([runs, got], [[], []]);
});

test("pruneImages deletes only old image files in that folder", async () => {
  const { mkdtempSync, writeFileSync, utimesSync, existsSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { pruneImages } = await import("../mods/wayfinder/flow.js");
  const d = mkdtempSync(join(tmpdir(), "wf-img-"));
  const old = Date.now() / 1000 - 40 * 86400;
  for (const f of ["old.png", "new.png", "old.txt"]) writeFileSync(join(d, f), "x");
  mkdirSync(join(d, "sub")); writeFileSync(join(d, "sub/old.png"), "x");
  for (const f of ["old.png", "old.txt", "sub/old.png"]) utimesSync(join(d, f), old, old);
  const io = { run: async (c, a) => { const p = spawnSync(c, a, { encoding: "utf8" }); return { code: p.status, stdout: p.stdout, stderr: p.stderr }; } };
  await pruneImages(d, io, 30);
  assert.deepEqual(["old.png", "new.png", "old.txt", "sub/old.png"].map((f) => existsSync(join(d, f))), [false, true, true, true]);
  await pruneImages(join(d, "missing"), io, 30); // no folder yet: nothing to do
});
