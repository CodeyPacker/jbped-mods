import { spaceRoots, addFolder, removeFolder, findWorkspace, parseJsonc } from "../mods/wingman/workspace.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
const home = process.env.WINGMAN_TEST_HOME, data = `${home}/data/wingman`;
mkdirSync(data, { recursive: true });
const saved = ["spaces.json", "hidden.json"].map((n) => [n, existsSync(`${data}/${n}`) ? readFileSync(`${data}/${n}`, "utf8") : null]);
const dir = mkdtempSync(`${tmpdir()}/wsio-`), g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
const repo = (p) => { mkdirSync(p, { recursive: true }); g(p, "init", "-q"); };
try {
  writeFileSync(`${data}/spaces.json`, JSON.stringify({ s1: [`${dir}/other`] }));
  rmSync(`${data}/hidden.json`, { force: true });
  // A Ticket folder Wayfinder made: two repos and its workspace file (with a comment and settings).
  repo(`${dir}/t1/api`); repo(`${dir}/t1/web`); repo(`${dir}/other`); repo(`${dir}/lib`);
  const file = `${dir}/t1/t1.code-workspace`;
  writeFileSync(file, '{\n\t// Ticket 1\n\t"folders": [\n\t\t{ "path": "api" },\n\t\t{ "path": "web", "name": "Web app" }\n\t],\n\t"settings": { "a": 1 }\n}\n');
  const sp = { id: "s1", folder: `${dir}/t1` };
  let r = await spaceRoots(sp, [`${dir}/t1/api`]);
  assert.deepEqual(r.roots, [`${dir}/t1/api`, `${dir}/t1/web`, `${dir}/other`]);
  assert.equal(r.names.get(`${dir}/t1/web`), "Web app");
  // Adding writes the file's folders only, relative when inside the Ticket folder.
  await addFolder(sp, `${dir}/lib`, r.roots);
  let text = readFileSync(file, "utf8");
  assert.ok(text.includes("// Ticket 1") && text.includes(`{ "path": "${dir}/lib" }`) && text.includes('"settings": { "a": 1 }'));
  // Removing a file folder edits the file; removing an agent-found repo hides it.
  await removeFolder(sp, `${dir}/t1/web`); await removeFolder(sp, `${dir}/other`);
  assert.deepEqual(parseJsonc(readFileSync(file, "utf8")).folders.map((f) => f.path), ["api", `${dir}/lib`]);
  r = await spaceRoots(sp, [`${dir}/t1/api`]);
  assert.deepEqual(r.roots, [`${dir}/t1/api`, `${dir}/lib`]);
  // Adding back un-hides.
  await addFolder(sp, `${dir}/other`, r.roots);
  assert.ok((await spaceRoots(sp)).roots.includes(`${dir}/other`));

  // A space whose folder is a repo: its workspace goes to Wingman's data, made only at two repos.
  const s2 = { id: "s2:x", folder: `${dir}/lib` };
  await addFolder(s2, `${dir}/lib`, []);
  assert.equal(await findWorkspace(s2), null);
  await addFolder(s2, `${dir}/other`, [`${dir}/lib`]);
  const ws2 = await findWorkspace(s2);
  assert.equal(ws2.file, `${data}/workspaces/s2_x.code-workspace`);
  assert.deepEqual(parseJsonc(ws2.text).folders.map((f) => f.path), [`${dir}/lib`, `${dir}/other`]);
  assert.ok(!existsSync(`${dir}/lib/lib.code-workspace`));
  // A plain parent folder: the file goes there, named after it.
  mkdirSync(`${dir}/plain`);
  const s3 = { id: "s3", folder: `${dir}/plain` };
  await addFolder(s3, `${dir}/other`, [`${dir}/lib`]);
  assert.deepEqual(parseJsonc(readFileSync(`${dir}/plain/plain.code-workspace`, "utf8")).folders.map((f) => f.path), [`${dir}/lib`, `${dir}/other`]);
  rmSync(`${data}/workspaces`, { recursive: true, force: true });
} finally {
  rmSync(dir, { recursive: true, force: true });
  for (const [n, t] of saved) t == null ? rmSync(`${data}/${n}`, { force: true }) : writeFileSync(`${data}/${n}`, t);
}
console.log("workspace io tests pass");
