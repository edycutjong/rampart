#!/usr/bin/env node
// BENCH GATE (spec §6.2 · definition-of-done): full-book retype p95 must sit
// inside one 100 ms Somnia block, or the firmness metric cannot claim to be live.
//
//   node script/bench.mjs [--pool 0x..] [--n 200] [--depth 200] [--scale 2000]
//
// What is measured, honestly:
//   cold hydrate  — one-time: read both book sides + EXTCODEHASH every DISTINCT
//                   owner (memoised). Network-bound; NOT the per-block cost.
//   retype        — the per-block recompute: for every resting order, look up its
//                   owner's cached class (owner→codehash→class is memoised, the
//                   spec's "EXTCODEHASH calls after memoisation: N of M orders")
//                   and aggregate the firmness %. This is what runs each 100 ms
//                   block; no network is on this path.
//   refresh       — reported for context: one live re-read of the book (network).
//
// The live testnet book is small and perishable, so the SYNTHETIC stress book is
// generated DETERMINISTICALLY (fixed owners, fixed quantities, fixed 3:1 firm mix)
// rather than by replicating live orders. That is deliberate: the published p95
// must reproduce on any machine on any day, including when the testnet pool has
// cycled and the live book is empty. The 100 ms budget is checked against the
// synthetic p95 always, and against the live p95 when a live book exists.

import { performance } from 'node:perf_hooks';
import { getCode, currentBlock, ethCall, pinFromArgs, isPinned, now } from './lib/rpc.mjs';
import { readBook, codehashesFor } from './lib/book.mjs';
import { buildAttestedSet, attestedClassify } from './lib/classify.mjs';
import { loadDeployment } from './lib/corpus.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const POOL = arg('--pool', process.env.POOL || '0x54d90260fe949940a80602e7fda8ebd729c5be00');
const N = Number(arg('--n', '200'));
const DEPTH = Number(arg('--depth', '200'));
const SCALE = Number(arg('--scale', '2000'));
const BLOCK_MS = 100;
const UNLOCK_AT_SEL = '0xaa5dec6f';
pinFromArgs();

const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const ms = (x) => x.toFixed(2).padStart(7);

/** Memoise owner→class once (the codehash is already computed at hydrate). */
async function ownerClassMap(codeMap, set) {
  const m = new Map();
  for (const [addr, { code, codehash }] of codeMap) {
    let lockOk = true;
    if (set.has(codehash.toLowerCase())) {
      try {
        const ret = await ethCall(addr, UNLOCK_AT_SEL);
        lockOk = (ret && ret !== '0x' ? parseInt(ret, 16) : 0) > (await now());
      } catch { lockOk = false; }
    }
    m.set(addr, attestedClassify(code, set, lockOk).class);
  }
  return m;
}

/** One retype pass over a snapshot of {q, owner}: pure lookups + bigint adds. */
function retypeOnce(snapshot, ownerClass) {
  let total = 0n, firm = 0n;
  for (const o of snapshot) {
    total += o.q;
    if (ownerClass.get(o.owner) === 'FIRM') firm += o.q;
  }
  return total === 0n ? 0 : Number((firm * 10000n) / total) / 100;
}

/**
 * A deterministic synthetic book: SCALE orders over 64 owners, exactly 1 in 4
 * classed FIRM, quantities from a fixed LCG. No chain reads, no Math.random —
 * the same input on every machine, so the published p95 is reproducible even
 * when the testnet pool has cycled. Measures the same pure lookup+bigint path
 * `retypeOnce` runs each block.
 */
function syntheticSnapshot(scale) {
  const OWNERS = 64;
  const ownerClass = new Map();
  const owners = [];
  for (let i = 0; i < OWNERS; i++) {
    const addr = '0x' + i.toString(16).padStart(40, '0');
    owners.push(addr);
    ownerClass.set(addr, i % 4 === 0 ? 'FIRM' : (i % 4 === 1 ? 'PULLABLE' : 'UNVERIFIED'));
  }
  const snapshot = [];
  let seed = 0x9e3779b9; // fixed seed — deterministic across runs and machines
  for (let i = 0; i < scale; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    snapshot.push({ q: BigInt(1 + (seed % 10_000)), owner: owners[seed % OWNERS] });
  }
  return { snapshot, ownerClass };
}

function benchSnapshot(snapshot, ownerClass, n) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    retypeOnce(snapshot, ownerClass);
    samples.push(performance.now() - s);
  }
  return { p50: pct(samples, 50), p95: pct(samples, 95), max: Math.max(...samples) };
}

async function main() {
  // ── SYNTHETIC: deterministic, offline, always runs. This is the number we publish.
  const syn = syntheticSnapshot(SCALE);
  const stress = benchSnapshot(syn.snapshot, syn.ownerClass, N);

  // ── LIVE: best-effort. A cycled testnet pool must not fake a pass, or hide one.
  /** @type {{ timing: any, book: any, owners: number, hydrateMs: number, refreshMs: number } | null} */
  let live = null;
  let liveErr = null;
  try {
    const dep = loadDeployment();
    if (!dep || !dep.S0) {
      // FirmQuote has 4 immutables → the artifact hash can never equal a live hash.
      // Attesting it would silently class every real order UNVERIFIED (audit F-6).
      throw new Error('no script/corpus.deployed.json — run deploy-corpus.mjs for the live half');
    }
    const set = buildAttestedSet([{ name: 'FirmQuote', code: await getCode(dep.S0.address) }]);

    const t0 = performance.now();
    const book = await readBook(POOL, DEPTH);
    const codeMap = await codehashesFor(book.all.map((o) => o.owner), getCode);
    const hydrateMs = performance.now() - t0;
    const ownerClass = await ownerClassMap(codeMap, set);

    const rs = performance.now();
    await readBook(POOL, DEPTH);
    const refreshMs = performance.now() - rs;

    if (book.all.length === 0) throw new Error(`0 resting orders on ${POOL} — the pool has cycled`);
    const timing = benchSnapshot(
      book.all.map((o) => ({ q: o.quantityRemaining, owner: o.owner.toLowerCase() })),
      ownerClass, N,
    );
    live = { timing, book, owners: codeMap.size, hydrateMs, refreshMs };
  } catch (e) {
    liveErr = e.message || String(e);
  }

  const block = await currentBlock();
  console.log(`\n  rampart bench — full-book retype  ·  pool ${POOL}  ·  block ${block}${isPinned() ? ' (pinned)' : ''}\n`);
  console.log(`  samples                ${N}\n`);

  console.log(`  SYNTHETIC book (${SCALE} orders, deterministic — reproducible on any machine)`);
  console.log(`    retype p50        ${ms(stress.p50)} ms`);
  console.log(`    retype p95        ${ms(stress.p95)} ms`);
  console.log(`    retype max        ${ms(stress.max)} ms\n`);

  if (live) {
    const b = live.book;
    console.log(`  LIVE book (${b.all.length} orders: ${b.bids.length} bid / ${b.asks.length} ask)`);
    console.log(`    distinct owners   ${live.owners}   (EXTCODEHASH calls after memoisation: ${live.owners} of ${b.all.length})`);
    console.log(`    cold hydrate (net)${ms(live.hydrateMs)} ms   both sides + EXTCODEHASH per distinct owner`);
    console.log(`    refresh      (net)${ms(live.refreshMs)} ms   one live book re-read`);
    console.log(`    retype p50        ${ms(live.timing.p50)} ms`);
    console.log(`    retype p95        ${ms(live.timing.p95)} ms`);
    console.log(`    retype max        ${ms(live.timing.max)} ms`);
    if (b.truncated) console.log(`    \x1b[33mNOTE: book truncated at --depth ${DEPTH}; live figures are a sample.\x1b[0m`);
  } else {
    console.log(`  LIVE book            \x1b[33mnot measured — ${liveErr}\x1b[0m`);
    console.log(`                       (pin a populated block with --block <n>, or redeploy the corpus)`);
  }

  // Only measured numbers gate. An unmeasured live book is reported, never scored:
  // a p95 of 0.00 ms over 0 orders is not a pass (LESSONS R10 — a check that
  // cannot fail is not a check).
  const measured = live ? Math.max(live.timing.p95, stress.p95) : stress.p95;
  const ok = measured <= BLOCK_MS;
  console.log(`\n  100 ms block budget: retype p95 ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} (worst measured p95 ${ms(measured)} ms ${ok ? '<=' : '>'} ${BLOCK_MS} ms)`);
  console.log(`  scored on: ${live ? 'synthetic + live' : 'synthetic only'}\n`);
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(`\x1b[31m${e.message || e}\x1b[0m`); process.exit(1); });
