#!/usr/bin/env node
// "% of book that cannot be withdrawn" — computed over a REAL live market.
//
//   firmness% = Σ (firm size) ÷ Σ (displayed size)
//
// where firm size is the resting quantity whose owner is an attested code hash
// still inside its lock window. This observable exists on no off-chain exchange:
// Polymarket/Kalshi/every CEX rest signed messages inside a private matching
// engine, with no on-chain owner to inspect.
//
//   node script/firmness.mjs [--pool 0x..] [--depth 200]
//
// The attested set is built from the deployed FirmQuote's LIVE runtime code
// (script/corpus.deployed.json → S0). With no deployment yet, it falls back to
// the local artifact hash and the live book will simply show 0% firm.

import { getCode, blockNumber, SHANNON_RPC, ethCall } from './lib/rpc.mjs';
import { readBook, codehashesFor } from './lib/book.mjs';
import { buildAttestedSet, attestedClassify } from './lib/classify.mjs';
import { artifactRuntime, loadDeployment } from './lib/corpus.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DEFAULT_POOL = '0x54d90260fe949940a80602e7fda8ebd729c5be00';
const POOL = arg('--pool', process.env.POOL || DEFAULT_POOL);
const DEPTH = Number(arg('--depth', '200'));
const UNLOCK_AT_SEL = '0xaa5dec6f';

async function attestedSet() {
  const dep = loadDeployment();
  if (dep && dep.S0) {
    const code = await getCode(dep.S0.address);
    return buildAttestedSet([{ name: 'FirmQuote(live)', code }]);
  }
  return buildAttestedSet([{ name: 'FirmQuote(artifact)', code: artifactRuntime('FirmQuote') }]);
}

async function lockOkFor(owner) {
  try {
    const ret = await ethCall(owner, UNLOCK_AT_SEL);
    const u = ret && ret !== '0x' ? parseInt(ret, 16) : 0;
    return u > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

async function main() {
  const set = await attestedSet();
  const [{ bids, asks, all }, block] = await Promise.all([readBook(POOL, DEPTH), blockNumber()]);
  const owners = all.map((o) => o.owner);
  const codeMap = await codehashesFor(owners, getCode);

  // Lock-window check only for owners whose code is attested (cheap: usually 0-1).
  const lockCache = new Map();
  for (const [addr, { codehash }] of codeMap) {
    if (set.has(codehash.toLowerCase())) lockCache.set(addr, await lockOkFor(addr));
  }

  let total = 0n, firm = 0n, pullable = 0n, unverified = 0n;
  const byClass = { FIRM: 0, PULLABLE: 0, UNVERIFIED: 0 };
  for (const o of all) {
    const { code } = codeMap.get(o.owner.toLowerCase());
    const lockOk = lockCache.get(o.owner.toLowerCase()) ?? true;
    const c = attestedClassify(code, set, lockOk).class;
    total += o.quantityRemaining;
    byClass[c]++;
    if (c === 'FIRM') firm += o.quantityRemaining;
    else if (c === 'PULLABLE') pullable += o.quantityRemaining;
    else unverified += o.quantityRemaining;
  }

  const pct = total === 0n ? 0 : Number((firm * 10000n) / total) / 100;
  console.log(`\n  firmness of ${POOL}  @ block ${block}\n`);
  console.log(`  orders            ${all.length}  (${bids.length} bid / ${asks.length} ask)`);
  console.log(`  distinct owners   ${codeMap.size}`);
  console.log(`  FIRM        ${byClass.FIRM} orders   ${firm} units`);
  console.log(`  PULLABLE    ${byClass.PULLABLE} orders   ${pullable} units`);
  console.log(`  UNVERIFIED  ${byClass.UNVERIFIED} orders   ${unverified} units`);
  console.log(`  total displayed   ${total} units`);
  console.log(`\n  \x1b[1m% of book that cannot be withdrawn: ${pct}%\x1b[0m\n`);
  if (byClass.FIRM === 0) {
    console.log(`  (no FIRM depth on this pool right now — rest a FirmQuote here, or run deploy-corpus.mjs)\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
