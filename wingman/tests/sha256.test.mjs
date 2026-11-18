// sha256.js: SHA-256 against known vectors and node's crypto, UTF-8 encoding, and byte chunking.
import { sha256Bytes, sha256Pure, sha256Hex, utf8, utf8Js, byteLength, byteLengthJs, chunkBytes } from "../mods/wingman/sha256.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const node = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

// First, before any other sha256Hex call: sha256Hex never reads crypto (in Herdr, crypto.subtle.digest
// panicked the engine from the capture path). With crypto trapped it still gives the known vectors.
{
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let touched = 0;
  const trap = new Proxy({}, { get() { touched++; throw new Error("crypto.subtle used"); } });
  Object.defineProperty(globalThis, "crypto", { configurable: true, get() { touched++; return { subtle: trap }; } });
  try {
    const vectors = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"], // two blocks
      ["a".repeat(1000), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"], // 16 blocks
      ["é 中文 😀", node("é 中文 😀")], // 2-, 3- and 4-byte UTF-8 (against node:crypto's createHash, which the trap doesn't cover)
      ["héllo wörld", "a1003f7d04a4115711d0b48a2eaf1359ce565d2d2a6fd65098dfcffadeeef59f"],
    ];
    for (const [text, want] of vectors) assert.equal(await sha256Hex(text), want, JSON.stringify(text.slice(0, 20)));
    assert.equal(touched, 0, "crypto was never read");
  } finally {
    if (desc) Object.defineProperty(globalThis, "crypto", desc); else delete globalThis.crypto;
  }
}

// FIPS 180-4 vectors.
assert.equal(sha256Pure(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
assert.equal(sha256Pure("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(sha256Pure("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
assert.equal(sha256Pure("a".repeat(1000000)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
// Padding edges: 55, 56, 63, 64, 65 bytes.
for (const n of [55, 56, 63, 64, 65, 119, 120]) assert.equal(sha256Pure("x".repeat(n)), node("x".repeat(n)), `length ${n}`);

const nasty = "a\r\nb\tc \"q\" 'q' `b` \\n \\\\ $HOME ${x} $(id) %s %% é 中文 😀 \u00a0 \u2028 \ufeff end";
for (const s of [nasty, "\ufeffbom", "😀", "é".repeat(1000), nasty.repeat(300)]) {
  assert.equal(sha256Pure(s), node(s));
  assert.equal(await sha256Hex(s), node(s));
}

// UTF-8: the JS encoder matches Buffer; a lone surrogate is U+FFFD, as TextEncoder does.
for (const s of [nasty, "", "\u007f\u0080\u07ff\u0800\uffff", "😀😀"]) {
  assert.deepEqual(Buffer.from(utf8Js(s)), Buffer.from(s, "utf8"));
  assert.equal(byteLengthJs(s), Buffer.byteLength(s, "utf8"));
  assert.equal(byteLength(s), Buffer.byteLength(s, "utf8"));
  assert.deepEqual(Buffer.from(utf8(s)), Buffer.from(s, "utf8"));
}
assert.deepEqual([...utf8Js("a\ud800b")], [0x61, 0xef, 0xbf, 0xbd, 0x62]);
assert.deepEqual([...utf8Js("\udc00")], [0xef, 0xbf, 0xbd]);
assert.equal(byteLengthJs("a\ud800b"), 5);
assert.equal(sha256Bytes(utf8Js("a\ud800b")), node("a\ufffdb"));

// Chunking: joined back it's the text, each piece fits, no piece starts or ends inside a pair.
const fits = (s, max, cost = byteLength) => {
  const parts = chunkBytes(s, max, cost);
  assert.equal(parts.join(""), s);
  for (const p of parts) {
    assert.ok(cost(p) <= max, `piece of ${cost(p)} > ${max}`);
    assert.ok(p.length > 0);
    const first = p.charCodeAt(0), last = p.charCodeAt(p.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "starts with a low surrogate");
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "ends with a high surrogate");
  }
  return parts;
};
assert.deepEqual(chunkBytes("", 100), []);
assert.deepEqual(fits("abc", 100), ["abc"]);
assert.equal(fits("x".repeat(100), 10).length, 10);
// Every multi-byte boundary: 2-, 3- and 4-byte characters at every offset against the size.
for (const ch of ["é", "中", "😀"]) for (let pad = 0; pad < 5; pad++) for (const max of [8, 9, 10, 11, 13]) fits("a".repeat(pad) + ch.repeat(20), max);
// Surrogate pairs right at a cut, with a size that would otherwise split one.
fits("1234567😀😀😀😀", 8);
fits("😀".repeat(1000), 4096);
fits(nasty.repeat(500), 1000);
// A cost that counts " and \ twice (the Windows command line).
const quoted = (s) => byteLength(s) + (s.match(/["\\]/g)?.length ?? 0);
const qs = fits('"\\'.repeat(5000) + "é😀".repeat(100), 1000, quoted);
assert.ok(qs.length >= 20);
// Big texts are sized from a guess: pieces are near the limit, not tiny.
const big = fits("abcdefghi\n".repeat(30000), 100000);
assert.equal(big.length, 3);
const wide = fits("中".repeat(100000), 100000);
assert.ok(wide.length <= 4, `${wide.length} pieces`);
assert.throws(() => chunkBytes("abc", 3));
console.log("sha256 ok");
