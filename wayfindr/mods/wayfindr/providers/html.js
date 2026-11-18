// Azure DevOps rich text (HTML) to markdown for the detail panel (G9). Pure: no Herdr imports.
// Keeps structure (paragraphs, lines, headings, lists, bold, italics, links, code) and drops the rest.
// Text is escaped so nothing in it becomes markdown, and only http(s) and mailto links survive.

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
  if (e[0] === "#") {
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n === 0xa0 ? 0x20 : n) : "";
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});
// "!" too, so text before a link can never turn it into an image.
const escape = (s) => s.replace(/([\\`*_[\]<>#|~!])/g, "\\$1");
// Encoded: anything that could end the <url> destination or start another link inside it.
const safeUrl = (u) => (/^(https?:|mailto:)/i.test(u ?? "") ? u.replace(/[()<>"\\\s\u0000-\u001f\u007f]/g, encodeURIComponent) : null);
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : null;
};

export function htmlToMarkdown(html) {
  if (!html) return "";
  const src = String(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  let out = "";
  const lists = [], links = [];
  let pre = 0;
  const nl = (n = 1) => { out = out.replace(/[ \t]+$/, ""); const have = /\n*$/.exec(out)[0].length; if (out && have < n) out += "\n".repeat(n - have); };

  for (const tok of src.split(/(<[^>]*>)/)) {
    if (!tok) continue;
    if (tok[0] !== "<") {
      const text = decode(tok).replace(/[\u0000-\u0003]/g, "");
      out += pre ? text : escape(text.replace(/\s+/g, " "));
      continue;
    }
    const m = /^<\s*(\/)?\s*([a-z0-9]+)/i.exec(tok);
    if (!m) continue;
    const close = Boolean(m[1]), name = m[2].toLowerCase();
    switch (name) {
      // Markdown joins single lines, so a line break outside a list starts a paragraph.
      case "br": if (pre) out += "\n"; else if (lists.length) out += " "; else nl(2); break;
      case "p": case "div": case "blockquote": case "section": if (!lists.length) nl(2); break;
      case "tr": case "table": nl(2); break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        nl(2); if (!close) out += "#".repeat(Number(name[1])) + " "; break;
      // Emphasis goes in as private marks, so text that was escaped can never pair with it.
      case "b": case "strong": out += "\u0001"; break;
      case "i": case "em": out += "\u0002"; break;
      case "s": case "strike": case "del": out += "\u0003"; break;
      case "code": if (!pre) out += "`"; break;
      case "pre":
        if (!close) { nl(2); out += "```\n"; pre++; } else if (pre) { if (!out.endsWith("\n")) out += "\n"; out += "```"; pre--; nl(2); }
        break;
      case "hr": nl(1); out += "---"; nl(1); break;
      case "ul": case "ol":
        if (close) lists.pop(); else lists.push({ ordered: name === "ol", n: 0 });
        nl(1); break;
      case "li": {
        if (close) break;
        nl(1);
        const l = lists[lists.length - 1] ?? { ordered: false, n: 0 };
        out += "  ".repeat(Math.max(0, lists.length - 1)) + (l.ordered ? `${++l.n}. ` : "- ");
        break;
      }
      case "td": case "th": if (close) out += " | "; break;
      case "a":
        if (close) { const href = links.pop(); if (href) out += `](<${href}>)`; break; }
        { const href = attr(tok, "data-vss-mention") ? null : safeUrl(attr(tok, "href")); links.push(href); if (href) out += "["; }
        break;
      case "img": { const u = safeUrl(attr(tok, "src")); if (u) out += `![${escape(attr(tok, "alt") || "image")}](<${u}>)`; break; }
      default: break; // span, font, u and the rest: text only
    }
  }
  // Tidy spacing outside code blocks only: their whitespace is the content.
  return out.split(/(```\n[\s\S]*?```)/).map((part, i) => (i % 2 ? part : part
    // Emphasis can't start or end with a space: move spaces outside, drop empty pairs.
    .replace(/([\u0001-\u0003])([ \t]*)([^\n\u0001-\u0003]*?)([ \t]*)\1/g, (_m, mark, a, inner, b) => (inner ? `${a}${mark}${inner}${mark}${b}` : `${a}${b}`))
    .replace(/[\u0001-\u0003]/g, (c) => ["**", "_", "~~"][c.charCodeAt(0) - 1])
    .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+(?=[^ \t\-\d])/g, "\n")
    .replace(/\n{3,}/g, "\n\n"))).join("").trim();
}
