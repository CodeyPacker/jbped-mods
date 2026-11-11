// A line's highlight spans, packed into one string. Pure: no Herdr imports.
//
// Every open, reviewed or changed file keeps spans for both of its sides in every copy of the
// mod, and Herdr's script runtime has one memory limit for all mods. As { text, type } objects
// a line of JavaScript takes about 1.2 KB there; packed it takes about 160 bytes. The packed
// form is: the span count (2 chars), then per span its type's number and its length (1 + 2
// chars), then the spans' texts one after another. `spans()` unpacks a line for drawing.

const TYPES = [null], NUM = new Map([[null, 0]]); // Prism's token types: a grammar's fixed set

const num = (type) => {
  let n = NUM.get(type);
  if (n === undefined) { n = TYPES.length; TYPES.push(type); NUM.set(type, n); }
  return n;
};

/** [{ text, type }] -> one string ("" for no spans). */
export function packSpans(list) {
  if (!list.length) return "";
  let head = String.fromCharCode(list.length & 0xffff, list.length >>> 16), body = "";
  for (const s of list) {
    head += String.fromCharCode(num(s.type ?? null), s.text.length & 0xffff, s.text.length >>> 16);
    body += s.text;
  }
  return head + body;
}

/** A line's spans as [{ text, type }]: from a packed string, or an array as it is. */
export function spans(line) {
  if (typeof line !== "string") return line ?? [];
  if (!line) return [];
  const n = line.charCodeAt(0) + line.charCodeAt(1) * 0x10000, out = new Array(n);
  let at = 2 + n * 3;
  for (let i = 0; i < n; i++) {
    const k = 2 + i * 3, len = line.charCodeAt(k + 1) + line.charCodeAt(k + 2) * 0x10000;
    out[i] = { text: line.slice(at, at + len), type: TYPES[line.charCodeAt(k)] ?? null };
    at += len;
  }
  return out;
}
