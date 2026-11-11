import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown as md } from "../mods/wayfinder/providers/html.js";

test("empty and plain", () => {
  assert.equal(md(null), "");
  assert.equal(md(""), "");
  assert.equal(md("plain &amp; simple&nbsp;text"), "plain & simple text");
});

test("Azure's div-per-line text keeps its lines as paragraphs, with bold fixed up", () => {
  const ac = '<div style="box-sizing:border-box;"> </div><div><b>GIVEN<span>&nbsp;</span></b>a user imports</div><div><br></div><div><b>THEN </b>it works</div>';
  assert.equal(md(ac), "**GIVEN** a user imports\n\n**THEN** it works");
});

test("lists, nested and ordered", () => {
  assert.equal(md("<div><ul><li>Log in </li><li>Log out<ul><li>note it</li></ul></li></ul></div>"), "- Log in\n- Log out\n  - note it");
  assert.equal(md("<ol><li>one</li><li>two</li></ol>"), "1. one\n2. two");
});

test("headings, links, images, code", () => {
  assert.equal(md('<h2>Steps</h2><p>See <a href="https://x.test/a b">the doc</a>.</p>'), "## Steps\n\nSee [the doc](<https://x.test/a%20b>).");
  assert.equal(md('<img src="https://dev.azure.com/o/_apis/wit/attachments/1" alt="shot">'), "![shot](<https://dev.azure.com/o/_apis/wit/attachments/1>)");
  assert.equal(md("<p>run <code>npm test</code></p><pre>a  b\n  c</pre>"), "run `npm test`\n\n```\na  b\n  c\n```");
});

test("mentions become text and unsafe links are dropped", () => {
  assert.equal(md('<div><a href="#" data-vss-mention="version:2.0,abc">@Kat K</a>&nbsp;only app</div>'), "@Kat K only app");
  assert.equal(md('<a href="javascript:alert(1)">click</a>'), "click");
});

test("text can't turn into markdown or HTML", () => {
  assert.equal(md("<p>a *b* _c_ [d](e) &lt;script&gt; # h</p>"), "a \\*b\\* \\_c\\_ \\[d\\](e) \\<script\\> \\# h");
  assert.equal(md("<b>x&#1;y</b>"), "**xy**");
  assert.equal(md("<script>alert(1)</script><style>p{}</style>ok"), "ok");
});

test("a ! in text never turns a link into an image", () => {
  assert.equal(md('Wow!<a href="https://x.test">x</a>'), "Wow\\![x](<https://x.test>)");
});

test("a URL can't close its <url> destination and start another link (security F2)", () => {
  const a = md('<a href="https://a/&gt;&lt;file:///C:/x.exe">t</a>');
  assert.equal(a, "[t](<https://a/%3E%3Cfile:///C:/x.exe>)");
  const i = md('<img src="https://a/&gt;&lt;javascript:alert%281%29&gt;">');
  assert.equal(i, "![image](<https://a/%3E%3Cjavascript:alert%281%29%3E>)");
  assert.equal(md('<a href="https://a/b&quot;c\\d&#1;e">t</a>'), "[t](<https://a/b%22c%5Cd%01e>)");
});

test("safeMarkdown keeps only http, https, mailto and relative destinations (security F3)", async () => {
  const { safeMarkdown: sm } = await import("../mods/wayfinder/providers/contract.js");
  assert.equal(sm("[a](file:///C:/x.exe) [b](https://x) <javascript:1> ![i](<javascript:alert(1)>)"), "a [b](https://x) javascript:1 i");
  assert.equal(sm("[docs](ms-msdt:/id x) [m](mailto:a@b.c) [r](docs/a.md?x=1&y=2#h)"), "\\[docs](ms-msdt:/id x) [m](mailto:a@b.c) [r](docs/a.md?x=1&y=2#h)");
  assert.equal(sm('[x](javascript:a((1)) "t") [y]( <vbscript:1> )'), "x y");
  assert.equal(sm("[![img](https://a)](file:///x)"), "![img](https://a)");
  assert.equal(sm("[e](java&#115;cript:1) [b](javascript\\:1) [p](//evil/x) [s](/\\/evil)"), "e b p s");
  assert.equal(sm("[r]: file:///x\n\n[go][r]"), "[r]:\n\n[go][r]");
  assert.equal(sm("[ok]: https://x\n<https://y> <a@b.c>"), "[ok]: https://x\n<https://y> <a@b.c>");
  assert.equal(sm("\\[not a link](javascript:1)"), "\\[not a link](javascript:1)");
  assert.equal(sm(null), "");
});
