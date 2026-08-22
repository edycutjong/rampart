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
forge test                                   # 42 passing

export PRIVATE_KEY=0x…                       # a funded Shannon key
./gate.sh                                    # full deploy → rest → refuse sequence

# or verify the standing proof directly, no key needed, no gas:
cast call 0x1b8ed5380a4741df019acf5faa0ce6ecbf6167ee "cancelOrder(uint128)" \
  129127208515966879685 --from 0xFbc73Ce1C0B43f87cD065f82df24697dEc653595 \
  --rpc-url https://api.infra.testnet.somnia.network
# → execution reverted, 0xf5e39c1f IncorrectSender(caller, expected)
```

The last command needs no wallet and no funds. Anyone can run it and watch the chain refuse.

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
code is **UNVERIFIED — no claim**. An attacker cannot mint fake FIRM depth, only UNVERIFIED depth.

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

**Four escapes execute a full on-chain withdrawal** (S1 hidden cancel, S2 proxy upgrade, S3
delegatecall, S5 quiet reduce), and S0's firm quote stands with its funder's cancel reverted.

## % of book that cannot be withdrawn — over the live market

```bash
node script/firmness.mjs           # pool 0x54d9…be00 (ETH 24h), live
```

Reads the resting book via `getAllOpenOrdersOffChain`, takes each distinct owner's `EXTCODEHASH`,
classifies, and reports `Σ firm ÷ Σ displayed`. On the live pool the number is **~0.1%** — only the
small attested `FirmQuote` is firm against a market-maker bot flooding the book with UNVERIFIED
depth. That low number is the honest point: **UNVERIFIED depth cannot masquerade as firm**, so the
metric never overstates. This observable exists on no off-chain exchange.

## Bench gate — retype inside one 100 ms block

```bash
node script/bench.mjs --n 200 --scale 2000
```

Full-book retype (classify every order against memoised owner code hashes, aggregate the %):

| | p50 | p95 | max |
|---|---|---|---|
| live book (12 orders) | 0.00 ms | 0.00 ms | 0.08 ms |
| synthetic 2,000 orders | 0.05 ms | **0.25 ms** | 0.51 ms |

**p95 0.25 ms ≤ 100 ms block → PASS.** Network hydration (cold read + EXTCODEHASH per distinct
owner) is a separate ~2–3 s one-time cost, reported alongside; the per-block *retype* is what must
fit the block, and it does with three orders of magnitude to spare.

## Reproduce the whole thing

```bash
cd build
forge test                         # 70 passing (FirmQuote 42 · FirmnessRegistry 21 · Adversarial 7)
node script/test.mjs               # 12 off-chain checks (keccak vectors, static policy, headline)
node script/headline.mjs           # 8/8 attested vs 2/8 naive (offline, deterministic)
node script/headline.mjs --live    # same, classified from EXTCODEHASH read live off Shannon
node script/firmness.mjs           # % of the live book that cannot be withdrawn
node script/bench.mjs              # retype p50/p95 vs the 100 ms block budget
node script/analyze.mjs --corpus   # the static policy verdict + reason for each contract
```

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
- **S6 (batch cancel) — deployed, funded, RESTED; `tidy()` gas-blocked.** The batch-cancel succeeds
  in simulation (`cast call` returns success; `cancelOrders([id])` returns `cleaned = 1`) but the
  live send needs ~3 M gas and the funder key ran dry at 0.009 SOMI (native STT is browser-faucet
  only). One command finishes it when funded: `cast send 0xb3e6…af54 "tidy()" --gas-limit 4000000`.
  The mechanism is proven in `test/Adversarial.t.sol` (`test_A1b`).
- So **four of the six attacker escapes execute a full on-chain withdrawal**; the other two are a
  documented pool limitation (S4) and a documented faucet-gas blocker (S6), neither faked. The
  classification result (8/8 vs 2/8) is computed from **live on-chain EXTCODEHASH** and does not
  depend on the escapes running.
- The static analyzer is **sound for the six known escapes, not a general proof of irrevocability**.
  The registry is a transparency list anyone can re-derive from the same bytes, not a trustless oracle.
