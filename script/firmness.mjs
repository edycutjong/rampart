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
//   node script/firmness.mjs [--pool 0x..] [--depth 200] [--block <n>] [--allow-empty]
//
// The attested set is built from the deployed FirmQuote's LIVE runtime code
// (script/corpus.deployed.json → S0).

import { getCode, currentBlock, ethCall, pinFromArgs, isPinned, now, BLOCK, assertPinnedStateAvailable } from './lib/rpc.mjs';
import { readBook, codehashesFor } from './lib/book.mjs';
import { buildAttestedSet, attestedClassify } from './lib/classify.mjs';
import { loadDeployment } from './lib/corpus.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DEFAULT_POOL = '0x54d90260fe949940a80602e7fda8ebd729c5be00';
const POOL = arg('--pool', process.env.POOL || DEFAULT_POOL);
const DEPTH = Number(arg('--depth', '200'));
const ALLOW_EMPTY = process.argv.includes('--allow-empty');
const UNLOCK_AT_SEL = '0xaa5dec6f';
pinFromArgs();

/**
 * Build the attested set from LIVE deployed code — never from the local artifact.
 *
 * WHY NOT THE ARTIFACT: `FirmQuote` has 4 immutables. Solc writes zeros into the
 * artifact's `deployedBytecode` where the constructor will splice real values, so
 * the artifact hashes to 0xc707d06c… while any real deployment hashes to something
 * else entirely (0xc60110e0… for S0). `buildAttestedSet` hashes raw runtime with no
 * immutable masking, so an artifact-derived hash can NEVER match a live owner. The
 * old fallback here silently produced a *wrong* 0% instead of an error whenever
 * corpus.deployed.json was missing. Refusing to run is the honest behaviour.
 */
async function attestedSet() {
  const dep = loadDeployment();
  if (!dep || !dep.S0) {
    throw new Error(
      'no script/corpus.deployed.json → cannot build an attested set.\n' +
      '  FirmQuote has 4 immutables, so the local artifact hash can never equal a deployed hash;\n' +
      '  falling back to it would report a confidently wrong 0%. Run: node script/deploy-corpus.mjs',
    );
  }
  await assertPinnedStateAvailable(dep.S0.address, dep._meta && dep._meta.pool);
  const code = await getCode(dep.S0.address);
  if (!code || code === '0x') {
    throw new Error(`S0 ${dep.S0.address} has no code at block ${BLOCK} — redeploy, or pin an earlier --block.`);
  }
  return buildAttestedSet([{ name: 'FirmQuote(live)', code }]);
}

async function lockOkFor(owner) {
  try {
    const ret = await ethCall(owner, UNLOCK_AT_SEL);
    const u = ret && ret !== '0x' ? parseInt(ret, 16) : 0;
    return u > (await now());
  } catch { return false; }
}

async function main() {
  const set = await attestedSet();
  const [{ bids, asks, all, truncated }, block] = await Promise.all([readBook(POOL, DEPTH), currentBlock()]);
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
    const entry = codeMap.get(o.owner.toLowerCase());
    // Cannot be absent — the map was built from this exact book's owners. Guarded
    // anyway: silently classifying a missing entry would be a wrong number.
    if (!entry) throw new Error(`no code entry for owner ${o.owner}`);
    const { code } = entry;
    const lockOk = lockCache.get(o.owner.toLowerCase()) ?? true;
    const c = attestedClassify(code, set, lockOk).class;
    total += o.quantityRemaining;
    byClass[c]++;
    if (c === 'FIRM') firm += o.quantityRemaining;
    else if (c === 'PULLABLE') pullable += o.quantityRemaining;
    else unverified += o.quantityRemaining;
  }

  const pct = total === 0n ? 0 : Number((firm * 10000n) / total) / 100;
  console.log(`\n  firmness of ${POOL}  @ block ${block}${isPinned() ? ' (pinned)' : ''}\n`);
  console.log(`  orders            ${all.length}  (${bids.length} bid / ${asks.length} ask)`);
  console.log(`  distinct owners   ${codeMap.size}`);
  console.log(`  FIRM        ${byClass.FIRM} orders   ${firm} units`);
  console.log(`  PULLABLE    ${byClass.PULLABLE} orders   ${pullable} units`);
  console.log(`  UNVERIFIED  ${byClass.UNVERIFIED} orders   ${unverified} units`);
  console.log(`  total displayed   ${total} units`);
  console.log(`\n  \x1b[1m% of book that cannot be withdrawn: ${pct}%\x1b[0m\n`);

  // A truncated book makes the ratio a sample, not a census. Never present it as one.
  if (truncated) {
    console.error(
      `\x1b[31mFAIL: the book has more than --depth ${DEPTH} orders per side; the pool reported hasMore.\x1b[0m\n` +
      `  Σfirm ÷ Σdisplayed over a truncated book is not the firmness of this market.\n` +
      `  Re-run with a larger --depth.\n`,
    );
    process.exit(1);
  }

  // An empty book yields 0% for every possible market. A gate that always passes
  // is not a gate (LESSONS R10) — refuse to report a vacuous number as a result.
  if (all.length === 0 && !ALLOW_EMPTY) {
    console.error(
      `\x1b[31mFAIL: 0 resting orders on ${POOL} at block ${block} — nothing to measure.\x1b[0m\n` +
      `  The 0% above is vacuous, not a finding: it is what an empty book returns for any market.\n` +
      `  Shannon pools cycle every ~24h. Either:\n` +
      `    node script/firmness.mjs --block <n>     pin a block where the book was populated (archive RPC)\n` +
      `    node script/firmness.mjs --pool 0x...    point at a currently active pool\n` +
      `    node script/deploy-corpus.mjs            rest fresh FirmQuote depth\n` +
      `  Pass --allow-empty if an empty book is genuinely the expected outcome.\n`,
    );
    process.exit(1);
  }
  if (byClass.FIRM === 0) {
    console.log(`  (no FIRM depth on this pool right now — rest a FirmQuote here, or run deploy-corpus.mjs)\n`);
  }
}

main().catch((e) => { console.error(`\x1b[31m${e.message || e}\x1b[0m`); process.exit(1); });
