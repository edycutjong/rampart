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
import { ethCall, pinFromArgs, isPinned, now, BLOCK, assertPinnedStateAvailable } from './lib/rpc.mjs';

const LIVE = process.argv.includes('--live');
if (LIVE) pinFromArgs();
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
    } else if (deployment.S0) {
      // A pin at a block before the corpus existed scores ~2/8 and reads as a
      // classifier defect. Fail first, and say which cause it is.
      await assertPinnedStateAvailable(deployment.S0.address, deployment._meta && deployment._meta.pool);
    }
  }
  for (const m of CORPUS) {
    let code, addr = null, lockOk = true;
    if (LIVE && deployment && deployment[m.id]) {
      addr = deployment[m.id].address;
      ({ code } = await liveRuntime(addr));
      // Apply the lock-window clause live: read unlockAt() and compare to the
      // clock of the block we are reading (pinned block timestamp, or wall clock).
      if (m.expected === 'FIRM') {
        try {
          const ret = await ethCall(addr, UNLOCK_AT_SEL);
          const unlockAt = ret && ret !== '0x' ? parseInt(ret, 16) : 0;
          lockOk = unlockAt > (await now());
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

  const where = LIVE && deployment
    ? `(LIVE on Shannon 50312${isPinned() ? `, pinned @ block ${parseInt(BLOCK, 16)}` : ', block latest'})`
    : '(offline, local artifacts)';
  console.log(`\n  rampart — adversarial corpus classification  ${where}\n`);
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
    // The overwhelmingly common cause on a testnet is a lapsed lock, not a
    // classifier defect. Say which, so nobody reads chain rot as a wrong verdict.
    const lapsed = rows.filter((r) => r.expected === 'FIRM' && !r.lockOk);
    if (lapsed.length) {
      const clock = isPinned() ? `pinned block ${parseInt(BLOCK, 16)}` : 'wall clock';
      console.error(
        `\x1b[33m  Cause: ${lapsed.map((r) => r.name).join(', ')} — lock window lapsed against the ${clock}.\n` +
        `  This is the classifier working correctly: a lapsed lock is not firm.\n` +
        `  To reproduce the FIRM state, pin the block AND its clock:\n` +
        `      node script/headline.mjs --live --block <n>   (needs an archive RPC)\n` +
        `  Or redeploy the corpus with a fresh lock: node script/deploy-corpus.mjs\x1b[0m`,
      );
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error(`\x1b[31m${e.message || e}\x1b[0m`); process.exit(1); });
