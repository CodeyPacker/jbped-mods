import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform, splitFrontmatter, parseLink, linkUrl, linkTargets, splitTarget, headingKey } from "../mods/vaultr/md.js";

const md = (text) => transform(text).map((s) => s.text ?? `<${s.target}>`).join("\n");

test("frontmatter is split from the body", () => {
  assert.deepEqual(splitFrontmatter("---\ntags: [a]\n---\n# T\n"), { front: "tags: [a]", body: "# T\n" });
  assert.deepEqual(splitFrontmatter("# T\n---\nx"), { front: null, body: "# T\n---\nx" });
});

test("wikilinks become links the mod can catch", () => {
  assert.equal(md("See [[Atlas Overview]]."), `See [Atlas Overview](${linkUrl("Atlas Overview")}).`);
  assert.equal(md("[[Note#Risks|the risks]]"), `[the risks](${linkUrl("Note#Risks")})`);
  assert.equal(md("[[Note#Risks]]"), `[Note > Risks](${linkUrl("Note#Risks")})`);
  assert.equal(md("| [[Decisions\\|log]] |"), `| [log](${linkUrl("Decisions")}) |`);
  assert.equal(parseLink(linkUrl("A B#c/d")), "A B#c/d");
  assert.equal(parseLink("https://herdr.dev"), null);
});

test("a markdown link to a vault file opens in the mod, a web link is left alone", () => {
  assert.equal(md("[plan](Projects/Plan%20A.md)"), `[plan](${linkUrl("Projects/Plan A.md")})`);
  assert.equal(md("[site](https://herdr.dev)"), "[site](https://herdr.dev)");
});

test("code is left alone", () => {
  assert.equal(md("`[[x]]` and [[y]]"), `\`[[x]]\` and [y](${linkUrl("y")})`);
  assert.equal(md("```\n[[x]]\n# not a heading\n```"), "```\n[[x]]\n# not a heading\n```");
});

test("callouts, highlights and comments", () => {
  assert.equal(md("> [!warning]- Read-only\n> body"), "> **Warning: Read-only**\n> body");
  assert.equal(md("> [!note]"), "> **Note**");
  assert.equal(md("==hi== %%gone%%there"), "**hi** there");
});

test("images are split out, note embeds become links", () => {
  assert.deepEqual(transform("a ![[d.png|300]] b"), [{ type: "md", text: "a " }, { type: "image", target: "d.png" }, { type: "md", text: " b" }]);
  assert.deepEqual(transform("![alt](Attachments/site%20map.png)"), [{ type: "image", target: "Attachments/site map.png" }]);
  assert.equal(md("![alt](https://x.test/a.png)"), "![alt](https://x.test/a.png)");
  assert.equal(md("![[Decisions]]"), `[↪ Decisions](${linkUrl("Decisions")})`);
});

test("a heading starts a segment and carries its key", () => {
  const segs = transform("intro\n\n## Risks **now**\n\ntext\n\n# Next\n");
  assert.deepEqual(segs.map((s) => s.heading ?? null), [null, "risks now", "next"]);
  assert.equal(headingKey(" Risks  **now** "), "risks now");
  assert.deepEqual(splitTarget("Note#Risks"), { note: "Note", heading: "Risks" });
  assert.deepEqual(splitTarget("#Risks"), { note: "", heading: "Risks" });
  assert.deepEqual(splitTarget("Note"), { note: "Note", heading: null });
});

test("link targets for the backlink index", () => {
  assert.deepEqual(linkTargets("[[A]] ![[b.png]] [c](C.md) [w](https://x.test) [h](#top) ![i](i.png)"), ["A", "b.png", "C.md"]);
});

test("the fixture's home note transforms without losing a link", () => {
  const { front, body } = splitFrontmatter(readFileSync(new URL("./fixture/Home.md", import.meta.url), "utf8"));
  assert.match(front, /tags:/);
  const segs = transform(body);
  assert.equal(segs.filter((s) => s.type === "image").length, 2);
  assert.ok(!segs.some((s) => s.type === "md" && /(?<!`|")\[\[(?!not a link|also not)/.test(s.text)));
});
