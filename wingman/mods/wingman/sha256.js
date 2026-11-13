// SHA-256 of text as UTF-8 bytes, and UTF-8 byte counting and chunking. Pure: no Herdr imports.
// Herdr's runtime (QuickJS) has no TextEncoder but has a native Buffer, used for the UTF-8 bytes
// when present. Hashing is always plain JS: Herdr's crypto.subtle.digest is a host async function,
// and calling it from the capture path (collectAll -> store.reconcile -> committed() -> sumOf)
// panicked the app's JS engine ("tried to use async function in non async runtime") and stopped
// that Wingman copy. Never call crypto.subtle here.

const NativeBuffer = typeof globalThis.Buffer === "function" ? globalThis.Buffer : null;

/** The UTF-8 bytes of `s`. A lone surrogate becomes U+FFFD (EF BF BD), as TextEncoder does. */
export function utf8(s) {
  if (NativeBuffer) { try { return NativeBuffer.from(s, "utf8"); } catch {} } // Herdr's throws on a lone surrogate
  return utf8Js(s);
}

/** utf8 in plain JS. */
export function utf8Js(s) {
  const out = new Uint8Array(byteLengthJs(s));
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const d = s.charCodeAt(i + 1);
      if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      else c = 0xfffd;
    }
    if (c < 0x80) out[o++] = c;
    else if (c < 0x800) { out[o++] = 0xc0 | (c >> 6); out[o++] = 0x80 | (c & 63); }
    else if (c < 0x10000) { out[o++] = 0xe0 | (c >> 12); out[o++] = 0x80 | ((c >> 6) & 63); out[o++] = 0x80 | (c & 63); }
    else { out[o++] = 0xf0 | (c >> 18); out[o++] = 0x80 | ((c >> 12) & 63); out[o++] = 0x80 | ((c >> 6) & 63); out[o++] = 0x80 | (c & 63); }
  }
  return out;
}

/** The UTF-8 size of one code point starting at `s[i]`, and how many UTF-16 units it takes. */
function unitAt(s, i) {
  const c = s.charCodeAt(i);
  if (c < 0x80) return [1, 1];
  if (c < 0x800) return [2, 1];
  if (c >= 0xd800 && c <= 0xdbff) { const d = s.charCodeAt(i + 1); if (d >= 0xdc00 && d <= 0xdfff) return [4, 2]; }
  return [3, 1]; // the rest of the BMP, and a lone surrogate (U+FFFD)
}

/** How many bytes `s` takes as UTF-8. */
export function byteLength(s) {
  if (NativeBuffer) { try { return NativeBuffer.byteLength(s, "utf8"); } catch {} }
  return byteLengthJs(s);
}

/** byteLength in plain JS. */
export function byteLengthJs(s) {
  let n = 0;
  for (let i = 0; i < s.length; ) { const [b, u] = unitAt(s, i); n += b; i += u; }
  return n;
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;

/**
 * `s` cut into pieces costing at most `max` each, never inside a surrogate pair (so never inside a
 * character). Joined, they are `s`; an empty `s` gives none. The cost of a piece is its UTF-8 size
 * by default; `cost` can count more (e.g. characters a command line escapes). A piece is sized
 * from a guess and shrunk in proportion until it fits, so a long text costs a few native byte
 * counts per piece rather than a JS loop over every character.
 */
export function chunkBytes(s, max, cost = byteLength) {
  if (!(max >= 8)) throw new Error("chunk size must be at least 8 bytes");
  const out = [];
  for (let i = 0; i < s.length; ) {
    let n = Math.min(s.length - i, max);
    for (;;) {
      // Never end on the first half of a pair: back off, or take the whole pair when it's alone.
      if (i + n < s.length && isHigh(s.charCodeAt(i + n - 1))) n = n > 1 ? n - 1 : 2;
      const c = cost(s.slice(i, i + n));
      if (c <= max || n <= 2) break;
      n = Math.max(1, Math.min(n - 1, Math.floor((n * max) / c)));
    }
    out.push(s.slice(i, i + n)); i += n;
  }
  return out;
}

// ---- SHA-256 (FIPS 180-4) -------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of bytes, as 64 lowercase hex digits. */
export function sha256Bytes(bytes) {
  const n = bytes.length, total = ((n + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
  m.set(bytes); m[n] = 0x80;
  // The bit length, big-endian, in the last 8 bytes (n < 2^53, so two 32-bit halves).
  const bits = n * 8, hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
  m[total - 8] = hi >>> 24; m[total - 7] = hi >>> 16; m[total - 6] = hi >>> 8; m[total - 5] = hi;
  m[total - 4] = lo >>> 24; m[total - 3] = lo >>> 16; m[total - 2] = lo >>> 8; m[total - 1] = lo;
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let p = 0; p < total; p += 64) {
    for (let i = 0; i < 16; i++) { const j = p + i * 4; W[i] = (m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3]; }
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  let hex = "";
  for (let i = 0; i < 8; i++) hex += H[i].toString(16).padStart(8, "0");
  return hex;
}

/** SHA-256 of `s` as UTF-8, pure JS. */
export const sha256Pure = (s) => sha256Bytes(utf8(s));

/**
 * SHA-256 of `s` as UTF-8, in plain JS (sha256Pure). Async only so callers keep awaiting it; it
 * never calls a host async function.
 */
export async function sha256Hex(s) {
  return sha256Bytes(utf8(s));
}
