import { packSpans, spans } from "../mods/wingman/spans.js";
import { highlight, highlightLines } from "../mods/wingman/highlight.js";
import { tokenSkip } from "../mods/wingman/brackets.js";
import assert from "node:assert/strict";

// Round trip, including no spans, a null type, long texts and wide characters.
const cases = [
  [],
  [{ text: "x", type: null }],
  [{ text: "const", type: "keyword" }, { text: " ", type: null }, { text: '"中文 😀"', type: "string" }],
  [{ text: "a".repeat(70000), type: "comment" }, { text: "b", type: "punctuation" }],
  Array.from({ length: 300 }, (_, i) => ({ text: String(i % 10), type: i % 2 ? "number" : null })),
];
for (const c of cases) assert.deepEqual(spans(packSpans(c)), c);
assert.equal(packSpans([]), "");
assert.deepEqual(spans(undefined), []);
assert.deepEqual(spans([{ text: "as is", type: null }]), [{ text: "as is", type: null }]); // arrays pass through

// The highlighter's lines are packed, and unpack to the line's text.
const code = 'const a = "(";\n\n// (x\nlet b = f(a);\n';
const cx = { sleep: async () => {} };
const lines = await highlight(code, "javascript", cx);
assert.equal(lines.length, 5);
assert.ok(lines.every((l) => typeof l === "string"));
code.split("\n").forEach((l, i) => assert.equal(spans(lines[i]).map((s) => s.text).join(""), l));
assert.ok(spans(lines[0]).some((s) => s.type === "keyword" && s.text === "const"));
assert.deepEqual(spans((await highlight("plain\n", null, cx))[0]), [{ text: "plain", type: null }]);
assert.deepEqual(highlightLines(["let x", ""], "javascript").map((l) => spans(l).map((s) => s.text).join("")), ["let x", ""]);

// Bracket matching reads packed lines too: the "(" in the string and the comment are skipped.
const skip = tokenSkip(lines, code.split("\n"));
assert.equal(skip(0, 11), true);
assert.equal(skip(2, 3), true);
assert.equal(skip(3, 9), false);
