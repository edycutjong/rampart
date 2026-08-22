#!/usr/bin/env node
// Off-chain self-test: keccak vectors, the static policy verdict per corpus
// member, and the headline tally. Dependency-free, deterministic, offline.
//
//   node script/test.mjs

import assert from 'node:assert/strict';
import { keccak256, keccakHex } from './lib/keccak.mjs';
import { analyze } from './lib/analyzer.mjs';
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
