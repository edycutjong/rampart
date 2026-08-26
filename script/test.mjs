#!/usr/bin/env node
// Off-chain self-test: keccak vectors, the static policy verdict per corpus
// member, and the headline tally. Dependency-free, deterministic, offline.
//
//   node script/test.mjs

import assert from 'node:assert/strict';
import { keccak256, keccakHex } from './lib/keccak.mjs';
import { analyze, stripMetadata } from './lib/analyzer.mjs';
import { CORPUS, artifactRuntime } from './lib/corpus.mjs';
import { buildAttestedSet, attestedClassify, naiveClassify } from './lib/classify.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

console.log('\n  rampart off-chain self-test\n');

t('keccak256("") == empty codehash', () => {
  assert.equal(keccak256(new Uint8Array(0)), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
});
t('keccak256(0x616263) matches cast', () => {
  assert.equal(keccakHex('0x616263'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});

t('FirmQuote is FIRM_CAPABLE', () => {
  assert.equal(analyze(artifactRuntime('FirmQuote')).verdict, 'FIRM_CAPABLE');
});
t('HiddenCancel rejected on cancelOrder selector', () => {
  const r = analyze(artifactRuntime('HiddenCancel'));
  assert.equal(r.verdict, 'REJECTED');
  assert.ok(r.forbiddenSelectors.some((f) => f.name.startsWith('cancelOrder')));
});
t('Erc1967Proxy rejected on DELEGATECALL + eip1967 slot', () => {
  const r = analyze(artifactRuntime('Erc1967Proxy'));
  assert.equal(r.verdict, 'REJECTED');
  assert.ok(r.opcodeHistogram.DELEGATECALL > 0);
  assert.ok(r.proxyIndicators.eip1967Impl);
});
t('DelegateEscape rejected on DELEGATECALL', () => {
  const r = analyze(artifactRuntime('DelegateEscape'));
  assert.equal(r.verdict, 'REJECTED');
  assert.ok(r.opcodeHistogram.DELEGATECALL > 0);
});
t('OperatorGranter rejected on operator-grant selector', () => {
  const r = analyze(artifactRuntime('OperatorGranter'));
  assert.equal(r.verdict, 'REJECTED');
  assert.ok(r.forbiddenSelectors.some((f) => f.name.startsWith('setOperatorApproval')));
});
t('QuietReduce rejected on reduceOrder selector', () => {
  const r = analyze(artifactRuntime('QuietReduce'));
  assert.equal(r.verdict, 'REJECTED');
  assert.ok(r.forbiddenSelectors.some((f) => f.name.startsWith('reduceOrder')));
});
t('BatchCancel rejected on cancelOrders (alternate selector)', () => {
  const r = analyze(artifactRuntime('BatchCancel'));
  assert.equal(r.verdict, 'REJECTED');
  assert.ok(r.forbiddenSelectors.some((f) => f.name.startsWith('cancelOrders')));
});
t('metadata trailer does not create phantom opcodes', () => {
  // OperatorGranter has a 0xff in its CBOR metadata; stripped analysis sees SELFDESTRUCT=0.
  assert.equal(analyze(artifactRuntime('OperatorGranter')).opcodeHistogram.SELFDESTRUCT, 0);
});

// ── Analyzer evasion regressions (2026-08-26 audit, finding F-1/F-3) ─────────
// The PUSH4-only scan was defeatable by the ordinary Yul calldata idiom. These
// pin the wider literal scan so the evasion cannot silently return.

t('EVASION: PUSH32 left-aligned selector is rejected (not just PUSH4)', () => {
  // `mstore(shl(224, sel))` compiles to PUSH32 <sel><28 zero bytes> — no PUSH4.
  const code = '0x7f' + 'dbc91396' + '00'.repeat(28) + '5af100';
  const r = analyze(code);
  assert.equal(r.verdict, 'REJECTED', 'left-aligned PUSH32 selector must not pass');
  assert.ok(r.forbiddenSelectors.some((f) => f.selector === '0xdbc91396'));
});

t('EVASION: oversized metadata trailer cannot hide code from the scan', () => {
  // Declare a 512-byte "metadata" trailer over a body containing a real PUSH4.
  // Body must be longer than the declared length or the sanity guard short-circuits.
  const body = '63' + 'dbc91396' + '5af1' + '00'.repeat(1200);
  const r = analyze('0x' + body + '0200');
  assert.equal(r.verdict, 'REJECTED', 'code behind a fake trailer must still be scanned');
  assert.ok(r.metadata.suspicious, 'an implausible metadata length must be flagged');
});

t('stripMetadata refuses an implausible length and reports it', () => {
  const long = '60ff'.repeat(400); // 800 bytes of body
  assert.equal(stripMetadata(long + '0200').suspicious, true, '512B trailer is not solc metadata');
  // A plausible solc trailer (40B) still strips normally: 40 + 2 length bytes.
  const plausible = stripMetadata(long + '00'.repeat(40) + '0028');
  assert.equal(plausible.stripped, 42);
  assert.equal(plausible.suspicious, false);
});

t('HONEST LIMIT: an arithmetically-built selector still passes, and says so', () => {
  // PUSH4 0xdbc91395 + 1 == cancelOrder. The literal bytes never appear.
  const code = '0x63' + 'dbc91395' + '6001' + '01' + '60e01b' + '5af100';
  const r = analyze(code);
  assert.equal(r.verdict, 'FIRM_CAPABLE', 'documented residual: static scan cannot see this');
  assert.equal(r.forbiddenSelectors.length, 0);
  // The record must never let a consumer read this as a proof.
  assert.match(String(r.guarantee), /necessary-not-sufficient/);
  assert.equal(r.unboundedCallSurface, true);
});

t('every FIRM_CAPABLE record carries the necessary-not-sufficient caveat', () => {
  const r = analyze(artifactRuntime('FirmQuote'));
  assert.equal(r.verdict, 'FIRM_CAPABLE');
  assert.match(String(r.guarantee), /requires human review/);
});

t('headline: attested perfect, naive 2 on the full corpus', () => {
  const rows = CORPUS.map((m) => ({ ...m, code: artifactRuntime(m.artifact) }));
  const set = buildAttestedSet(rows.map((r) => ({ name: r.name, code: r.code })));
  let attested = 0, naive = 0;
  for (const r of rows) {
    if (attestedClassify(r.code, set, true).class === r.expected) attested++;
    if (naiveClassify(r.code).class === r.expected) naive++;
  }
  assert.equal(attested, CORPUS.length, 'attested must be perfect');
  assert.equal(attested, 8); // FirmQuote + 6 attackers + EOA
  assert.equal(naive, 2); // only the pure-firm and pure-EOA ends
});

t('only FirmQuote is in the attested set', () => {
  const rows = CORPUS.map((m) => ({ name: m.name, code: artifactRuntime(m.artifact) }));
  const set = buildAttestedSet(rows);
  assert.equal(set.size, 1);
});

console.log(`\n  ${n} passed\n`);
