# rampart engine

The off-chain half of [rampart](https://github.com/edycutjong/rampart), packaged as a
reusable library: type on-chain order-book liquidity on Somnia as
**FIRM / PULLABLE / UNVERIFIED** — or use the pieces on their own.

| Module | What it gives you |
|---|---|
| `keccak` | keccak-256 (Ethereum's, **not** NIST SHA3) + `selectorOf('cancelOrder(uint128)')` — pure JS, verified against `cast keccak` |
| `analyzer` | an EVM disassembler (PUSH-immediate aware) + the `FIRM_CAPABLE` static bytecode policy: no DELEGATECALL / SELFDESTRUCT / CREATE, no withdrawal or operator-grant selector, not a proxy |
| `classify` | the ternary classifier: attested-`EXTCODEHASH` set → FIRM · wallet → PULLABLE · anything else → UNVERIFIED (which makes *no claim* — that is the point) |
| `book` | zero-auth `BinaryPool` book reader via `getAllOpenOrdersOffChain` (bare `eth_call`, `msg.sender == 0`) with honest truncation reporting |
| `rpc` | raw JSON-RPC with retries **and block pinning** — pinned reads reproduce exactly against Somnia's archival public endpoint, including the block's own timestamp for lock-window math |

**Zero runtime dependencies.** Everything is re-derivable with nothing but Node ≥ 20 and
a public RPC endpoint. The hand-transcribed Somnia surface (selectors, the 8-field Order
struct) cannot rot silently: `script/sdk-verify.mjs` checks it against the real
`@somnia-chain/markets-sdk` (35 assertions) in CI — the SDK is a devDependency of the
repo, never of this library.

## Install

Not published to npm (yet). Install straight from the repo:

```bash
npm install github:edycutjong/rampart        # the package.json packs only script/lib/
# or, from a local clone:
npm pack && npm install ./rampart-firm-book-0.1.0.tgz
```

Then:

```js
import { analyze, attestedClassify } from 'rampart-firm-book';   // main entry
import { selectorOf } from 'rampart-firm-book/keccak';           // or per-module
```

## Example 1 — reject bytecode that hides a cancel path (offline)

The policy sees selectors however they are pushed. The ordinary Yul idiom
`mstore(shl(224, sel))` compiles to a PUSH32 with the selector left-aligned — no PUSH4
anywhere — and a naive "is it a contract?" check calls this firm:

```js
import { analyze } from 'rampart-firm-book';

// PUSH32 <cancelOrder selector, left-aligned> … CALL — no PUSH4 in sight.
const r = analyze('0x7fdbc91396' + '00'.repeat(28) + '5af100');
console.log(r.verdict);                  // REJECTED
console.log(r.forbiddenSelectors[0]);    // { selector: '0xdbc91396', name: 'cancelOrder(uint128)', … }
console.log(r.guarantee);                // undefined — only FIRM_CAPABLE records carry the caveat
```

A passing verdict is a **pre-filter, not a proof**: every `FIRM_CAPABLE` record carries
`guarantee: 'necessary-not-sufficient: requires human review before attestation'`, because a
selector built arithmetically at runtime evades any static scan. See *Honest limits*.

## Example 2 — derive and check 4-byte selectors (offline)

```js
import { selectorOf, keccakHex, FORBIDDEN_SELECTORS } from 'rampart-firm-book';

selectorOf('cancelOrder(uint128)');                 // '0xdbc91396'
selectorOf('IncorrectSender(address,address)');     // '0xf5e39c1f' — errors hash the same way
keccakHex('0x616263');                              // keccak256 of raw bytes ('abc')

// The policy's ban list maps selector → the signature it was derived from:
FORBIDDEN_SELECTORS['0x558a7297'];                  // 'setOperator(address,bool)' (ERC-6909)
```

Signatures must be **canonical** (no names, no spaces); `selectorOf` deliberately does not
normalise, because silently "fixing" a malformed signature computes a wrong selector with
confidence.

## Example 3 — read a live Somnia book and type every owner (network)

Pinned to a historical block so it reproduces byte-for-byte — Somnia's public RPC is
archival, and pinning also pins the *clock* the lock-window math uses:

```js
import { setBlock, readBook, codehashesFor, getCode, analyze } from 'rampart-firm-book';

setBlock(468201000);   // or: RAMPART_BLOCK=468201000, or --block via pinFromArgs()
const pool = '0x54d90260fe949940a80602e7fda8ebd729c5be00';   // BTC 24h window, Shannon

const { all, truncated } = await readBook(pool, 200);
const owners = await codehashesFor(all.map((o) => o.owner), getCode);

for (const [addr, { code }] of owners) {
  console.log(addr, code === '0x' ? 'EOA → PULLABLE' : analyze(code).verdict);
}
console.log(`${all.length} orders · truncated=${truncated}`);
```

Never quote a ratio over a book that reports `truncated: true` — the pool capped the read,
so the number would be a sample presented as a census. Raise `maxCount` instead.

## Honest limits

- **The static policy is necessary, not sufficient.** A contract can compute a forbidden
  selector arithmetically at runtime and pass every clause; `CALL` itself cannot be banned.
  Attestation therefore requires a human-reviewed transparency list — `analyze()` only
  rejects the obvious escapes first. No static scan over a language permitting arbitrary
  `CALL` can be made sound.
- **The disassembler is linear.** It sweeps from pc 0 respecting PUSH immediates; it does
  not follow jumps, so it cannot in general distinguish code from jump-reachable data.
- **The book reader is Somnia-shaped.** It decodes `BinaryPool.getAllOpenOrdersOffChain`'s
  fixed 8-field Order struct by word offset. The layout is CI-checked against the shipped
  SDK source, and the decoder fails loudly on a length mismatch — but it is not a generic
  ABI decoder.
- **Testnet-grade, unaudited.** Built for Somnia Shannon (chain 50312) during a hackathon.
  The keccak is verified against `cast keccak` on multiple block-boundary lengths and the
  classifier against a deployed adversarial corpus, but nothing here has had an external
  audit.

## License

MIT
