#!/usr/bin/env node
// THE HEADLINE NUMBER (spec §4 item 4 · LESSONS R8).
//
// One command, one verifiable comparison:
//
//   the attested classifier types the whole adversarial corpus correctly;
//   the naive EXTCODESIZE classifier is fooled by every contract-based attack.
//
// Run offline (deterministic, from local artifacts):
//   node script/headline.mjs
// Run live (reads EXTCODEHASH straight off Shannon for the deployed corpus):
//   node script/headline.mjs --live
//
// --live requires script/corpus.deployed.json (written by deploy-corpus.mjs).

import { CORPUS, artifactRuntime, loadDeployment, liveRuntime } from './lib/corpus.mjs';
import { buildAttestedSet, attestedClassify, naiveClassify } from './lib/classify.mjs';
import { ethCall } from './lib/rpc.mjs';

const LIVE = process.argv.includes('--live');
const UNLOCK_AT_SEL = '0xaa5dec6f'; // unlockAt()

function pad(s, n) { return String(s).padEnd(n); }
const COL = { FIRM: '\x1b[32m', PULLABLE: '\x1b[33m', UNVERIFIED: '\x1b[90m', R: '\x1b[0m', BAD: '\x1b[31m' };
const tag = (c) => `${COL[c] || ''}${pad(c, 11)}${COL.R}`;

async function collect() {
  const rows = [];
  let deployment = null;
  if (LIVE) {
    deployment = loadDeployment();
    if (!deployment) {
      console.error('--live needs script/corpus.deployed.json (run deploy-corpus.mjs first). Falling back to offline.');
    }
  }
  for (const m of CORPUS) {
    let code, addr = null, lockOk = true;
    if (LIVE && deployment && deployment[m.id]) {
      addr = deployment[m.id].address;
      ({ code } = await liveRuntime(addr));
      // Apply the lock-window clause live: read unlockAt() and compare to now.
      if (m.expected === 'FIRM') {
        try {
          const ret = await ethCall(addr, UNLOCK_AT_SEL);
          const unlockAt = ret && ret !== '0x' ? parseInt(ret, 16) : 0;
          lockOk = unlockAt > Math.floor(Date.now() / 1000);
        } catch { lockOk = true; }
      }
    } else {
      code = artifactRuntime(m.artifact);
    }
    rows.push({ ...m, code, addr, lockOk });
  }
  return { rows, deployment };
}

async function main() {
  const { rows, deployment } = await collect();
  // Attested set = every corpus member the static policy accepts (only FirmQuote).
  const attestedSet = buildAttestedSet(rows.map((r) => ({ name: r.name, code: r.code })));

  console.log(`\n  rampart — adversarial corpus classification  ${LIVE && deployment ? '(LIVE on Shannon 50312)' : '(offline, local artifacts)'}\n`);
  console.log(`  ${pad('#', 3)}${pad('owner', 20)}${pad('attack', 34)}${pad('expected', 12)}${pad('attested', 12)}${pad('naive EXTCODESIZE', 18)}`);
  console.log('  ' + '-'.repeat(96));

  let attestedScore = 0, naiveScore = 0;
  for (const r of rows) {
    const a = attestedClassify(r.code, attestedSet, r.lockOk);
    const nv = naiveClassify(r.code);
    const aOk = a.class === r.expected;
    const nOk = nv.class === r.expected;
    if (aOk) attestedScore++;
    if (nOk) naiveScore++;
    const aMark = aOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const nMark = nOk ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`  ${pad(r.id, 3)}${pad(r.name, 20)}${pad(r.attack, 34)}${pad(r.expected, 12)}${aMark} ${tag(a.class)}${nMark} ${tag(nv.class)}`);
  }
  const n = rows.length;
  console.log('  ' + '-'.repeat(96));
  console.log(`\n  ATTESTED CLASSIFIER:  \x1b[32m${attestedScore}/${n}\x1b[0m   (types every escape as UNVERIFIED — no false FIRM)`);
  console.log(`  NAIVE  EXTCODESIZE :  \x1b[31m${naiveScore}/${n}\x1b[0m   (fooled by every contract-based attack)\n`);

  const escapes = rows.filter((r) => r.expected === 'UNVERIFIED').length;
  console.log(`  ${escapes} attacker contracts, each looking FIRM to the naive check, each with a real escape.`);
  if (LIVE && deployment) {
    console.log(`  Classified from EXTCODEHASH read live off Shannon. Executed escapes: script/corpus.deployed.json + DEMO.md.`);
  } else {
    console.log(`  Run with --live to classify the deployed corpus by EXTCODEHASH read off-chain.`);
  }
  console.log('');

  if (attestedScore !== n) {
    console.error(`\x1b[31mFAIL: attested classifier scored ${attestedScore}/${n}, expected ${n}/${n}.\x1b[0m`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
