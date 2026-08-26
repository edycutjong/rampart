// Read a live BinaryPool resting book off-chain and type every level.
//
// SDK method driven: `getAllOpenOrdersOffChain(bool,uint256,uint64)` — the pool
// requires msg.sender == address(0), which a bare eth_call (no `from`) satisfies.
// See markets-sdk `orders.js#getAllOpenOrdersOnchain`.

import { ethCall } from './rpc.mjs';
import { keccakHex } from './keccak.mjs';

// getAllOpenOrdersOffChain(bool,uint256,uint64) selector.
export const GET_ALL_OPEN = '0x4f2694cf';

function words(hex) {
  const h = hex.replace(/^0x/, '');
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}
const toBig = (w) => BigInt('0x' + w);
const toAddr = (w) => '0x' + w.slice(24);

function encBool(b) { return (b ? '1' : '0').padStart(64, '0'); }
function encUint(n) { return BigInt(n).toString(16).padStart(64, '0'); }

/**
 * A decoded resting order. Field order mirrors the pool's Order struct exactly —
 * the word-offset decode below depends on it, and `script/sdk-verify.mjs` checks
 * the layout against the shipped SDK source in CI.
 *
 * @typedef {object} Order
 * @property {bigint} orderId       uint128 order id
 * @property {boolean} isBid        true = bid side
 * @property {string} owner         the resting order's on-chain owner (the address the classifier types)
 * @property {bigint} userData      opaque uint64 MM bookkeeping field
 * @property {bigint} price         YES-side price, raw pool units
 * @property {bigint} fullQuantity  original quantity, raw units
 * @property {bigint} quantityRemaining  still-resting quantity, raw units
 * @property {bigint} expireTimestampNs  mandatory expiry, ns since epoch
 */

/**
 * One side of the book as decoded orders.
 *
 * Returns `{ orders, hasMore, nextCursor }` — `hasMore` is the pool's own signal
 * that it truncated at `maxCount`. Callers MUST propagate it: a firmness ratio
 * computed over a silently truncated book is a wrong number presented as a right
 * one, which is worse than an error (2026-08-26 audit, F-8).
 *
 * @param {string} pool BinaryPool address
 * @param {boolean} isBid true = bid side, false = ask side
 * @param {number} [maxCount] per-side read cap (the pool truncates here and sets hasMore)
 * @param {string} [url] RPC endpoint (defaults to Somnia Shannon)
 * @returns {Promise<{ orders: Order[], hasMore: boolean, nextCursor: bigint }>}
 */
export async function readSide(pool, isBid, maxCount = 200, url) {
  const data = GET_ALL_OPEN + encBool(isBid) + encUint(maxCount) + encUint(0);
  const ret = await ethCall(pool, data, url);
  const w = words(ret);
  // outer tuple: [offset(orders), hasMore, nextCursor]
  const off = Number(toBig(w[0])) / 32;
  const hasMore = toBig(w[1]) === 1n;
  const nextCursor = toBig(w[2]);
  const len = Number(toBig(w[off]));
  const STRUCT = 8; // words per Order (all static)
  // Guard the fixed-layout assumption: if the SDK ever changes the Order struct,
  // fail loudly rather than decode neighbouring words into plausible garbage.
  const need = off + 1 + len * STRUCT;
  if (len < 0 || need > w.length) {
    throw new Error(
      `book decode: expected ${need} words for ${len} orders but got ${w.length}. ` +
      'The pool\'s Order struct layout has probably changed — update STRUCT in lib/book.mjs.',
    );
  }
  const orders = [];
  for (let i = 0; i < len; i++) {
    const base = off + 1 + i * STRUCT;
    orders.push({
      orderId: toBig(w[base + 0]),
      isBid: toBig(w[base + 1]) === 1n,
      owner: toAddr(w[base + 2]),
      userData: toBig(w[base + 3]),
      price: toBig(w[base + 4]),
      fullQuantity: toBig(w[base + 5]),
      quantityRemaining: toBig(w[base + 6]),
      expireTimestampNs: toBig(w[base + 7]),
    });
  }
  return { orders, hasMore, nextCursor };
}

/**
 * Both sides. `truncated` is true if EITHER side hit the maxCount cap —
 * never present a ratio computed over a truncated book as a census.
 *
 * @param {string} pool BinaryPool address
 * @param {number} [maxCount] per-side read cap
 * @param {string} [url] RPC endpoint (defaults to Somnia Shannon)
 * @returns {Promise<{ bids: Order[], asks: Order[], all: Order[], truncated: boolean, hasMore: { bids: boolean, asks: boolean } }>}
 */
export async function readBook(pool, maxCount = 200, url) {
  const [b, a] = await Promise.all([
    readSide(pool, true, maxCount, url),
    readSide(pool, false, maxCount, url),
  ]);
  return {
    bids: b.orders,
    asks: a.orders,
    all: [...b.orders, ...a.orders],
    truncated: b.hasMore || a.hasMore,
    hasMore: { bids: b.hasMore, asks: a.hasMore },
  };
}

/**
 * Runtime code + codehash for a set of addresses, memoised — one eth_getCode per
 * DISTINCT owner. The hash equals on-chain EXTCODEHASH for existing accounts.
 *
 * @param {string[]} owners addresses (duplicates fine — deduplicated case-insensitively)
 * @param {(addr: string) => Promise<string>} getCodeFn e.g. `getCode` from ./rpc.mjs
 * @returns {Promise<Map<string, { code: string, codehash: string }>>} keyed by lowercased address
 */
export async function codehashesFor(owners, getCodeFn) {
  const distinct = [...new Set(owners.map((o) => o.toLowerCase()))];
  const map = new Map();
  for (const o of distinct) {
    const code = await getCodeFn(o);
    map.set(o, { code, codehash: keccakHex(code) });
  }
  return map;
}
