// The static bytecode policy — the off-chain half of the classifier.
//
// It disassembles RUNTIME bytecode (respecting PUSH immediates, which a naive
// substring scan cannot) and applies the FIRM_CAPABLE policy from the spec:
//
//   1. DELEGATECALL count == 0   (else behaviour is unbounded regardless of hash — A3, A2)
//   2. SELFDESTRUCT count == 0   (belt-and-braces over EIP-6780 — A5)
//   3. no CREATE / CREATE2       (no spawning a privileged helper)
//   4. no forbidden 4-byte selector anywhere in the runtime, at any byte alignment —
//      cancelOrder, reduceOrder, setOperator*, approveBuilder (A1, A4, quiet-reduce)
//   5. no EIP-1967 impl/beacon slot constant, no EIP-1167 minimal-proxy prologue (A2)
//
// ─────────────────────────────────────────────────────────────────────────────
// HONEST LIMITATION — READ THIS BEFORE TRUSTING A VERDICT.
//
// This policy is NECESSARY, NOT SUFFICIENT. A `FIRM_CAPABLE` verdict is a filter
// result, not a proof of irrevocability, and it must NEVER be the sole gate on an
// attestation. Concretely, the policy is defeatable:
//
//   * ARITHMETIC SELECTOR CONSTRUCTION. `analyze()` can only see selector bytes
//     that literally appear in the runtime. A contract that computes the selector
//     at runtime — `add(0xdbc91395, 1)` in Yul, then `mstore(shl(224, sel))` and
//     `call(...)` — calls `cancelOrder(uint128)` while the four bytes `dbc91396`
//     are nowhere in its code. Such a contract passes every clause below and is
//     still fully withdrawable. This is proven, not hypothetical: see the
//     `StealthCancel` case in the 2026-08-26 audit.
//   * ARBITRARY CALL. Clause 3 bans CREATE, but `CALL` itself cannot be banned —
//     FirmQuote must call `pool.placeOrder`. Any CALL with memory-built calldata
//     is an unbounded action that static analysis cannot constrain.
//   * LINEAR DISASSEMBLY. `disassemble()` sweeps from pc 0 and cannot follow
//     jumps, so it cannot in general distinguish code from jump-reachable data.
//
// No static scan over a language permitting arbitrary CALL can be made sound.
// Therefore: attestation is a HUMAN-REVIEWED TRANSPARENCY LIST. `analyze()` is
// the cheap pre-filter that rejects the obvious escapes before a human looks; a
// green verdict is a precondition for review, never a substitute for it.
// ─────────────────────────────────────────────────────────────────────────────

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

// Real solc CBOR metadata is ~50-60 bytes (ipfs+solc) or ~30 (bzzr). A declared
// length far above that is not metadata — it is an attacker asking us to stop
// disassembling early. Cap the strip at a plausible bound and flag the attempt.
export const MAX_PLAUSIBLE_METADATA = 128;

/**
 * Strip the Solidity CBOR metadata trailer before opcode analysis.
 *
 * The last 2 bytes are the big-endian length L of the CBOR metadata that
 * precedes them; the final L+2 bytes are unreachable data, not code, and
 * disassembling them as opcodes yields spurious hits (a stray 0xff reads as
 * SELFDESTRUCT). We strip them for the POLICY, but the attested code hash is
 * always taken over the FULL runtime — that is what on-chain EXTCODEHASH commits
 * to. Stripping only affects which opcodes the policy sees, never the identity.
 *
 * SECURITY: `L` is attacker-controlled. A contract that declares a huge L would
 * excise live, jump-reachable code from the opcode scan while keeping it
 * executable. We therefore refuse to strip an implausible length, and report it.
 *
 * @returns {{ code: string, stripped: number, suspicious: boolean }}
 */
export function stripMetadata(hexLower) {
  const bytes = hexLower.length / 2;
  if (bytes < 4) return { code: hexLower, stripped: 0, suspicious: false };
  const lenHi = parseInt(hexLower.slice(-4, -2), 16);
  const lenLo = parseInt(hexLower.slice(-2), 16);
  const metaLen = (lenHi << 8) | lenLo;
  const total = metaLen + 2;
  if (metaLen > 0 && metaLen < bytes && total < bytes) {
    if (metaLen > MAX_PLAUSIBLE_METADATA) {
      // Do NOT strip — scan the whole thing rather than let the trailer hide code.
      return { code: hexLower, stripped: 0, suspicious: true };
    }
    return { code: hexLower.slice(0, (bytes - total) * 2), stripped: total, suspicious: false };
  }
  return { code: hexLower, stripped: 0, suspicious: false };
}

/**
 * Scan the FULL runtime for forbidden selector bytes at ANY byte alignment.
 *
 * The PUSH4-immediate scan alone is trivially evaded: the ordinary Yul idiom for
 * building calldata is `mstore(shl(224, sel))`, which the compiler emits as a
 * PUSH32 with the selector left-aligned in the word — no PUSH4 anywhere. Scanning
 * raw bytes catches every LITERAL occurrence regardless of how it is pushed, and
 * regardless of whether it sits in the region a metadata trailer claims.
 *
 * This does NOT catch a selector computed arithmetically — see the header. It is
 * a strictly wider net than PUSH4, not a sound one.
 */
export function scanForbiddenLiterals(hexLower) {
  const hits = [];
  for (const sel of Object.keys(FORBIDDEN_SELECTORS)) {
    const needle = sel.slice(2);
    for (let i = 0; i + needle.length <= hexLower.length; i += 2) {
      if (hexLower.startsWith(needle, i)) {
        hits.push({ selector: sel, name: FORBIDDEN_SELECTORS[sel], offset: i / 2, where: 'literal' });
        break;
      }
    }
  }
  return hits;
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
  const meta = stripMetadata(full);
  const h = meta.code;
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
        forbiddenHits.push({ selector: sel, name: FORBIDDEN_SELECTORS[sel], where: 'push4' });
      }
    }
  }

  // Wider net: the same selectors as raw bytes anywhere in the FULL runtime, at
  // any alignment. Catches `PUSH32 <sel left-aligned>` (the normal Yul idiom) and
  // anything hidden behind a metadata trailer. Union with the PUSH4 hits.
  for (const lit of scanForbiddenLiterals(full)) {
    if (!forbiddenHits.find((f) => f.selector === lit.selector)) forbiddenHits.push(lit);
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
  if (meta.suspicious) reasons.push(`implausible metadata length (>${MAX_PLAUSIBLE_METADATA}B) — possible scan-evasion trailer`);

  const verdict = reasons.length === 0 ? 'FIRM_CAPABLE' : 'REJECTED';

  return {
    analyzerVersion: '1.1.0',
    // Identity = keccak256 of the FULL runtime, matching on-chain EXTCODEHASH.
    codehash: keccakHex(full),
    codeSize: full.length / 2,
    opcodeHistogram: histogram,
    forbiddenSelectors: forbiddenHits,
    proxyIndicators,
    metadata: { stripped: meta.stripped, suspicious: meta.suspicious },
    verdict,
    // A pass is a PRE-FILTER result, never a proof. Carried in the record itself so
    // no downstream consumer can read FIRM_CAPABLE as "proven irrevocable".
    guarantee: verdict === 'FIRM_CAPABLE' ? 'necessary-not-sufficient: requires human review before attestation' : undefined,
    // TRUE when the contract can call out with runtime-built calldata. Static
    // analysis cannot bound such a call — the residual risk the header describes.
    unboundedCallSurface: histogram.CALL > 0 || histogram.STATICCALL > 0,
    reason: reasons.length ? reasons.join('; ') : undefined,
  };
}
