// Every named import between the mod's own modules names something the module exports. A merge
// once left gitview.js importing `plan` from inlineedit.js after it had moved to toolpath.js: the
// Node tests never load gitview.js (it needs Herdr), and the app refused the whole mod.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../mods/wingman/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
const src = new Map(files.map((f) => [f, readFileSync(new URL(f, dir), "utf8")]));

/** The names a module exports (declarations and export lists). */
function exportsOf(text) {
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  // export const A = 1, B = 2; (each name before an "=" that follows the keyword or a comma, on that line)
  for (const m of text.matchAll(/^export\s+(?:const|let|var)\s+(.*)$/gm)) for (const n of m[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g)) names.add(n[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(",")) { const p = part.trim().split(/\s+as\s+/); if (p[0]) names.add((p[1] ?? p[0]).trim()); }
  if (/^export\s+default\b/m.test(text)) names.add("default");
  return names;
}

const problems = [];
for (const [file, text] of src) {
  for (const m of text.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)"/gm)) {
    const target = m[2];
    assert.ok(src.has(target), `${file} imports ./${target}, which doesn't exist`);
    const have = exportsOf(src.get(target));
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !have.has(name)) problems.push(`${file}: { ${name} } from "./${target}" is not exported there`);
    }
  }
}
assert.deepEqual(problems, []);

// The check itself finds a missing name.
assert.ok(!exportsOf("export function a() {}\nexport const b = 1;").has("plan"));
assert.ok(exportsOf("export const x = 1, y = 2;\nexport { z as w };").has("w"));
console.log(`imports: ${files.length} modules checked`);
