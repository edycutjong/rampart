// The static bytecode policy — the off-chain half of the classifier.
//
// It disassembles RUNTIME bytecode (respecting PUSH immediates, which a naive
// substring scan cannot) and applies the FIRM_CAPABLE policy from the spec:
//
//   1. DELEGATECALL count == 0   (else behaviour is unbounded regardless of hash — A3, A2)
//   2. SELFDESTRUCT count == 0   (belt-and-braces over EIP-6780 — A5)
//   3. no CREATE / CREATE2       (no spawning a privileged helper)
//   4. no forbidden 4-byte selector as a PUSH4 immediate — cancelOrder, reduceOrder,
//      setOperator*, approveBuilder (A1, A4, quiet-reduce)
//   5. no EIP-1967 impl/beacon slot constant, no EIP-1167 minimal-proxy prologue (A2)
//
// HONEST LIMITATION, stated everywhere: this is a STATIC policy over runtime
// bytecode. It is sound for the five known escapes and is NOT a general proof of
// irrevocability. A selector assembled arithmetically at runtime would evade the
// PUSH4 scan — and gain nothing, because the code hash is simply never attested
// and the depth reads UNVERIFIED. Attestation is a whitelist, not a prover.

import { keccakHex } from './keccak.mjs';

// Forbidden function selectors (any withdrawal / operator-grant surface).
export const FORBIDDEN_SELECTORS = {
  '0xdbc91396': 'cancelOrder(uint128)',
  '0x0dce6933': 'cancelOrders(uint128[])',
  '0x33407b60': 'reduceOrder(uint128,uint256)',
  '0x7bbc67e6': 'setOperatorApprovalForPool(address,address,bytes4[],bool)',
  '0x7f1e31ce': 'setOperatorApprovalGlobal(address,bytes4[],bool)',
  '0x558a7297': 'setOperator(address,bool)',
  '0x605e0222': 'approveBuilder(address,uint256)',
};

// EIP-1967 implementation & beacon slots (present as PUSH32 immediates in a proxy).
const EIP1967_IMPL = '360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_BEACON = 'a3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

// EIP-1167 minimal proxy runtime prologue.
const MINIMAL_PROXY_PREFIX = '363d3d373d3d3d363d73';

/**
 * Strip the Solidity CBOR metadata trailer before opcode analysis.
 *
 * The last 2 bytes are the big-endian length L of the CBOR metadata that
 * precedes them; the final L+2 bytes are unreachable data, not code, and
 * disassembling them as opcodes yields spurious hits (a stray 0xff reads as
 * SELFDESTRUCT). We strip them for the POLICY, but the attested code hash is
 * always taken over the FULL runtime — that is what on-chain EXTCODEHASH commits
 * to. Stripping only affects which opcodes the policy sees, never the identity.
 */
export function stripMetadata(hexLower) {
  const bytes = hexLower.length / 2;
  if (bytes < 4) return hexLower;
  const lenHi = parseInt(hexLower.slice(-4, -2), 16);
  const lenLo = parseInt(hexLower.slice(-2), 16);
  const metaLen = (lenHi << 8) | lenLo;
  const total = metaLen + 2;
  if (metaLen > 0 && metaLen < bytes && total < bytes) {
    return hexLower.slice(0, (bytes - total) * 2);
  }
  return hexLower;
}

/** Disassemble runtime bytecode into opcodes, skipping PUSH immediate data. */
export function disassemble(hex) {
  const h = (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
  const code = new Uint8Array(h.length / 2);
  for (let i = 0; i < code.length; i++) code[i] = parseInt(h.substr(i * 2, 2), 16);
  const ops = [];
  let i = 0;
  while (i < code.length) {
    const op = code[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      const imm = code.slice(i + 1, i + 1 + n);
      ops.push({ pc: i, op, n, imm });
      i += 1 + n;
    } else {
      ops.push({ pc: i, op, n: 0, imm: new Uint8Array(0) });
      i += 1;
    }
  }
  return ops;
}

const toHex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Analyze runtime bytecode against the FIRM_CAPABLE policy.
 * @param {string} runtimeHex 0x-prefixed runtime bytecode
 * @returns a signable attestation record with a verdict
 */
export function analyze(runtimeHex) {
  const full = (runtimeHex.startsWith('0x') ? runtimeHex.slice(2) : runtimeHex).toLowerCase();
  // Policy runs over executable code (metadata stripped); identity is over the full runtime.
  const h = stripMetadata(full);
  const ops = disassemble(h);

  const histogram = { DELEGATECALL: 0, SELFDESTRUCT: 0, CALL: 0, STATICCALL: 0, CREATE: 0, CREATE2: 0, CALLCODE: 0 };
  const forbiddenHits = [];
  for (const { op, n, imm } of ops) {
    if (op === 0xf4) histogram.DELEGATECALL++;
    else if (op === 0xff) histogram.SELFDESTRUCT++;
    else if (op === 0xf1) histogram.CALL++;
    else if (op === 0xfa) histogram.STATICCALL++;
    else if (op === 0xf0) histogram.CREATE++;
    else if (op === 0xf5) histogram.CREATE2++;
    else if (op === 0xf2) histogram.CALLCODE++;
    // PUSH4 immediate that equals a forbidden selector.
    if (op === 0x63 && n === 4) {
      const sel = '0x' + toHex(imm);
      if (FORBIDDEN_SELECTORS[sel] && !forbiddenHits.find((f) => f.selector === sel)) {
        forbiddenHits.push({ selector: sel, name: FORBIDDEN_SELECTORS[sel] });
      }
    }
  }

  const proxyIndicators = {
    eip1967Impl: h.includes(EIP1967_IMPL),
    eip1967Beacon: h.includes(EIP1967_BEACON),
    minimalProxy: h.startsWith(MINIMAL_PROXY_PREFIX),
  };

  const reasons = [];
  // Empty runtime code is an EOA (or a non-existent account) — never a firm contract.
  if (full.length === 0) reasons.push('no runtime code (EOA or empty account)');
  if (histogram.DELEGATECALL > 0) reasons.push(`DELEGATECALL present (${histogram.DELEGATECALL})`);
  if (histogram.SELFDESTRUCT > 0) reasons.push(`SELFDESTRUCT present (${histogram.SELFDESTRUCT})`);
  if (histogram.CREATE > 0 || histogram.CREATE2 > 0) reasons.push(`CREATE/CREATE2 present`);
  if (histogram.CALLCODE > 0) reasons.push(`CALLCODE present`);
  for (const f of forbiddenHits) reasons.push(`forbidden selector ${f.name}`);
  if (proxyIndicators.eip1967Impl) reasons.push('EIP-1967 implementation slot');
  if (proxyIndicators.eip1967Beacon) reasons.push('EIP-1967 beacon slot');
  if (proxyIndicators.minimalProxy) reasons.push('EIP-1167 minimal proxy');

  const verdict = reasons.length === 0 ? 'FIRM_CAPABLE' : 'REJECTED';

  return {
    analyzerVersion: '1.0.0',
    // Identity = keccak256 of the FULL runtime, matching on-chain EXTCODEHASH.
    codehash: keccakHex(full),
    codeSize: full.length / 2,
    opcodeHistogram: histogram,
    forbiddenSelectors: forbiddenHits,
    proxyIndicators,
    verdict,
    reason: reasons.length ? reasons.join('; ') : undefined,
  };
}
