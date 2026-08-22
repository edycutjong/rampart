// The adversarial corpus definition, plus loaders for both runtime sources:
//   - OFFLINE: `out/<C>.sol/<C>.json` deployedBytecode (immutables zeroed) — deterministic.
//   - LIVE:    `eth_getCode(address)` for a real deployment — the judged path.
//
// Truth table the classifier is scored against. UNVERIFIED is not a failure to
// classify — it is the correct, load-bearing answer for un-attested code.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getCode } from './rpc.mjs';
import { keccakHex } from './keccak.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', '..');

export const CORPUS = [
  { id: 'S0', name: 'FirmQuote', artifact: 'FirmQuote', attack: 'none', expected: 'FIRM' },
  { id: 'S1', name: 'HiddenCancel', artifact: 'HiddenCancel', attack: 'hidden cancel path (A1)', expected: 'UNVERIFIED' },
  { id: 'S2', name: 'Erc1967Proxy', artifact: 'Erc1967Proxy', attack: 'EIP-1967 upgradeable proxy (A2)', expected: 'UNVERIFIED' },
  { id: 'S3', name: 'DelegateEscape', artifact: 'DelegateEscape', attack: 'DELEGATECALL escape (A3)', expected: 'UNVERIFIED' },
  { id: 'S4', name: 'OperatorGranter', artifact: 'OperatorGranter', attack: 'late operator grant (A4)', expected: 'UNVERIFIED' },
  { id: 'S5', name: 'QuietReduce', artifact: 'QuietReduce', attack: 'quiet reduce, no fill (A5)', expected: 'UNVERIFIED' },
  { id: 'S6', name: 'BatchCancel', artifact: 'BatchCancel', attack: 'cancel via alternate selector', expected: 'UNVERIFIED' },
  { id: 'S7', name: 'EOA (plain wallet)', artifact: null, attack: 'n/a — trivially cancels', expected: 'PULLABLE' },
];

/** Runtime bytecode from the local Foundry artifact (offline, deterministic). */
export function artifactRuntime(artifact) {
  if (!artifact) return '0x'; // EOA
  const p = join(BUILD, 'out', `${artifact}.sol`, `${artifact}.json`);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return '0x' + j.deployedBytecode.object.replace(/^0x/, '');
}

/** The deployed-address map written by deploy-corpus.mjs, or null if none yet. */
export function loadDeployment() {
  const p = join(BUILD, 'script', 'corpus.deployed.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Runtime bytecode + codehash for a live deployed address. */
export async function liveRuntime(addr, url) {
  const code = await getCode(addr, url);
  return { code, codehash: keccakHex(code) };
}
