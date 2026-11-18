import { editorArgv, fillTemplate } from "../mods/wingman/nvim.js";
import assert from "node:assert/strict";
assert.deepEqual(editorArgv("code", "C:\\x\\a b.js", 3, 1), ["code", "-g", "C:/x/a b.js:3:1"]);
assert.deepEqual(editorArgv("cursor", "//wsl.localhost/Ubuntu/home/a.js", 2, 5), ["cursor", "--remote", "wsl+Ubuntu", "-g", "/home/a.js:2:5"]);
assert.deepEqual(editorArgv("zed", "/r/a.js", 1, 1), ["zed", "/r/a.js:1:1"]);
assert.deepEqual(editorArgv("custom", "/r/a b.js", 4, 2, 'idea --line {line} --column {col} "{path}"'), ["idea", "--line", "4", "--column", "2", "/r/a b.js"]);
assert.deepEqual(fillTemplate("nvim +{line} {path}", "/a b", 9, 1), ["nvim", "+9", "/a b"]);
assert.throws(() => editorArgv("custom", "/a", 1, 1, "  "));
console.log("editor tests pass");
