#!/usr/bin/env node
// Generate the typed-book snapshot the viewer renders — from REAL chain state only.
//
//   node site/viewer/make-snapshot.mjs [--block 468201000] [--pool 0x…]
//
// Reads the same engine the CLI uses (script/lib/*) at a PINNED block against
// Somnia's archival RPC, classifies every resting order FIRM / PULLABLE /
// UNVERIFIED with the same attested-EXTCODEHASH policy as script/firmness.mjs,
// and writes:
//
//   site/viewer/book-<block>.json                 the machine-readable snapshot
//   site/viewer/index.html   (inline injection)   the same JSON between the
//                                                 SNAPSHOT markers, so the page
//                                                 renders identically over file://
//
// Nothing in the output is invented: every order, owner, price, size, code hash
// and reason is read or derived from chain state at the pinned block. Owner
// labels come from script/corpus.deployed.json — the record of our own real
// deployments — and are only attached when the on-chain owner address matches.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', '..');

const { getCode, ethCall, currentBlock, pinFromArgs, isPinned, now, assertPinnedStateAvailable, SHANNON_RPC } =
  await import(join(BUILD, 'script/lib/rpc.mjs'));
const { readBook, codehashesFor } = await import(join(BUILD, 'script/lib/book.mjs'));
const { buildAttestedSet, attestedClassify, naiveClassify } = await import(join(BUILD, 'script/lib/classify.mjs'));
const { analyze } = await import(join(BUILD, 'script/lib/analyzer.mjs'));
const { loadDeployment } = await import(join(BUILD, 'script/lib/corpus.mjs'));

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DEFAULT_POOL = '0x54d90260fe949940a80602e7fda8ebd729c5be00';
const POOL = arg('--pool', process.env.POOL || DEFAULT_POOL);
const DEPTH = Number(arg('--depth', '200'));
const UNLOCK_AT_SEL = '0xaa5dec6f';

if (!process.argv.includes('--block') && !process.env.RAMPART_BLOCK) {
  process.argv.push('--block', '468201000'); // the documented reproducible block
}
pinFromArgs();

async function main() {
  const dep = loadDeployment();
  if (!dep || !dep.S0) throw new Error('script/corpus.deployed.json missing — cannot build the attested set.');
  await assertPinnedStateAvailable(dep.S0.address, dep._meta && dep._meta.pool);

  const s0code = await getCode(dep.S0.address);
  if (!s0code || s0code === '0x') throw new Error(`S0 ${dep.S0.address} has no code at this block.`);
  const set = buildAttestedSet([{ name: 'FirmQuote(live)', code: s0code }]);

  // Owner labels: ONLY our own recorded deployments, matched by address.
  const labels = new Map();
  for (const [key, v] of Object.entries(dep)) {
    if (key.startsWith('_') || !v || !v.address) continue;
    labels.set(v.address.toLowerCase(), { id: key, name: v.name, attack: v.attack });
  }

  const [{ bids, asks, truncated }, block, ts] = await Promise.all([readBook(POOL, DEPTH), currentBlock(), now()]);
  const all = [...bids.map((o) => ({ ...o, side: 'bid' })), ...asks.map((o) => ({ ...o, side: 'ask' }))];
  const codeMap = await codehashesFor(all.map((o) => o.owner), getCode);

  // Lock windows + unlockAt for attested owners (same policy as firmness.mjs).
  const lockCache = new Map();
  const unlockAtCache = new Map();
  for (const [addr, { codehash }] of codeMap) {
    if (!set.has(codehash.toLowerCase())) continue;
    try {
      const ret = await ethCall(addr, UNLOCK_AT_SEL);
      const u = ret && ret !== '0x' ? parseInt(ret, 16) : 0;
      unlockAtCache.set(addr, u);
      lockCache.set(addr, u > ts);
    } catch { lockCache.set(addr, false); }
  }

  let total = 0n; const sums = { FIRM: 0n, PULLABLE: 0n, UNVERIFIED: 0n };
  const counts = { FIRM: 0, PULLABLE: 0, UNVERIFIED: 0 };
  const owners = {};
  const orders = all.map((o) => {
    const key = o.owner.toLowerCase();
    const { code, codehash } = codeMap.get(key);
    const lockOk = lockCache.get(key) ?? true;
    const c = attestedClassify(code, set, lockOk);
    const naive = naiveClassify(code);
    total += o.quantityRemaining;
    sums[c.class] += o.quantityRemaining;
    counts[c.class]++;
    if (!owners[key]) {
      const label = labels.get(key) || null;
      owners[key] = {
        address: o.owner,
        codehash,
        codeBytes: code === '0x' ? 0 : (code.length - 2) / 2,
        class: c.class,
        reason: c.reason,
        naiveClass: naive.class,
        analyzerReason: c.class === 'UNVERIFIED' ? (analyze(code).reason || null) : null,
        unlockAt: unlockAtCache.get(key) ?? null,
        label,
      };
    }
    return {
      orderId: o.orderId.toString(),
      side: o.side,
      owner: o.owner,
      price: o.price.toString(),
      fullQuantity: o.fullQuantity.toString(),
      quantityRemaining: o.quantityRemaining.toString(),
      expireTimestampNs: o.expireTimestampNs.toString(),
      class: c.class,
      reason: c.reason,
      naiveClass: naive.class,
    };
  });

  if (truncated) throw new Error(`book truncated at --depth ${DEPTH}; a partial book is not a firmness measurement.`);
  if (orders.length === 0) throw new Error('0 resting orders — an empty-book snapshot is vacuous; pin a populated block.');

  const pct = total === 0n ? 0 : Number((sums.FIRM * 10000n) / total) / 100;
  const attested = [...set.entries()].map(([hash, rec]) => ({ codehash: hash, name: rec.name, source: `S0 ${dep.S0.address} runtime code, read at the pinned block` }));

  const snapshot = {
    _provenance: {
      generatedAt: new Date().toISOString(),
      generatedBy: 'node site/viewer/make-snapshot.mjs --block ' + block,
      reproduce: `node script/firmness.mjs --block ${block}`,
      rpc: SHANNON_RPC,
      pinned: isPinned(),
      note: 'Every value below is read or derived from Somnia Shannon chain state at the pinned block. Owner labels are attached only where the on-chain owner address matches a recorded rampart corpus deployment (script/corpus.deployed.json).',
    },
    chainId: dep._meta.chain,
    pool: POOL,
    market: dep._meta.market,
    collateral: dep._meta.collateral,
    explorer: dep._meta.explorer,
    block,
    blockTimestamp: ts,
    counts: { orders: orders.length, bids: bids.length, asks: asks.length, distinctOwners: codeMap.size, ...counts },
    units: { firm: sums.FIRM.toString(), pullable: sums.PULLABLE.toString(), unverified: sums.UNVERIFIED.toString(), total: total.toString() },
    firmPct: pct,
    attestedSet: attested,
    owners,
    orders,
  };

  const json = JSON.stringify(snapshot, null, 2);
  const outPath = join(HERE, `book-${block}.json`);
  writeFileSync(outPath, json + '\n');
  console.log(`wrote ${outPath} (${json.length + 1} bytes)`);
  console.log(`  block ${block} · ${orders.length} orders (${bids.length} bid / ${asks.length} ask) · FIRM ${counts.FIRM} · PULLABLE ${counts.PULLABLE} · UNVERIFIED ${counts.UNVERIFIED} · firm ${pct}%`);

  // Inject the same JSON inline into index.html so the page renders over file://.
  const page = join(HERE, 'index.html');
  if (existsSync(page)) {
    const html = readFileSync(page, 'utf8');
    const open = '<script id="snapshot" type="application/json">';
    const close = '</script><!-- /snapshot -->';
    const a = html.indexOf(open); const b = html.indexOf(close);
    if (a < 0 || b < 0) throw new Error('index.html has no snapshot markers — cannot inject.');
    writeFileSync(page, html.slice(0, a + open.length) + '\n' + json + '\n' + html.slice(b));
    console.log('  injected inline into index.html between snapshot markers');
  } else {
    console.log('  index.html not present yet — JSON only');
  }
}

main().catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
