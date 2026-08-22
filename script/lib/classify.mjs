// The classifier core, shared by every off-chain script.
//
// TWO classifiers over the same inputs, so the comparison is apples-to-apples:
//
//   attestedClassify — the product. FIRM only if EXTCODEHASH is in the attested
//     set AND the owner is still inside its lock window. Un-attested code is
//     UNVERIFIED; a wallet is PULLABLE.
//
//   naiveClassify — the strawman the spec warns about. FIRM iff EXTCODESIZE > 0.
//     This is what every "is the owner a contract?" check reduces to, and it is
//     forgeable: all five attackers have code, so all five read FIRM.

import { keccakHex } from './keccak.mjs';
import { analyze } from './analyzer.mjs';

export const EMPTY_CODEHASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';

/** Build the attested set: analyze each candidate's runtime code; keep FIRM_CAPABLE hashes. */
export function buildAttestedSet(candidates /* [{name, code}] */) {
  const set = new Map(); // codehash -> record
  for (const c of candidates) {
    const rec = analyze(c.code);
    if (rec.verdict === 'FIRM_CAPABLE') set.set(rec.codehash.toLowerCase(), { ...rec, name: c.name });
  }
  return set;
}

/**
 * The attested ternary classifier.
 * @param code runtime bytecode ('0x' for an EOA)
 * @param attestedSet Map<codehash, record>
 * @param lockOk whether the owner is inside its lock window (default true offline)
 */
export function attestedClassify(code, attestedSet, lockOk = true) {
  const codehash = keccakHex(code || '0x');
  if (codehash.toLowerCase() === EMPTY_CODEHASH) return { class: 'PULLABLE', codehash, reason: 'EOA — no code' };
  const rec = attestedSet.get(codehash.toLowerCase());
  if (!rec) {
    const a = analyze(code);
    return { class: 'UNVERIFIED', codehash, reason: a.reason || 'code hash not attested' };
  }
  if (!lockOk) return { class: 'UNVERIFIED', codehash, reason: 'attested but lock window has lapsed' };
  return { class: 'FIRM', codehash, reason: 'attested + locked' };
}

/** The naive EXTCODESIZE strawman: any code at all reads FIRM. */
export function naiveClassify(code) {
  const has = code && code !== '0x' && code.length > 2;
  return { class: has ? 'FIRM' : 'PULLABLE', codehash: keccakHex(code || '0x') };
}
