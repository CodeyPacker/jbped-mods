import { languageOf, highlight, shebangOf } from "../mods/wingman/highlight.js";
import { spans } from "../mods/wingman/spans.js";
import { commentFor, toggleComment } from "../mods/wingman/lineops.js";
import { SAMPLES } from "./langsamples.mjs";
import assert from "node:assert/strict";

const cx = { sleep: async () => {} };

// Each sample: the file name maps to its language and the tokenizer produces the expected types.
for (const [file, lang, text, expected] of SAMPLES) {
  assert.equal(languageOf(file), lang, `language of ${file}`);
  const lines = await highlight(text, lang, cx);
  const all = lines.flatMap((l) => spans(l));
  assert.equal(lines.map((l) => spans(l).map((s) => s.text).join("")).join("\n"), text.replace(/\n$/, "\n"), `${file} text kept`);
  for (const [t, type] of expected) assert.ok(all.some((s) => s.text === t && s.type === type), `${file}: ${JSON.stringify(t)} should be ${type}; got ${JSON.stringify(all.filter((s) => s.text === t))}`);
}

// Extension and name mapping.
const map = {
  "a.sh": "bash", "a.bash": "bash", "a.zsh": "bash", ".bashrc": "bash", ".zshrc": "bash", "bashrc": "bash", ".bash_profile": "bash", "dir/.profile": "bash",
  "a.ps1": "powershell", "a.psm1": "powershell", "a.psd1": "powershell",
  "a.py": "python", "a.sql": "sql", "a.go": "go", "a.rs": "rust", "a.toml": "toml",
  "a.c": "c", "a.h": "c", "a.cpp": "cpp", "a.hpp": "cpp", "a.cc": "cpp",
  "A.java": "java", "a.lua": "lua",
  "a.ini": "ini", "a.cfg": "ini", ".editorconfig": "ini", ".gitconfig": "ini",
  "a.diff": "diff", "a.patch": "diff",
  "a.jsonc": "json", "tsconfig.json": "json", "tsconfig.app.json": "json", "tsconfig.base.json": "json", "jsconfig.json": "json", "my.code-workspace": "json",
  "a.js": "jsx", "a.md": "markdown", "Dockerfile": "docker", ".env": "properties", "notes.txt": null,
};
for (const [file, lang] of Object.entries(map)) assert.equal(languageOf(file), lang, file);

// Shebang lines name a language only for files without an extension.
assert.equal(languageOf("run", "#!/bin/sh"), "bash");
assert.equal(languageOf("run", "#!/usr/bin/env bash"), "bash");
assert.equal(languageOf("bin/deploy", "#!/usr/bin/env zsh"), "bash");
assert.equal(languageOf("tool", "#!/usr/bin/python3"), "python");
assert.equal(languageOf("tool", "#!/usr/bin/env python"), "python");
assert.equal(languageOf("tool", "#!/usr/bin/env node"), null);
assert.equal(languageOf("tool", "echo hi"), null);
assert.equal(languageOf("tool"), null);
assert.equal(languageOf("notes.txt", "#!/bin/sh"), null);
assert.equal(shebangOf("# not a shebang"), null);

// Comment markers for ctrl-/.
const marks = {
  "a.sh": "#", ".bashrc": "#", "a.ps1": "#", "a.psd1": "#", "a.py": "#", "a.sql": "--", "a.go": "//", "a.rs": "//", "a.toml": "#",
  "a.c": "//", "a.h": "//", "a.cpp": "//", "a.hpp": "//", "a.cc": "//", "A.java": "//", "a.lua": "--", "a.ini": ";", "a.cfg": "#", ".gitconfig": "#", ".editorconfig": "#",
  "a.jsonc": "//", "tsconfig.json": "//", "tsconfig.app.json": "//", "x.code-workspace": "//", "a.json": undefined,
};
for (const [file, m] of Object.entries(marks)) assert.equal(commentFor(file), m ?? null, file);
assert.equal(commentFor("run", "#!/bin/sh"), "#");
assert.equal(commentFor("run", "#!/usr/bin/env node"), null);
assert.equal(commentFor("run"), null);
assert.equal(commentFor("a.diff"), null);
assert.equal(toggleComment(["x = 1", "y"], 0, 1, commentFor("a.lua"), null, { line: 0, col: 0 }).text, "-- x = 1\n-- y");
assert.equal(toggleComment(["-- x = 1"], 0, 0, commentFor("a.sql"), null, { line: 0, col: 0 }).text, "x = 1");
