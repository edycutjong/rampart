// rampart engine — public entry point.
//
// A dependency-free toolkit for typing on-chain order-book liquidity on Somnia:
//
//   keccak.mjs    keccak-256 (Ethereum's, not NIST SHA3) + 4-byte selector derivation
//   analyzer.mjs  EVM disassembler + the FIRM_CAPABLE static bytecode policy
//   classify.mjs  the FIRM / PULLABLE / UNVERIFIED ternary classifier
//   book.mjs      zero-auth BinaryPool book reader (`getAllOpenOrdersOffChain`)
//   rpc.mjs       raw JSON-RPC with block pinning (reads reproduce against an archive node)
//
// ZERO runtime dependencies, by design: every result is re-derivable with
// nothing but Node ≥ 20 and a public endpoint. The hand-transcribed Somnia
// surface (selectors, Order struct layout) is checked against the real
// `@somnia-chain/markets-sdk` in CI by `script/sdk-verify.mjs`, so it cannot
// drift silently — but the SDK never ships with this library.
//
// HONEST LIMITS — read before trusting a verdict:
//   * `analyze()` is NECESSARY, NOT SUFFICIENT. A FIRM_CAPABLE verdict is a
//     pre-filter result, never a proof of irrevocability (a selector built
//     arithmetically at runtime evades any static scan). Every record carries
//     this caveat in its `guarantee` field.
//   * `readBook()` reports `truncated` when the pool capped the read. A ratio
//     computed over a truncated book is a sample, not a census — propagate it.
//
// See ./README.md for install + runnable examples.

// ── hashing ─────────────────────────────────────────────────────────────────
export { keccak256, keccakHex, selectorOf } from './keccak.mjs';

// ── static bytecode policy ──────────────────────────────────────────────────
export {
  analyze,
  disassemble,
  stripMetadata,
  scanForbiddenLiterals,
  FORBIDDEN_SELECTORS,
  MAX_PLAUSIBLE_METADATA,
} from './analyzer.mjs';

// ── ternary classifier ──────────────────────────────────────────────────────
export {
  buildAttestedSet,
  attestedClassify,
  naiveClassify,
  EMPTY_CODEHASH,
} from './classify.mjs';

// ── order-book reader ───────────────────────────────────────────────────────
export { readBook, readSide, codehashesFor, GET_ALL_OPEN } from './book.mjs';

// ── JSON-RPC + block pinning ────────────────────────────────────────────────
export {
  rpc,
  getCode,
  ethCall,
  blockNumber,
  currentBlock,
  setBlock,
  pinFromArgs,
  isPinned,
  now,
  assertPinnedStateAvailable,
  encAddr,
  SHANNON_RPC,
} from './rpc.mjs';
