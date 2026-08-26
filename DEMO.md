<p align="center">
  <img src="site/assets/icon-animated.svg" width="96" height="96"
       alt="rampart mark — a cancel strikes the resting quote and bounces off it">
</p>

# rampart — on-chain proof

**Somnia Shannon testnet · chain 50312 · 2026-08-19**

Everything below is a real transaction on a public chain. Nothing is mocked, replayed, or
reconstructed. The centrepiece is a transaction that **failed**, which is exactly the point.

---

## The claim

> A resting order owned by a contract with no cancel path cannot be withdrawn — **not even by the
> wallet that paid for it.**

## The proof, in one call

```
$ cast call 0x1b8ed538…67ee "cancelOrder(uint128)" 129127208515966879685 \
    --from 0xFbc73Ce1…3595                      # the funder's own wallet

execution reverted, data:
  0xf5e39c1f
  000000000000000000000000fbc73ce1c0b43f87cd065f82df24697dec653595   ← caller   (the funder)
  0000000000000000000000002a09b4c474828e6895af273e51ba8c181c91191a   ← expected (FirmQuote)

$ cast 4byte 0xf5e39c1f
IncorrectSender(address,address)
```

**The pool names both parties in its own revert data.** It knows the order belongs to the contract,
and it refuses the wallet that funded it.

### The control that makes it rigorous

The same call, from the contract's address instead:

```
$ cast call 0x1b8ed538…67ee "cancelOrder(uint128)" 129127208515966879685 \
    --from 0x2a09b4c4…191a                      # FirmQuote itself
0x                                              # no revert — it WOULD succeed
```

So the refusal is **not** "this order is uncancellable in general." The pool would happily let its
owner cancel. The owner is a contract that has **no code path to ask** — and that is the entire
mechanism.

---

## Addresses and transactions

| | |
|---|---|
| **FirmQuote** | [`0x2a09b4c474828e6895af273e51Ba8C181c91191a`](https://shannon-explorer.somnia.network/address/0x2a09b4c474828e6895af273e51Ba8C181c91191a) |
| Funder EOA | [`0xFbc73Ce1C0B43f87cD065f82df24697dEc653595`](https://shannon-explorer.somnia.network/address/0xFbc73Ce1C0B43f87cD065f82df24697dEc653595) |
| BinaryPool | [`0x1b8ed5380a4741df019acf5faa0ce6ecbf6167ee`](https://shannon-explorer.somnia.network/address/0x1b8ed5380a4741df019acf5faa0ce6ecbf6167ee) (BTC 24h window) |
| Market | `0x99dA40550333409b5Ca4FfB7D2240c52Dd841a1b` · status 1 (Trading) |
| Collateral | tUSDC `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`, 6 dp |

| # | What | Tx |
|---|---|---|
| 1 | tUSDC faucet | [`0xa102e201…0081`](https://shannon-explorer.somnia.network/tx/0xa102e2010b3c3bb5c21c4d76ce05746676c7b332fee36709fcdaf95a34b60081) |
| 2 | Contract places an order (crossed and **filled** at ~0.163) | [`0x35dade18…92cd`](https://shannon-explorer.somnia.network/tx/0x35dade18d0e93bbe6b683dd5c687b033e6706ba2ada7f861b5515f455a8192cd) |
| 3 | Contract places a **resting** order at 0.01 (order `…9685`) | [`0xfb15e947…aa69`](https://shannon-explorer.somnia.network/tx/0xfb15e947cb9f82a9e770298aef8ee6ef6f84ac7bf018d5d09dbf92b5a034aa69) |
| 4 | **The funder tries to cancel it — status `0x0`, REVERTED** | [`0x959b4770…6ddb`](https://shannon-explorer.somnia.network/tx/0x959b47704d493dd48f2e724f2692facf1609a2cdc738f1a7ceb1fd070b3c6ddb) |

**Transaction 4 is the demo.** A failed transaction cannot be faked, mocked, or staged — it is a
permanent public record of the chain refusing its own funder.

---

## Why we ran it twice (and why the second run is the honest one)

The first order (tx 2) **crossed the book and filled instantly** — the limit was 0.50 and there were
asks below it. FirmQuote ended up holding 1,000,000 YES tokens.

That version of the test proves nothing. Cancelling a *filled* order fails for everyone; it says
nothing about firmness. So the run was repeated with a bid at 0.01, far below the touch, which
**cannot cross**:

| check | value | meaning |
|---|---|---|
| YES balance before / after | 1,000,000 → 1,000,000 | **no fill** — the order rested |
| tUSDC before / after | 4,837,000 → 4,827,000 | exactly **10,000** escrowed = 1.0 token × 0.01 |
| tUSDC after both cancel attempts | 4,827,000 | escrow **still locked** — nothing was released |

Order `…9685` was resting, with real escrow, when the cancel was refused. That is the claim, tested.

## Reproduce it

```bash
cd build
forge test                                   # 93 passing

export PRIVATE_KEY=0x…                       # a funded Shannon key
./gate.sh                                    # full deploy → rest → refuse sequence

# or verify the standing proof directly, no key needed, no gas:
cast call 0x1b8ed5380a4741df019acf5faa0ce6ecbf6167ee "cancelOrder(uint128)" \
  129127208515966879685 --from 0xFbc73Ce1C0B43f87cD065f82df24697dEc653595 \
  --block 465697720 --rpc-url https://api.infra.testnet.somnia.network
# → execution reverted, 0xf5e39c1f IncorrectSender(caller, expected)
#   caller   = 0xfbc73ce1c0b43f87cd065f82df24697dec653595
#   expected = 0x2a09b4c474828e6895af273e51ba8c181c91191a   ← the FirmQuote contract
```

The last command needs no wallet and no funds. Anyone can run it and watch the chain refuse.

`--block 465697720` pins the call to a block where the order was still resting; Somnia's public RPC
is archival, so no special endpoint is required. **Without** the pin the call still reverts with the
same `IncorrectSender` selector, but `expected` decodes to `0x00…00` — the order has since expired
out of the book, so you get the right selector attached to a weaker claim. We would rather you ran
the pinned version and saw the contract address named.

---

# The classifier and the adversarial corpus — 2026-08-22

The gate proved one contract's quote is un-withdrawable. The classifier answers the next
question for a *whole book*: **which resting depth is firm, and which only looks firm?**

## The defect it fixes

Typing a level FIRM because `EXTCODESIZE(owner) > 0` is **forgeable**. A contract can hide a
cancel, sit behind an upgradeable proxy, `DELEGATECALL` to attacker code, grant an operator
after resting, shrink itself with `reduceOrder`, or cancel through an alternate selector — all
while reading FIRM to a naive check. So Rampart classifies on **attested `EXTCODEHASH`** (a
keccak-256 commitment to exact runtime bytecode, EIP-1052) under a static policy. Unattested
code is **UNVERIFIED — no claim**. Every escape in the corpus mints UNVERIFIED depth, not FIRM.

The policy is a **pre-filter, not a prover**: `FIRM` means attested *and* locked, and attestation is
a human-reviewed transparency list. A selector computed arithmetically at runtime evades any static
bytecode scan, so a green `analyze()` gates review rather than replacing it. See "Honest limits".

## THE HEADLINE NUMBER — one command

```bash
node script/headline.mjs           # offline, deterministic, from local artifacts
node script/headline.mjs --live    # reads EXTCODEHASH live off Shannon for the deployed corpus
```

> **Attested classifier: 8/8.  Naive EXTCODESIZE classifier: 2/8.**

The corpus is the real `FirmQuote`, six attacker contracts that each look firm, and a plain EOA.
The attested classifier types every one correctly; the naive check is fooled by all six contract
attacks and gets only the two trivial ends (pure-firm, pure-EOA) right. The naive column is right
there in the same table, computed the same way, so the comparison is not rhetorical.

Each attacker is caught by a distinct policy check — verify with `node script/analyze.mjs --corpus`:

| # | Contract | Escape | Caught by | Verdict |
|---|---|---|---|---|
| S0 | `FirmQuote` | none | — clean | **FIRM** |
| S1 | `HiddenCancel` | hidden `cancelOrder` | forbidden selector `cancelOrder(uint128)` | UNVERIFIED |
| S2 | `Erc1967Proxy` | upgrade impl post-rest | `DELEGATECALL` + EIP-1967 slot | UNVERIFIED |
| S3 | `DelegateEscape` | `DELEGATECALL` to attacker | `DELEGATECALL` opcode | UNVERIFIED |
| S4 | `OperatorGranter` | late operator grant | forbidden `setOperatorApproval*` selector | UNVERIFIED |
| S5 | `QuietReduce` | `reduceOrder` shrinks depth | forbidden `reduceOrder(uint128,uint256)` | UNVERIFIED |
| S6 | `BatchCancel` | cancel via `cancelOrders[]` | forbidden `cancelOrders(uint128[])` | UNVERIFIED |
| S7 | EOA | trivially cancels | empty code hash | PULLABLE |

The analyzer's code hash **matches on-chain EXTCODEHASH exactly** (verified against `cast keccak $(cast code …)`),
so the attestation is genuinely content-addressed — it binds to code, not an address.

## The escapes, EXECUTED on Shannon (not just unit-tested)

Every attacker is deployed on Shannon and each escape was run as a real transaction. Full map with
all tx hashes: [`script/corpus.deployed.json`](script/corpus.deployed.json). Summary:

| # | Contract | On-chain result | Escape tx |
|---|---|---|---|
| S0 | [`0x8116c3a4…4B68`](https://shannon-explorer.somnia.network/address/0x8116c3a4DE042D4A215B532B7C4054F36e074B68) | **FIRM** — funder cancel reverted, order still rests | [cancel reverts](https://shannon-explorer.somnia.network/tx/0x29cdcb05bc2e74b43537e2161d04617182a1215733163ab63b82878aac531cd6) |
| S1 | [`0x29c3DFc1…60F9`](https://shannon-explorer.somnia.network/address/0x29c3DFc189Aa7d16fb6CD4eBb87662A49aDe60F9) | **pulled** — `poke()` cancelled it | [`0x424866fc…88f1b`](https://shannon-explorer.somnia.network/tx/0x424866fc54042d84a9dfbb59511fc59541f86951218cea8142d915965b588f1b) |
| S2 | [`0x099ad1d9…54c7`](https://shannon-explorer.somnia.network/address/0x099ad1d940c84b624a6101eCbF79ee1A83Ef54c7) | **pulled** — upgraded impl, then `pull()` | [`0x25bff36b…236c`](https://shannon-explorer.somnia.network/tx/0x25bff36b1b8ab05e90ee3c7bc164bb0a9f08f6a62378fcd75a736e5fab41236c) |
| S3 | [`0xc8C8e829…980d`](https://shannon-explorer.somnia.network/address/0xc8C8e829842CFeDa3c162ccC7e3917B3d375980d) | **pulled** — `escape()` delegatecalled a cancel | [`0x1e055e3e…1307`](https://shannon-explorer.somnia.network/tx/0x1e055e3e98eacc3ecffb1fd76a9208e3325823701495a467f5833dd7e70a1307) |
| S4 | [`0xa1316692…21F8`](https://shannon-explorer.somnia.network/address/0xa13166927BCF78d8E04f125d3ED0E8A076F021F8) | **grant executed** — pool then blocks the operator cancel (see below) | [grant](https://shannon-explorer.somnia.network/tx/0xbb39241cd2a06ef142f75398356d7a19ca82725786da05a38aea3780eac6664c) |
| S5 | [`0x797FE26F…49A7`](https://shannon-explorer.somnia.network/address/0x797FE26F8A6a65ea757347b71915119c49c049A7) | **pulled** — `trim()` shrank 2,000,000 → 1,000,000, no fill | [`0x9bc3f55b…9395`](https://shannon-explorer.somnia.network/tx/0x9bc3f55bfb559cef03246ff8a15a60c94af6beb73f7f7bd80cccc73e212f9395) |
| S6 | [`0xb3e60902…af54`](https://shannon-explorer.somnia.network/address/0xb3e609021C6839dF5A407d62D26Add74a2C8af54) | **rested**; `tidy()` gas-blocked (see below) | — |

**Five escapes execute a full on-chain withdrawal** (S1 hidden cancel, S2 proxy upgrade, S3
delegatecall, S5 quiet reduce), and S0's firm quote stands with its funder's cancel reverted.

## % of book that cannot be withdrawn — over the live market

```bash
node script/firmness.mjs                     # defaults to pool 0x54d9…be00 (ETH 24h)
node script/firmness.mjs --pool 0x…          # any currently-active binary pool
```

Reads the resting book via `getAllOpenOrdersOffChain`, takes each distinct owner's `EXTCODEHASH`,
classifies, and reports `Σ firm ÷ Σ displayed`. When measured on 2026-08-22 the number was **~0.1%**
— only the small attested `FirmQuote` was firm against a market-maker bot flooding the book with
UNVERIFIED depth. That low number is the honest point: **UNVERIFIED depth cannot masquerade as
firm**, so the metric never overstates. This observable exists on no off-chain exchange.

> **Running it today gives a different answer, and that is by design.** Shannon's binary pools cycle
> roughly every 24 h, so pool `0x54d9…be00` is now expired with an empty book. `firmness.mjs`
> **exits 1** on an empty book rather than printing `0%`: a ratio over zero orders is what *any*
> market returns, so reporting it as a result would be a check that cannot fail. Use
> `node script/find-pool.mjs` to get a live pool, or `--block <n>` against an archive RPC to
> reproduce a historical book. The deterministic, always-reproducible evidence is
> `node script/headline.mjs` (8/8 vs 2/8) and `forge test` (93/93).

## Bench gate — retype inside one 100 ms block

```bash
node script/bench.mjs --n 200 --scale 2000
```

Full-book retype (classify every order against memoised owner code hashes, aggregate the %):

| | p50 | p95 | max |
|---|---|---|---|
| **synthetic 2,000 orders** (deterministic) | 0.03 ms | **0.13 ms** | 0.42 ms |
| live book | *measured only when the pool has depth — see below* | | |

**p95 0.13 ms ≤ 100 ms block → PASS.** Network hydration (cold read + EXTCODEHASH per distinct
owner) is a separate ~2–3 s one-time cost, reported alongside; the per-block *retype* is what must
fit the block, and it does with nearly three orders of magnitude to spare.

The synthetic book is **generated deterministically** — 2,000 orders over 64 fixed owners, a 1-in-4
firm mix, quantities from a fixed-seed LCG — precisely so this number reproduces on any machine on
any day. It used to be built by replicating the *live* orders, which meant it silently became a
0-order benchmark reporting `p95 0.00 ms → PASS` once the testnet pool cycled. The live book is now
measured and reported when it exists and **excluded from the gate when it does not**, with the run
stating `scored on: synthetic only`. Small run-to-run variation in the third decimal is expected.

## Reproduce the whole thing

```bash
cd build
forge test                         # 93 passing (FirmQuote 42 · Registry 22 · Adversarial 26 · Invariant 3)
npm run prove                      # 5 symbolic proofs over every caller and every timestamp
node script/test.mjs               # 17 off-chain checks (keccak vectors, static policy, evasions)
node script/headline.mjs           # 8/8 attested vs 2/8 naive (offline, deterministic)
node script/bench.mjs              # retype p50/p95 vs the 100 ms block budget (synthetic: always runs)
node script/analyze.mjs --corpus   # the static policy verdict + reason for each contract
npm run verify                     # syntax + lint + typecheck + tests + headline, one gate
```

Those five are **deterministic and offline** — they give the same answer on any machine, today or in
six months. The two below read live testnet state and therefore depend on it:

```bash
node script/headline.mjs --live    # same corpus, classified from EXTCODEHASH read off Shannon
node script/firmness.mjs           # % of the live book that cannot be withdrawn
```

Run at `latest` today, both report their state honestly and **exit 1**: `S0 FirmQuote`'s `unlockAt`
was 2026-08-23 00:00 UTC and has lapsed — a lapsed lock is *not* firm, so S0 correctly reclassifies
`UNVERIFIED` (7/8) — and the default pool has since cycled to an empty book. Neither is a defect;
both are the checks refusing to report a stale or vacuous number as a result.

**Pin the block and both reproduce exactly.** Somnia's public RPC is archival, so no special
endpoint is needed:

```bash
node script/headline.mjs --live --block 468201000    # → 8/8 vs 2/8, exit 0
node script/firmness.mjs --block 468201000           # → 11 orders, 2 FIRM, 0.1%
node script/bench.mjs --block 468201000              # → scored on: synthetic + live
```

`--block` pins the block **and** evaluates the lock window against that block's own `timestamp`.
That second half matters: `unlockAt` is an `immutable`, so reading it at a historical block returns
the same lapsed value — pinning the state alone would still compare it against today's wall clock
and never restore `FIRM`. Block `468201000` is the first block after the whole corpus (S0…S6) was
deployed; pin earlier and the scripts stop with *"the block PREDATES its deployment"* rather than
scoring a misleading 2/8.

## Honest limits

- **Testnet only.** Nothing is deployed to Somnia mainnet.
- The **buy side only** is implemented. Selling firm needs an ERC-6909 operator grant, and granting
  no operator is what keeps the lock airtight.
- **S4 (operator grant) — grant executed, withdrawal pool-blocked.** The grant is a real tx and is
  verifiable in the registry (`isApprovedForPool == true`), but the Somnia binary pool rejects
  `cancelOrderFor` from **any** operator with `OnlyApprovedContracts` (`0x3fb0ba2e`) even for a valid
  grant — the pool's operator-cancel path is unwired on the buy side. So the operator route cannot
  withdraw here; the classifier still types the contract UNVERIFIED because its bytecode *can* grant
  operators. The escape mechanism is proven in `test/Adversarial.t.sol` against a faithful mock, and
  the pool-block is reproducible: `cast call 0x54d9…be00 "cancelOrderFor(address,uint128)" 0xa131…21F8 110680464442257422795`. This is a genuine finding for the SDK feedback report.
- **S6 (batch cancel) — EXECUTED 2026-08-26, on a second deployment.** The original S6
  (`0xb3e6…af54`) was deployed, funded and rested on 2026-08-22, but its `tidy()` was never sent: the
  funder key was down to 0.009 SOMI (native STT is browser-faucet only). By the time it was funded,
  that pool's market had reached **status 4 (terminal)** and the order had been swept —
  `getOrder` reverts `IncorrectOrder()`. Sending `tidy()` there today would **succeed while
  cancelling nothing**, because `cancelOrders` is best-effort and silently skips ids it does not own.
  A green transaction proving nothing is worse than an honest gap, so we did not send it.

  `QuoteBase.pool` is immutable, so that instance can never rest again. The escape was instead run in
  full against a **Trading** pool: `BatchCancel` at
  [`0xE3202c08…0ea8`](https://shannon-explorer.somnia.network/address/0xE3202c084f3A0E52804ec5Ae467c533ce0FE0ea8)
  → rested order `18446744073709832684` → `tidy()`
  ([`0xb55516e4…9bcc7`](https://shannon-explorer.somnia.network/tx/0xb55516e484bbad70ed2a1e2e9bb88c53945cf771d7dc366b6914af802a29bcc7),
  status `1`, block 471724333).

  **It was a cancel, not a fill, and the escrow proves it:** the contract was funded with `500000`,
  the resting order escrowed `10000`, and after `tidy()` the balance is **back to `500000`**. A fill
  consumes escrow and returns outcome tokens; a cancel refunds it. The depth vanished with no trade.
  Full record: [`script/s6.executed.json`](script/s6.executed.json).

- So **five of the six attacker escapes execute a full on-chain withdrawal**; the remaining one is a
  documented pool limitation (S4 — the binary pool's operator-cancel path is unwired), not faked. The
  classification result (8/8 vs 2/8) is computed from **live on-chain EXTCODEHASH** and does not
  depend on the escapes running.
- **The static analyzer is a necessary pre-filter, NOT a proof of irrevocability — and we found the
  hole ourselves.** Our 2026-08-26 audit built `StealthCancel`: a contract that computes the
  `cancelOrder` selector arithmetically (`add(0xdbc91395, 1)` in Yul) and calls the pool with it. The
  four selector bytes appear nowhere in its runtime, so it passed every clause of the policy while
  remaining fully withdrawable. Two things came out of that:
  1. **We hardened what could be hardened.** The scan used to match only a `PUSH4` immediate, which
     misses the *ordinary* Yul idiom `mstore(shl(224, sel))` — the compiler emits that as a `PUSH32`
     with the selector left-aligned. The policy now matches any **literal** occurrence at any byte
     alignment, and refuses to honour an implausible CBOR-metadata length that would otherwise excise
     live code from the scan. Both evasions are pinned by tests in `script/test.mjs`.
  2. **We retracted the claim we could not support.** A selector built by *arithmetic* is invisible
     to any static scan, and no scan over a language with arbitrary `CALL` can be made sound. So
     `FIRM` means **attested and inside its lock window**, where attestation is a **human-reviewed
     transparency list** that a green `analyze()` gates rather than decides. Every `FIRM_CAPABLE`
     record carries a `guarantee: "necessary-not-sufficient"` field so no consumer can misread it.
  The registry is a transparency list anyone can re-derive from the same bytes, not a trustless oracle.
- **The shipped demo is unaffected by that hole**, and we are precise about why rather than leaning
  on it: the attested set is a fixed, committed corpus (`buildAttestedSet` over the known S0…S6), so
  nothing can be injected into it at demo time. The finding breaks the *general soundness claim*, not
  the running demo. We changed the claim anyway.
- **Live-state commands depend on live state.** `headline.mjs --live` reports 7/8 today because S0's
  lock lapsed on 2026-08-23 — the classifier is right and says so, then exits 1. `firmness.mjs` and
  the live half of `bench.mjs` need a pool with depth. The deterministic evidence (`forge test`,
  `headline.mjs`, `bench.mjs` synthetic, `analyze.mjs`) does not rot.
