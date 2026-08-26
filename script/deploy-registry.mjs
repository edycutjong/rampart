#!/usr/bin/env node
// Deploy FirmnessRegistry to Shannon and attest the live FirmQuote code hash.
//
//   node script/deploy-registry.mjs [--attester 0x..] [--dry]
//   (key from PRIVATE_KEY, else ~/.config/rampart/shannon.key — same as deploy-corpus.mjs)
//
// WHY THIS EXISTS. Until now the ternary classifier ran only off-chain, in `script/`.
// The Solidity half was written and fully tested but had never touched a chain, which
// meant `classify(address)` was not something another protocol could actually call.
// Deploying it turns the classifier from an analysis script into a primitive.
//
// The attester is an IMMUTABLE constructor argument — there is no setter, by design, so
// the registry's honesty is auditable rather than governed. Choose it deliberately.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCode } from './lib/rpc.mjs';
import { keccakHex } from './lib/keccak.mjs';
import { analyze } from './lib/analyzer.mjs';
import { loadDeployment } from './lib/corpus.mjs';

const BUILD = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.SOMNIA_TESTNET_RPC || 'https://api.infra.testnet.somnia.network';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const DRY = process.argv.includes('--dry');

let KEY = process.env.PRIVATE_KEY;
if (!KEY) {
  const p = join(homedir(), '.config', 'rampart', 'shannon.key');
  if (existsSync(p)) KEY = readFileSync(p, 'utf8').trim();
}
if (!KEY) { console.error('PRIVATE_KEY unset and ~/.config/rampart/shannon.key not found'); process.exit(1); }

// Somnia bills gas in the millions; pin the price to base fee and cap the limit, or
// forge pads gasLimit so high that gasLimit*maxFee trips a false "insufficient balance".
const GP = ['--gas-price', '6000000000'];
const GL_DEPLOY = ['--gas-limit', '13000000'];
const GL_SEND = ['--gas-limit', '6000000'];

const cast = (args) => execFileSync('cast', args, { cwd: BUILD, encoding: 'utf8' }).trim();
const ME = cast(['wallet', 'address', '--private-key', KEY]);
const ATTESTER = arg('--attester', ME);

console.log(`\n  deployer  ${ME}`);
console.log(`  attester  ${ATTESTER}${ATTESTER === ME ? '  (same as deployer)' : ''}`);
console.log(`  rpc       ${RPC}`);
console.log(`  balance   ${cast(['balance', ME, '--rpc-url', RPC, '--ether'])} SOMI\n`);

// ── The thing we will attest: the LIVE FirmQuote runtime, not the artifact ─────
// FirmQuote has 4 immutables, so the local artifact hashes to something no deployment
// can ever present. The attestation must bind to code that actually exists on-chain.
const dep = loadDeployment();
if (!dep || !dep.S0) { console.error('script/corpus.deployed.json missing S0'); process.exit(1); }
const s0 = dep.S0.address;
const code = await getCode(s0);
if (!code || code === '0x') { console.error(`S0 ${s0} has no code`); process.exit(1); }

const rec = analyze(code);
if (rec.verdict !== 'FIRM_CAPABLE') { console.error(`S0 is ${rec.verdict} — refusing to attest`); process.exit(1); }
const codehash = rec.codehash;
// The record hash commits to the FULL attestation JSON, so the published reasoning
// cannot be swapped after the fact. Anyone can re-derive it from the same bytecode.
const recordJson = JSON.stringify(rec);
// TextEncoder, not Buffer: the engine's lint treats Node-only globals as undeclared,
// and UTF-8 encoding is byte-identical either way (verified before this swap, so the
// hash already attested on-chain still recomputes exactly).
const recordHash = keccakHex('0x' + Array.from(new TextEncoder().encode(recordJson)).map((b) => b.toString(16).padStart(2, '0')).join(''));

console.log(`  S0        ${s0}`);
console.log(`  verdict   ${rec.verdict}  (${rec.codeSize} bytes)`);
console.log(`  guarantee ${rec.guarantee}`);
console.log(`  codehash  ${codehash}`);
console.log(`  record    ${recordHash}\n`);

if (DRY) { console.log('  --dry: nothing sent.\n'); process.exit(0); }

// ── Deploy ────────────────────────────────────────────────────────────────────
console.log('  deploying FirmnessRegistry…');
// Deployment is `forge create`, not `cast create` — cast has no such subcommand.
// Same invocation shape deploy-corpus.mjs uses.
const forge = (args) => execFileSync('forge', args, { cwd: BUILD, encoding: 'utf8' }).trim();
const created = JSON.parse(forge([
  'create', 'src/FirmnessRegistry.sol:FirmnessRegistry',
  '--rpc-url', RPC, '--private-key', KEY, '--broadcast', '--json', ...GP, ...GL_DEPLOY,
  '--constructor-args', ATTESTER,
]));
const registry = created.deployedTo;
console.log(`  ✓ ${registry}   tx ${created.transactionHash}`);

// ── Attest ────────────────────────────────────────────────────────────────────
console.log('  attesting the live FirmQuote code hash…');
const attestTx = JSON.parse(cast([
  'send', registry, 'attest(bytes32,bytes32)', codehash, recordHash,
  '--rpc-url', RPC, '--private-key', KEY, '--json', ...GP, ...GL_SEND,
])).transactionHash;
console.log(`  ✓ tx ${attestTx}`);

// ── Verify ON CHAIN, not from what we just sent ───────────────────────────────
const isAttested = cast(['call', registry, 'isAttested(bytes32)(bool)', codehash, '--rpc-url', RPC]);
const active = cast(['call', registry, 'activeCount()(uint256)', '--rpc-url', RPC]);
const cls = cast(['call', registry, 'classify(address)(uint8,bytes32,uint64)', s0, '--rpc-url', RPC]);
console.log(`\n  isAttested(codehash)  ${isAttested}`);
console.log(`  activeCount()         ${active}`);
console.log(`  classify(S0)          ${cls.split('\n').join(' · ')}   [class 0 PULLABLE · 1 UNVERIFIED · 2 FIRM]`);

const out = join(BUILD, 'script', 'registry.deployed.json');
writeFileSync(out, JSON.stringify({
  _meta: {
    chain: 50312,
    rpc: RPC,
    explorer: 'https://shannon-explorer.somnia.network',
    note: 'FirmnessRegistry deployed and seeded with the live FirmQuote (S0) code hash. '
        + 'The attester is immutable — there is no setter. The attested record hash commits to '
        + "analyze()'s full JSON output, so the published reasoning cannot be swapped later. "
        + 'Attestation is a human-reviewed transparency list: a FIRM_CAPABLE verdict is a '
        + 'necessary pre-filter, never a proof of irrevocability (see DEMO.md, Honest limits).',
  },
  registry, attester: ATTESTER, deployTx: created.transactionHash,
  attested: { subject: 'S0 FirmQuote', address: s0, codehash, recordHash, attestTx },
  analyzerRecord: rec,
}, null, 2) + '\n');
console.log(`\n  wrote script/registry.deployed.json\n`);
