// Minimal keccak-256 (Ethereum's hash — NOT NIST SHA3; the padding differs).
// Public-domain style implementation, dependency-free. Verified against
// `cast keccak` in script/lib/keccak.test.mjs.

const RC = [
  0x00000001n, 0x00008082n, 0x0000808an, 0x80008000n, 0x0000808bn, 0x80000001n,
  0x80008081n, 0x00008009n, 0x0000008an, 0x00000088n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x0000008bn, 0x00008089n, 0x00008003n, 0x00008002n, 0x00000080n,
  0x0000800an, 0x8000000an, 0x80008081n, 0x00008080n, 0x80000001n, 0x80008008n,
].map((x, i) => {
  // RC constants above are the low 32 bits; keccak uses 64-bit lane RCs.
  return null;
});

// Full 64-bit round constants.
const RC64 = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const R = [
  [0n, 36n, 3n, 41n, 18n],
  [1n, 44n, 10n, 45n, 2n],
  [62n, 6n, 43n, 15n, 61n],
  [28n, 55n, 25n, 21n, 56n],
  [27n, 20n, 39n, 8n, 14n],
];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << n) | (x >> (64n - n))) & MASK;

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    const D = new Array(5);
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] ^= D[x];
    const B = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], R[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        s[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & B[((x + 2) % 5) + 5 * y]);
      }
    }
    s[0] ^= RC64[round];
  }
}

/** keccak256 of a Uint8Array/Buffer → 0x-prefixed 32-byte hex string. */
export function keccak256(bytes) {
  const rate = 136; // 1088 bits for keccak-256
  const input = Uint8Array.from(bytes);
  const padLen = rate - (input.length % rate);
  const padded = new Uint8Array(input.length + padLen);
  padded.set(input);
  padded[input.length] ^= 0x01; // keccak domain separation
  padded[padded.length - 1] ^= 0x80;

  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) lane |= BigInt(padded[off + i * 8 + b]) << (8n * BigInt(b));
      s[i] ^= lane;
    }
    keccakF(s);
  }

  let out = '0x';
  for (let i = 0; i < 4; i++) {
    let lane = s[i];
    for (let b = 0; b < 8; b++) {
      out += ((lane >> (8n * BigInt(b))) & 0xffn).toString(16).padStart(2, '0');
    }
  }
  return out;
}

/** keccak256 of a 0x hex string (bytecode). */
export function keccakHex(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  return keccak256(bytes);
}
