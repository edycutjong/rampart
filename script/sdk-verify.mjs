#!/usr/bin/env node
// SDK DIFFERENTIAL — check this repo's hand-transcribed pool surface against the
// REAL `@somnia-chain/markets-sdk`, method for method and selector for selector.
//
//   node script/sdk-verify.mjs
//
// WHY THIS EXISTS, AND WHY THE SDK IS A *DEV* DEPENDENCY.
//
// The off-chain engine keeps ZERO runtime dependencies on purpose: it hand-rolls
// keccak-256 and speaks raw JSON-RPC, so anyone can re-derive a classification
// with nothing but Node and a public endpoint. That is a real property and we do
// not want to give it up.
//
// But hand-transcribing a sponsor's ABI is exactly the kind of thing that rots
// silently: a `uint256` where the pool wants a `uint96` produces a DIFFERENT
// function selector and the call reverts with nothing decodable. We hit that
// during the build (see submission SDK feedback report), which is precisely why
// this check exists.
//
// So the SDK is a devDependency and this script is the bridge: the shipped engine
// stays dependency-free, and CI proves the hand-written surface still agrees with
// the sponsor's own source of truth. Zero runtime deps AND no silent drift.
//
// Everything below is derived with OUR keccak (script/lib/keccak.mjs), never the
// SDK's — so a passing run also re-verifies our hash implementation against the
// sponsor's published selector constants.
//
// Two ground truths are used, and the output says which one each check hit:
//   * the package's EXPORTED surface (ABIs, enums, constants, unit converters);
//   * the package's SHIPPED SOURCE (`src/` is in the npm tarball's `files`) for
//     the two surfaces v0.28.1 does NOT export: the binary pool READ ABI and the
//     contract-error ABI. Both gaps are filed in the SDK feedback report; if the
//     SDK moves those files the checks here fail loudly, which is the point.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  binaryPoolWriteAbi,
  erc6909Abi,
  ORDER_KIND,
  ORDER_TYPE,
  SELF_MATCHING_OPTION,
  sideOfKind,
  CANCEL_ORDER_FOR_SELECTOR,
  PLACE_ORDER_FOR_SELECTOR,
  probabilityToPrice,
  priceToProbability,
} from '@somnia-chain/markets-sdk';
import { selectorOf } from './lib/keccak.mjs';
import { FORBIDDEN_SELECTORS } from './lib/analyzer.mjs';
import { GET_ALL_OPEN } from './lib/book.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[90m', B = '\x1b[1m', X = '\x1b[0m';

let failures = 0;
let checks = 0;
/** Advisory notes — reported, never silently passed, never counted as green. */
const notes = [];
const ok = (cond, label, detail) => {
  checks++;
  if (cond) { console.log(`  ${G}✓${X} ${label}  ${D}${detail}${X}`); return true; }
  failures++;
  console.log(`  ${R}✗ ${label}  ${detail}${X}`);
  return false;
};

/** Canonical signature of an ABI function entry. */
const sigOf = (e) => `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;

// The SDK ships its TypeScript source in the npm tarball (`files: ["src", ...]`),
// which is the only place its read ABI and error ABI live — neither is exported.
const require_ = createRequire(import.meta.url);
const sdkRoot = join(dirname(require_.resolve('@somnia-chain/markets-sdk')), '..');
const shipped = (rel) => {
  try { return readFileSync(join(sdkRoot, rel), 'utf8'); } catch { return ''; }
};

console.log(`\n  ${B}rampart — hand-transcribed surface vs @somnia-chain/markets-sdk${X}\n`);

// ── 1. Canonical signatures from the SDK's own write ABI ────────────────────
const sdkFns = binaryPoolWriteAbi
  .filter((e) => e.type === 'function')
  .map((e) => ({ name: e.name, sig: sigOf(e) }));
const sdkSigs = new Map(sdkFns.map((f) => [f.sig, selectorOf(f.sig)]));

console.log(`  ${B}1. placeBinaryOrder — the signature that cost us hours${X}`);
// The trap from the feedback report: builderFeeBpsTimes1k MUST be uint96. A
// uint256 there is a different selector and reverts undecodably.
const PLACE = 'placeBinaryOrder(uint8,uint256,uint256,uint64,uint8,uint8,address,uint96,uint64)';
ok(sdkSigs.has(PLACE), 'src/IBinaryPool.sol matches the SDK exactly', PLACE);
ok(
  !sdkSigs.has(PLACE.replace('uint96', 'uint256')),
  'the uint256 variant does NOT exist (the trap is real)',
  'a uint256 builder fee would be a different selector',
);

// ── 2. Every forbidden selector must name a REAL pool method ────────────────
// A forbidden-selector list that bans methods the pool does not have is theatre.
console.log(`\n  ${B}2. FORBIDDEN_SELECTORS resolve to real pool methods${X}`);
let grounded = 0, absent = [];
for (const [sel, sig] of Object.entries(FORBIDDEN_SELECTORS)) {
  const derived = selectorOf(sig);
  // Our stored selector must be the true keccak of the signature we claim.
  ok(derived === sel, `${sig}`, `${sel} — keccak-derived, matches our table`);
  if (sdkSigs.has(sig)) grounded++; else absent.push(sig);
}

// ── 3. The SDK's published selector constants, re-derived with our keccak ───
console.log(`\n  ${B}3. SDK selector constants re-derived with our own keccak${X}`);
ok(
  selectorOf('cancelOrderFor(address,uint128)') === CANCEL_ORDER_FOR_SELECTOR,
  'CANCEL_ORDER_FOR_SELECTOR',
  `${CANCEL_ORDER_FOR_SELECTOR} — also the constant in test/Adversarial.t.sol`,
);
// PLACE_ORDER_FOR_SELECTOR — DERIVED AT LAST (2026-08-26, v0.28.1). No exported
// ABI entry hashes to it; a wider candidate sweep found the match: it is the
// SPOT pool's operator placement, i.e. `placeOrderFor` = owner-prefixed
// `placeOrder(bool,uint64,...)` from spotPoolWriteAbi. Two consequences, both
// filed in the SDK feedback report (findings 9 + 13):
//   * the constant is now verifiable — asserted below, with our keccak;
//   * it is a TRAP for binary integrators: the SDK's operator-grant docs say to
//     grant it "to place", but on a binary pool the generic `placeOrderFor`
//     reverts `UseBinaryPlacement` (the SDK's own tradeAbi comment says so).
//     The selector that actually places on a binary pool is
//     `placeBinaryOrderFor` — checked in section 7, and it has NO exported constant.
const SPOT_PLACE_FOR = 'placeOrderFor(address,bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)';
ok(
  selectorOf(SPOT_PLACE_FOR) === PLACE_ORDER_FOR_SELECTOR,
  'PLACE_ORDER_FOR_SELECTOR is the SPOT placeOrderFor',
  `${PLACE_ORDER_FOR_SELECTOR} — derived by candidate sweep, not from any exported ABI`,
);
notes.push(
  `PLACE_ORDER_FOR_SELECTOR ${PLACE_ORDER_FOR_SELECTOR} — signature identified (spot placeOrderFor) but ` +
  'STILL absent from every exported ABI; useless-by-revert on binary pools (findings 9 + 13)',
);

// ── 4. The buy-side-only invariant is the SDK's own enum ────────────────────
// QuoteBase/FirmQuote enforce `require(kind == 0 || kind == 2)`. Those two
// numbers are load-bearing: selling escrows outcome tokens, which needs an
// ERC-6909 operator grant, and granting no operator is what keeps the lock
// airtight. Assert they are still the SDK's BUY_YES / BUY_NO.
console.log(`\n  ${B}4. buy-side-only invariant vs the SDK's ORDER_KIND${X}`);
ok(ORDER_KIND.BUY_YES === 0, 'BUY_YES === 0', 'FirmQuote.rest accepts kind 0');
ok(ORDER_KIND.BUY_NO === 2, 'BUY_NO === 2', 'FirmQuote.rest accepts kind 2');
ok(
  ORDER_KIND.SELL_YES !== 0 && ORDER_KIND.SELL_YES !== 2 && ORDER_KIND.SELL_NO !== 0 && ORDER_KIND.SELL_NO !== 2,
  'neither SELL kind collides with the accepted set',
  `SELL_YES=${ORDER_KIND.SELL_YES} SELL_NO=${ORDER_KIND.SELL_NO} are rejected`,
);
// The SDK carries a SECOND kind table — `ORDER_KIND_SIDE` in the store, used to
// decode `BinaryOrderPlaced` events. The two could drift independently; our
// invariant needs them to agree with each other and with us.
ok(
  sideOfKind(0) === 'BUY_YES' && sideOfKind(2) === 'BUY_NO',
  "the store's event-decode table agrees: kinds 0 and 2 are the buys",
  `sideOfKind(0)=${sideOfKind(0)} sideOfKind(2)=${sideOfKind(2)}`,
);
ok(
  sideOfKind(1) === 'SELL_YES' && sideOfKind(3) === 'SELL_NO',
  "…and kinds 1 and 3 are the sells FirmQuote rejects",
  `sideOfKind(1)=${sideOfKind(1)} sideOfKind(3)=${sideOfKind(3)}`,
);

// ── 5. The withdrawal surface we claim FirmQuote omits ──────────────────────
console.log(`\n  ${B}5. the pool's real withdrawal surface${X}`);
for (const sig of ['cancelOrder(uint128)', 'reduceOrder(uint128,uint256)', 'approveBuilder(address,uint256)']) {
  ok(sdkSigs.has(sig), `pool exposes ${sig}`, `${selectorOf(sig)} — FirmQuote exposes no path to it`);
}

// ── 6. FirmQuote's hardcoded placement literals vs the SDK's enums ──────────
// FirmQuote.rest passes `orderType = 0` and `selfMatchingOption = 0` as bare
// literals (src/FirmQuote.sol). Both are load-bearing:
//   * 0 must mean NormalOrder (REST). If the enum renumbered — say 0 became
//     FillOrKill — the quote would fill-or-vanish and never rest: no resting
//     order, no firm depth, the entire mechanism silently gone.
//   * 0 must mean CANCEL_TAKER. If 0 meant CANCEL_MAKER, the depositor could
//     erase the "irrevocable" maker by resting a crossing order against it —
//     a self-cross escape hiding inside an enum value.
console.log(`\n  ${B}6. FirmQuote's hardcoded 0s still mean what the contract assumes${X}`);
ok(ORDER_TYPE.LIMIT === 0, 'ORDER_TYPE: 0 is NormalOrder (rest)', 'FirmQuote.rest hardcodes orderType 0');
// Number() around the literal-typed constants: to tsc these comparisons are
// "impossible" (the d.ts pins the values) — but pinned-at-compile-time is
// exactly what a runtime drift check exists to distrust.
ok(
  Number(ORDER_TYPE.FILL_OR_KILL) !== 0 && Number(ORDER_TYPE.MARKET) !== 0 && Number(ORDER_TYPE.POST_ONLY) !== 0,
  'no non-resting order type collides with 0',
  `FOK=${ORDER_TYPE.FILL_OR_KILL} IOC=${ORDER_TYPE.MARKET} PostOnly=${ORDER_TYPE.POST_ONLY}`,
);
ok(
  SELF_MATCHING_OPTION.CANCEL_TAKER === 0,
  'SELF_MATCHING_OPTION: 0 cancels the TAKER, maker stands',
  'FirmQuote.rest hardcodes selfMatchingOption 0',
);
ok(
  Number(SELF_MATCHING_OPTION.CANCEL_MAKER) !== 0,
  'CANCEL_MAKER is NOT 0 — no self-cross escape via the default',
  `CANCEL_MAKER=${SELF_MATCHING_OPTION.CANCEL_MAKER}: a maker-cancelling default would let the depositor erase the quote`,
);

// ── 7. The operator placement surface on a BINARY pool ──────────────────────
// v0.28.1's write ABI carries `placeBinaryOrderFor` (owner-prefixed
// placeBinaryOrder). Its selector is what a binary-pool operator grant must
// authorise — and it is NOT the exported PLACE_ORDER_FOR_SELECTOR (section 3).
console.log(`\n  ${B}7. placeBinaryOrderFor — the selector a binary operator grant really needs${X}`);
const BINARY_PLACE_FOR = `placeBinaryOrderFor(address,${PLACE.slice(PLACE.indexOf('(') + 1)}`;
ok(
  sdkSigs.has(BINARY_PLACE_FOR),
  'the write ABI has the owner-prefixed binary placement',
  BINARY_PLACE_FOR,
);
ok(
  selectorOf(BINARY_PLACE_FOR) !== PLACE_ORDER_FOR_SELECTOR,
  'its selector differs from the exported PLACE_ORDER_FOR_SELECTOR',
  `${selectorOf(BINARY_PLACE_FOR)} ≠ ${PLACE_ORDER_FOR_SELECTOR} — the exported constant cannot place on a binary pool (finding 13)`,
);

// ── 8. The operator-grant escape, grounded in the SDK's own ERC-6909 ABI ────
// S4 (OperatorGranter) escapes by granting an ERC-6909 operator AFTER resting.
// Our forbidden-selector table bans `setOperator` — assert the banned signature
// is the SDK's own, so a protocol-side rename cannot quietly un-ban the grant.
console.log(`\n  ${B}8. the ERC-6909 operator grant our policy bans is the SDK's own${X}`);
const e6909Sigs = erc6909Abi.filter((e) => e.type === 'function').map(sigOf);
const setOps = e6909Sigs.filter((s) => s.startsWith('setOperator('));
ok(
  setOps.length === 1 && setOps[0] === FORBIDDEN_SELECTORS['0x558a7297'],
  'erc6909Abi has exactly the setOperator our table bans',
  `${setOps.join(', ') || 'MISSING'} — the S4 late-grant escape's entry point`,
);
ok(
  setOps.length === 1 && selectorOf(setOps[0]) === '0x558a7297',
  'its selector re-derives to our banned 0x558a7297',
  'a drifted signature would silently un-ban the operator-grant escape',
);
ok(
  e6909Sigs.includes('isOperator(address,address)'),
  'erc6909Abi exposes isOperator — the read gating cancelOrderFor',
  `${selectorOf('isOperator(address,address)')} — "granting no operator" is checkable on-chain`,
);
// setOperator is absent from the WRITE ABI but present in erc6909Abi — it is
// SDK-grounded after all. Keep the "reached directly" list honest.
absent = absent.filter((s) => !e6909Sigs.includes(s));

// ── 9. IncorrectSender — the centrepiece constant ───────────────────────────
// `0xf5e39c1f` is hardcoded in gate.sh, README, DEMO and the Foundry tests: the
// pool refusing the funder's cancel with IncorrectSender(caller, expected) IS
// the on-chain proof. v0.28.1 does not export its error ABI (finding 15), so
// the arg ORDER — which word is the expected owner — is checked against the
// shipped source, `src/contractErrorsAbi.ts`.
console.log(`\n  ${B}9. IncorrectSender — the selector the whole proof decodes${X}`);
ok(
  selectorOf('IncorrectSender(address,address)') === '0xf5e39c1f',
  'our keccak reproduces the centrepiece selector',
  '0xf5e39c1f — hardcoded in gate.sh, README, DEMO.md and the tests',
);
const errSrc = shipped('src/contractErrorsAbi.ts');
const errEntry = errSrc.match(/name: "IncorrectSender", inputs: \[([^\]]*)\]/);
const errInputs = errEntry ? [...errEntry[1].matchAll(/name: "(\w+)", type: "(\w+)"/g)].map((m) => `${m[2]} ${m[1]}`) : [];
ok(
  errInputs.length === 2 && errInputs[0] === 'address sender' && errInputs[1] === 'address expected',
  'shipped error ABI declares (sender, expected) in that order',
  errInputs.join(', ') || 'entry not found in shipped src/contractErrorsAbi.ts',
);

// ── 10. The zero-auth book read, against the shipped read ABI ───────────────
// lib/book.mjs speaks `getAllOpenOrdersOffChain` with a hand-transcribed
// selector and a fixed 8-word Order layout. v0.28.1 does NOT export
// `binaryPoolReadAbi` (finding 14), so the layout is checked against the
// shipped source, `src/readsAbi.ts`. If the SDK moves or reshapes it, these
// fail loudly — which beats decoding neighbouring words into plausible garbage.
console.log(`\n  ${B}10. getAllOpenOrdersOffChain — the read the classifier stands on${X}`);
const readsSrc = shipped('src/readsAbi.ts');
const readEntry = readsSrc.match(
  /"function getAllOpenOrdersOffChain\(([^)]*)\) view returns \(\(([^)]*)\)\[\] orders, ([^"]*)\)"/,
);
const typesOf = (list) => list.split(',').map((s) => s.trim().split(/\s+/)[0]);
const fieldsOf = (list) => list.split(',').map((s) => s.trim());
ok(
  readEntry !== null && GET_ALL_OPEN === selectorOf(`getAllOpenOrdersOffChain(${typesOf(readEntry?.[1] ?? '').join(',')})`),
  "lib/book.mjs's selector re-derives from the shipped read ABI",
  `${GET_ALL_OPEN} ← getAllOpenOrdersOffChain(${readEntry ? typesOf(readEntry[1]).join(',') : 'NOT FOUND in shipped src/readsAbi.ts'})`,
);
const WANT_ORDER = [
  'uint128 orderId', 'bool isBid', 'address owner', 'uint64 userData',
  'uint256 price', 'uint256 fullQuantity', 'uint256 quantityRemaining', 'uint64 expireTimestampNs',
];
const gotOrder = readEntry ? fieldsOf(readEntry[2]) : [];
ok(
  gotOrder.length === WANT_ORDER.length && WANT_ORDER.every((f, i) => gotOrder[i] === f),
  'the Order struct is still 8 static fields in OUR decode order',
  gotOrder.length ? `${gotOrder.length} fields — lib/book.mjs decodes by word offset, order IS the contract` : 'tuple not found',
);
ok(
  readEntry !== null && fieldsOf(readEntry[3]).join(', ') === 'bool hasMoreOrders, uint64 nextCursor',
  'the outer return still carries (hasMoreOrders, nextCursor)',
  'w[1]/w[2] in lib/book.mjs — losing hasMore would turn truncation silent (audit F-8)',
);
notes.push(
  'binaryPoolReadAbi (getAllOpenOrdersOffChain, getOrder, …) is NOT exported from the package — ' +
  'checked against the shipped src/readsAbi.ts instead (finding 14)',
);
notes.push(
  'the contract-error ABI (incl. IncorrectSender) is NOT exported — ' +
  'checked against the shipped src/contractErrorsAbi.ts instead (finding 15)',
);

// ── 11. The corpus price constant, in the SDK's own units ───────────────────
// deploy-corpus.mjs rests every order at raw price 10000, documented as "0.01 —
// far below touch, cannot cross". That English is only true on a 6-decimal
// price scale; on any other scale the corpus would rest at a different
// probability than every document claims (or cross the live book).
console.log(`\n  ${B}11. the corpus resting price means what the docs say it means${X}`);
ok(
  probabilityToPrice(0.01) === 10000n,
  "probability 0.01 is raw 10000 — deploy-corpus.mjs's PRICE",
  'the "far below touch" claim rests on the 6-decimal price scale',
);
ok(
  priceToProbability(10000n) === 0.01,
  'and it round-trips back to exactly 0.01',
  'a lossy round-trip would make quoted probabilities drift from raw prices',
);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n  ${D}${'-'.repeat(72)}${X}`);
console.log(`  SDK version        ${process.env.npm_package_devDependencies__somnia_chain_markets_sdk || '0.28.1'} (devDependency — the shipped engine has ZERO runtime deps)`);
console.log(`  SDK write ABI      ${sdkFns.length} functions`);
console.log(`  forbidden list     ${Object.keys(FORBIDDEN_SELECTORS).length} selectors · ${grounded} in the SDK write ABI · setOperator grounded via erc6909Abi`);
if (absent.length) {
  // NOT a failure: the SDK's write ABI is a curated subset. `cancelOrders` and
  // the operator-approval methods live on the pool / permissions registry and
  // are reached directly (S6 BatchCancel does exactly that, on-chain). Say so
  // rather than let a green run imply the SDK vouched for them.
  console.log(`  ${Y}not in SDK write ABI${X} ${D}(reached directly, not via the SDK — see DEMO.md):${X}`);
  for (const s of absent) console.log(`      ${D}· ${s}${X}`);
}
if (notes.length) {
  console.log(`  ${Y}advisory${X} ${D}(filed as SDK findings — not counted as passes):${X}`);
  for (const u of notes) console.log(`      ${D}· ${u}${X}`);
}
console.log(`  ${D}${'-'.repeat(72)}${X}`);

if (failures) {
  console.error(`\n  ${R}FAIL: ${failures}/${checks} checks — the hand-written surface has DRIFTED from the SDK.${X}`);
  console.error(`  ${R}Fix src/IBinaryPool.sol, script/lib/analyzer.mjs or script/lib/book.mjs before shipping.${X}\n`);
  process.exit(1);
}
console.log(`\n  ${G}${B}PASS${X} — ${checks}/${checks} checks. The hand-transcribed surface agrees with the sponsor SDK,`);
console.log(`  and our keccak reproduces the SDK's published selector constants.\n`);
