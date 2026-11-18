// One small sample per language Wingman colours beyond the web ones: file name, text, and
// [text, type] pairs the tokenizer must produce. Shared by langs.test.mjs and the tooling that
// writes sample files for the on-screen check.
export const SAMPLES = [
  ["deploy.sh", "bash", `#!/usr/bin/env bash
# deploy
set -e
NAME="\${1:-app}"
if [ -f "$NAME" ]; then echo "found $NAME"; fi
`, [["# deploy", "comment"], ["if", "keyword"], ["echo", "builtin"], ['"found ', "string"], ["$NAME", "variable"]]],
  ["list.ps1", "powershell", `# list
param([string]$Path = ".")
function Get-Big {
  Get-ChildItem -Path $Path | ForEach-Object { Write-Host "Big: $_" }
}
if ($Path) { Get-Big }
`, [["# list", "comment"], ["function", "keyword"], ["if", "keyword"], ['"."', "string"]]],
  ["app.py", "python", `import os
@dataclass
class Point:
    # note
    def dist(self, other):
        """Doc."""
        return f"{self.x}" if True else None
`, [["import", "keyword"], ["class", "keyword"], ["# note", "comment"], ["def", "keyword"], ["True", "boolean"]]],
  ["q.sql", "sql", `-- users
SELECT u.id, COUNT(*) AS n
FROM users u WHERE u.name = 'x' LIMIT 10;
`, [["-- users", "comment"], ["SELECT", "keyword"], ["'x'", "string"], ["10", "number"]]],
  ["main.go", "go", `package main
// Server runs.
func (s *Server) Start() error {
	ch := make(chan int)
	return nil
}
`, [["package", "keyword"], ["// Server runs.", "comment"], ["func", "keyword"], ["chan", "keyword"]]],
  ["lib.rs", "rust", `// crate
use std::collections::HashMap;
#[derive(Debug)]
pub struct Thing<'a> { name: &'a str }
fn main() { let n = 0x1F; println!("{}", n); }
`, [["// crate", "comment"], ["use", "keyword"], ["struct", "keyword"], ["0x1F", "number"], ['"{}"', "string"]]],
  ["Cargo.toml", "toml", `# config
title = "TOML"
[owner]
enabled = true
n = 8000
`, [["# config", "comment"], ["title", "key"], ['"TOML"', "string"], ["owner", "table"], ["true", "boolean"], ["8000", "number"]]],
  ["util.c", "c", `#include <stdio.h>
/* sum */
static int sum(const int *a) { return 0; } // end
`, [["#", "directive-hash"], ["include", "directive"], ["/* sum */", "comment"], ["static", "keyword"], ["int", "keyword"]]],
  ["box.hpp", "cpp", `template <typename T>
class Box { public: auto get() const -> const T&; };
int main() { return nullptr == 0 ? 1 : 2; }
`, [["template", "keyword"], ["class", "keyword"], ["nullptr", "keyword"]]],
  ["Sample.java", "java", `package com.example;
/** Doc. */
@SuppressWarnings("unused")
public class Sample { int x = 42; }
`, [["package", "keyword"], ["/** Doc. */", "comment"], ["@SuppressWarnings", "annotation"], ["public", "keyword"], ["42", "number"]]],
  ["init.lua", "lua", `-- lua
local M = {}
function M.add(a, b) return a + b end
--[[ block ]]
`, [["-- lua", "comment"], ["local", "keyword"], ["function", "keyword"], ["--[[ block ]]", "comment"]]],
  ["app.ini", "ini", `; comment
[section]
key = value
`, [["; comment", "comment"], ["section", "section-name"], ["key", "key"]]],
  ["fix.patch", "diff", `diff --git a/x b/x
--- a/x
+++ b/x
@@ -1,2 +1,2 @@
-old
+new
`, [["old", "deleted-sign"], ["new", "inserted-sign"], ["@@ -1,2 +1,2 @@", "coord"]]],
  ["tsconfig.json", "json", `{
  // options
  "strict": true, /* x */
}
`, [["// options", "comment"], ['"strict"', "property"], ["true", "boolean"]]],
];
