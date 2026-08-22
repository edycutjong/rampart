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

/** One side of the book as decoded orders. */
export async function readSide(pool, isBid, maxCount = 200, url) {
  const data = GET_ALL_OPEN + encBool(isBid) + encUint(maxCount) + encUint(0);
  const ret = await ethCall(pool, data, url);
  const w = words(ret);
  // outer tuple: [offset(orders), hasMore, nextCursor]
  const off = Number(toBig(w[0])) / 32;
  const len = Number(toBig(w[off]));
  const orders = [];
  const STRUCT = 8; // words per Order (all static)
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
  return orders;
}

/** Both sides. */
export async function readBook(pool, maxCount = 200, url) {
  const [bids, asks] = await Promise.all([
    readSide(pool, true, maxCount, url),
    readSide(pool, false, maxCount, url),
  ]);
  return { bids, asks, all: [...bids, ...asks] };
}

/** EXTCODEHASH for a set of addresses, memoised — one eth_getCode per DISTINCT owner. */
export async function codehashesFor(owners, getCodeFn) {
  const distinct = [...new Set(owners.map((o) => o.toLowerCase()))];
  const map = new Map();
  for (const o of distinct) {
    const code = await getCodeFn(o);
    map.set(o, { code, codehash: keccakHex(code) });
  }
  return map;
}
