#!/usr/bin/env node
// Run the static bytecode policy over a contract's runtime code and print the
// signable attestation record. This is the off-chain half of the classifier —
// the reproducible analysis anyone can re-derive from the same bytes.
//
//   node script/analyze.mjs 0xDeployedAddress        # analyze live runtime code
//   node script/analyze.mjs --artifact FirmQuote     # analyze a local artifact
//   node script/analyze.mjs --corpus                 # analyze the whole corpus
//
// A FIRM_CAPABLE verdict is a NECESSARY condition for a code hash to be attested;
// it is not a proof of irrevocability. See the header of script/lib/analyzer.mjs.

import { analyze } from './lib/analyzer.mjs';
import { getCode } from './lib/rpc.mjs';
import { CORPUS, artifactRuntime, loadDeployment } from './lib/corpus.mjs';

function print(label, rec) {
  const v = rec.verdict === 'FIRM_CAPABLE' ? '\x1b[32mFIRM_CAPABLE\x1b[0m' : '\x1b[31mREJECTED\x1b[0m';
  console.log(`\n  ${label}`);
  console.log(`    verdict     ${v}${rec.reason ? '  — ' + rec.reason : ''}`);
  console.log(`    codehash    ${rec.codehash}`);
  console.log(`    size        ${rec.codeSize} bytes`);
  const h = rec.opcodeHistogram;
  console.log(`    opcodes     DELEGATECALL=${h.DELEGATECALL} SELFDESTRUCT=${h.SELFDESTRUCT} CREATE=${h.CREATE} CREATE2=${h.CREATE2} CALL=${h.CALL} STATICCALL=${h.STATICCALL}`);
  const p = rec.proxyIndicators;
  console.log(`    proxy       eip1967Impl=${p.eip1967Impl} eip1967Beacon=${p.eip1967Beacon} minimalProxy=${p.minimalProxy}`);
  if (rec.forbiddenSelectors.length) {
    console.log(`    forbidden   ${rec.forbiddenSelectors.map((f) => f.name).join(', ')}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--corpus') {
    const dep = loadDeployment();
    for (const m of CORPUS) {
      if (!m.artifact) { console.log(`\n  ${m.id} ${m.name}\n    (EOA — no code; classifies PULLABLE)`); continue; }
      const code = dep && dep[m.id] ? await getCode(dep[m.id].address) : artifactRuntime(m.artifact);
      print(`${m.id} ${m.name}  (${dep && dep[m.id] ? 'LIVE ' + dep[m.id].address : 'artifact'})`, analyze(code));
    }
    console.log('');
    return;
  }
  if (args[0] === '--artifact') {
    print(`artifact ${args[1]}`, analyze(artifactRuntime(args[1])));
    console.log('');
    return;
  }
  if (args[0] && args[0].startsWith('0x')) {
    const code = await getCode(args[0]);
    print(`address ${args[0]}`, analyze(code));
    console.log('');
    return;
  }
  console.log('usage: node script/analyze.mjs <0xAddress> | --artifact <Name> | --corpus');
}

main().catch((e) => { console.error(e); process.exit(1); });
