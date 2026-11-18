// Prism highlighting as per-line spans, tokenized in chunks so Herdr's script
// runtime never runs long enough to interrupt it.
import Prism from "./grammars.js"; // core + JS (prism.js) plus markup, C#, JSON, Markdown, CSS, TS, JSX, TSX
import { packSpans } from "./spans.js";

const LANGS = {
  // .js goes through JSX too: React projects often keep JSX in .js files.
  js: "jsx", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", // .d.ts ends in .ts
  html: "html", htm: "html", xhtml: "html", // Angular templates are .html
  vue: "vue",
  css: "css", scss: "scss",
  yml: "yaml", yaml: "yaml", // docker-compose.yml, compose.yaml and other YAML
  cs: "csharp", csx: "csharp",
  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell", psd1: "powershell",
  py: "python", sql: "sql", go: "go", rs: "rust", toml: "toml",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp", hxx: "cpp", java: "java", lua: "lua",
  ini: "ini", cfg: "ini", editorconfig: "ini", gitconfig: "ini", diff: "diff", patch: "diff",
  "code-workspace": "json",
};

// Files known by name rather than extension.
const NAMES = [
  [/^(dockerfile|containerfile)(\..+)?$|\.dockerfile$/, "docker"],
  [/^\.env(\..+)?$|\.env$/, "properties"], // KEY=value lines and # comments
  [/^\.?(bashrc|bash_profile|bash_aliases|bash_logout|zshrc|zprofile|zshenv|zlogin|zlogout|profile)$/, "bash"],
  [/^(tsconfig|jsconfig)[^/]*\.json$/, "json"], // comments and trailing commas are fine for the JSON grammar
];

// Files without a known name or extension: a "#!" first line names the language.
const SHEBANGS = [[/^#!.*\b(?:ba|z|k|da|a)?sh\b/, "bash"], [/^#!.*\bpython[\d.]*\b/, "python"]];
export const shebangOf = (first) => (typeof first === "string" && first.startsWith("#!") && SHEBANGS.find(([re]) => re.test(first))?.[1]) || null;

/** The language of a file by name, else (extension-less files only) by a "#!" first line passed as `first`. */
export const languageOf = (path, first) => {
  const name = path.split("/").pop().toLowerCase();
  const byName = NAMES.find(([re]) => re.test(name))?.[1] ?? (name.includes(".") ? LANGS[name.split(".").pop()] : null);
  return byName ?? (name.includes(".") ? null : shebangOf(first));
};

// Prism token tree -> one array of {text, type} spans per line (packed by the callers: spans.js).
function tokenLines(code, grammar) {
  const lines = [[]];
  const walk = (tokens, type) => {
    for (const t of tokens) {
      if (typeof t === "string") {
        t.split("\n").forEach((part, i) => {
          if (i > 0) lines.push([]);
          if (part) lines[lines.length - 1].push({ text: part, type });
        });
      // A token's "content" part (Markdown bold, italic, links) takes its parent's color, and so do
      // a diff line's "prefix" and "line" parts (inside a deleted-sign, inserted-sign, ... token).
      } else walk(Array.isArray(t.content) ? t.content : [t.content], t.type === "content" || ((t.type === "prefix" || t.type === "line") && type) ? type : t.type);
    }
  };
  walk(Prism.tokenize(code, grammar), null);
  return lines;
}

/** Per-line spans for `lines` (packed), tokenized in chunks cut at blank lines (multi-line tokens stay whole). */
async function chunked(lines, grammar, cx) {
  if (!grammar) return lines.map((l) => packSpans(l ? [{ text: l, type: null }] : []));
  const out = [];
  for (let i = 0; i < lines.length;) {
    let end = Math.min(lines.length, i + 150);
    while (end < lines.length && end < i + 300 && lines[end - 1] !== "") end++;
    for (const l of tokenLines(lines.slice(i, end).join("\n"), grammar)) out.push(packSpans(l));
    i = end;
    await cx.sleep(0);
  }
  return out;
}

/** The grammar for a <script> or <style> block, from its tag and `lang` attribute. */
function blockGrammar(tag, attrs) {
  const lang = /\blang\s*=\s*["']?([\w-]+)/i.exec(attrs)?.[1]?.toLowerCase();
  if (tag.toLowerCase() === "style") return Prism.languages[lang === "scss" ? "scss" : "css"];
  return Prism.languages[{ ts: "typescript", typescript: "typescript", tsx: "tsx", jsx: "jsx" }[lang] ?? "javascript"];
}

/**
 * HTML, Vue and Angular templates: <script> and <style> blocks get their own grammar, the rest
 * the template grammar (HTML plus {{ }}). Splitting first keeps a script with blank lines in it
 * whole, which blank-line chunking alone would cut away from its opening tag.
 */
async function regions(lines, cx) {
  const out = [], template = Prism.languages.template;
  let pending = [];
  const flush = async () => { if (pending.length) { out.push(...(await chunked(pending, template, cx))); pending = []; } };
  for (let i = 0; i < lines.length; i++) {
    const open = /<(script|style)\b([^>]*)>/i.exec(lines[i]);
    const closeRe = open && new RegExp(`</${open[1]}\\s*>`, "i");
    if (!open || closeRe.test(lines[i].slice(open.index))) { pending.push(lines[i]); continue; } // inline: template handles it
    pending.push(lines[i]);
    await flush();
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j])) j++;
    out.push(...(await chunked(lines.slice(i + 1, j), blockGrammar(open[1], open[2]), cx)));
    if (j < lines.length) pending.push(lines[j]);
    i = j;
  }
  await flush();
  return out;
}

/**
 * Spans for a few edited lines, at once, while typing. Each line is tokenized on its own, so
 * a line inside a multi-line comment or a <script> block can be off until the pause re-highlight.
 */
export function highlightLines(lines, language) {
  const grammar = language === "html" || language === "vue" ? Prism.languages.template : language && Prism.languages[language];
  return lines.map((l) => packSpans(!l ? [] : grammar ? tokenLines(l, grammar)[0] : [{ text: l, type: null }]));
}

/** Per-line spans for `code`, packed (spans.js unpacks a line). */
export async function highlight(code, language, cx) {
  const lines = code.replace(/\r/g, "").split("\n");
  if (language === "html" || language === "vue") return regions(lines, cx);
  return chunked(lines, language && Prism.languages[language], cx);
}

export function color(type, t) {
  switch (type) {
    case "keyword": return t.ansi5;
    case "string": case "template-string": return t.ansi2;
    case "comment": return t.dim;
    case "number": case "boolean": case "constant": return t.ansi3;
    case "function": case "function-variable": return t.ansi4;
    case "class-name": return t.ansi3;
    case "operator": return t.ansi6;
    case "regex": return t.ansi1;
    case "punctuation": return t.muted;
    // JSON
    case "property": return t.ansi6;
    case "null": return t.ansi3;
    // C#
    case "namespace": case "attribute": case "generic": case "type-expression": case "constructor-invocation": return t.ansi3;
    case "interpolation-string": return t.ansi2;
    // HTML, Vue, Angular templates, JSX
    case "tag": return t.ansi1;
    case "directive-name": case "control-keyword": return t.ansi5; // v-if, :prop, @click, [x], (y), *ngIf, @if
    case "attr-name": return t.ansi3;
    case "attr-value": return t.ansi2;
    case "entity": return t.ansi6;
    case "doctype": case "prolog": case "cdata": return t.dim;
    // CSS
    case "selector": return t.ansi3;
    case "atrule": case "rule": case "statement": case "module-modifier": return t.ansi5;
    case "placeholder": case "parent": return t.ansi3;
    // TypeScript
    case "builtin": return t.ansi5;
    // Docker, YAML, .env
    case "instruction": return t.foreground; // the whole line; its FROM/RUN/... keyword is colored on its own
    case "variable": return t.ansi6;
    case "key": return t.ansi4;
    case "value": case "scalar": return t.ansi2;
    case "anchor": case "alias": case "directive": return t.ansi3;
    case "datetime": return t.ansi3;
    // Markdown
    case "title": case "important": return t.ansi4;
    case "code": case "code-snippet": case "code-block": case "code-language": return t.ansi2;
    case "url": case "link": return t.ansi4;
    case "list": return t.ansi5;
    case "blockquote": case "hr": return t.dim;
    // Bash, PowerShell, Python, SQL, Go, Rust, TOML, C and C++, Java, Lua, INI, diff
    case "shebang": return t.dim;
    case "parameter": return t.ansi6;
    case "assign-left": case "environment": case "function-name": case "file-descriptor": return t.ansi6;
    case "triple-quoted-string": case "char": case "raw-string": case "heredoc-string": case "string-interpolation": return t.ansi2;
    case "decorator": case "annotation": case "lifetime-annotation": case "type-definition": case "directive-hash": case "label": return t.ansi3;
    case "function-definition": case "macro": return t.ansi4;
    case "table": case "section-name": case "section": return t.ansi5;
    case "deleted-sign": case "deleted-arrow": case "deleted": return t.ansi1;
    case "inserted-sign": case "inserted-arrow": case "inserted": return t.ansi2;
    case "coord": return t.ansi6;
    default: return t.foreground;
  }
}
