import { tailText } from "../mods/wingman/capture.js";
import assert from "node:assert/strict";

assert.equal(tailText("fatal: boom\n"), "fatal: boom");
assert.equal(tailText(""), "");
assert.equal(tailText(undefined), "");
const noisy = Array.from({ length: 500 }, (_, i) => `warning: in the working copy of 'f${i}', LF will be replaced by CRLF`).join("\r\n");
assert.equal(tailText(noisy).split("\n").length, 3);
assert.ok(tailText(noisy).endsWith("'f499', LF will be replaced by CRLF"));
assert.ok(tailText(noisy).length <= 300);
assert.ok(tailText("x".repeat(5000)).length <= 301);
console.log("tailtext ok");
