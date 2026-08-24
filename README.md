<p align="center">
  <img src="docs/assets/readme-hero-animated.svg" alt="rampart — locks a resting quote into the book so the pool refuses even its own funder's cancel" width="100%">
</p>

<p align="center">
  <strong>Order-book depth the protocol itself will not let you withdraw.</strong>
</p>

<p align="center">
  <code>Solidity</code> · <code>Somnia</code> · <code>@somnia-chain/markets-sdk</code> · <code>Foundry</code> · <code>viem</code>
</p>

---

## The mechanism

A `FirmQuote` contract holds collateral, approves a Somnia `BinaryPool`, and calls
`placeBinaryOrder` — so the resulting **`Order.owner` is the contract, not a wallet**.

The contract exposes **no cancel path, no reduce path, and never grants an operator**. Every route
that could withdraw the resting order is therefore closed:

| Withdrawal path | Who may call it | Source |
|---|---|---|
| `cancelOrder(uint128)` | the order owner **only** — a non-owner reverts `IncorrectSender` `0xf5e39c1f` | [errors](https://docs.dreamdex.io/developers/contracts/errors) |
| `cancelOrderFor(owner, id)` | an operator the **owner** approved. *"Unlike `placeOrderFor`, the system-contract allowlist does **not** admit callers here — only the owner's per-user approval does."* | [functions](https://docs.dreamdex.io/developers/contracts/functions) |
| `reduceOrderFor(owner, id, qty)` | *"Per-user approval only (no system allowlist)."* | [functions](https://docs.dreamdex.io/developers/contracts/functions) |

The quote stands until a taker fills it or its mandatory `expireTimestampNs` lapses. **Not even the
wallet that paid for it can take it back.**

### Why that matters

`Order.owner` is readable on-chain, so every price level can be **typed**:

| | condition | claim |
|---|---|---|
| **FIRM** | owner is a contract whose `EXTCODEHASH` is attested, still inside its lock window | this depth cannot be withdrawn |
| **PULLABLE** | owner is a wallet | this depth can vanish in one block |
| **UNVERIFIED** | owner is a contract we have not attested | *no claim is made* |

"Percent of book that cannot be withdrawn" is a liquidity-quality observable that **exists on no
other exchange**. Off-chain books — Polymarket, Kalshi, every CEX — cannot expose it: their resting
orders are signed messages inside a private matching engine, with no on-chain owner to inspect.

> `UNVERIFIED` is load-bearing. Classifying on `EXTCODESIZE > 0` alone is forgeable — a contract can
> hide a cancel, sit behind an upgradeable proxy, `DELEGATECALL` to an attacker target, or grant an
> operator *after* resting. All four would display as FIRM under a naive check. An attacker cannot
> mint fake FIRM depth, only UNVERIFIED depth.

---

## The headline number

```bash
node script/headline.mjs        # attested classifier 8/8  ·  naive EXTCODESIZE 2/8
```

The corpus is the real `FirmQuote`, **six attacker contracts that each look firm to a naive check**
(hidden cancel, EIP-1967 proxy, `DELEGATECALL`, late operator grant, quiet `reduceOrder`, and cancel
via an alternate selector), and a plain wallet. The attested-`EXTCODEHASH` classifier types all eight
correctly; the naive `EXTCODESIZE > 0` check is fooled by all six contract attacks. The whole corpus
is **deployed on Shannon**, and **four of the six escapes are executed as real transactions** — the
other two are rested on-chain with their exact blocked state documented. See [DEMO.md](DEMO.md) and
[`script/corpus.deployed.json`](script/corpus.deployed.json).

## Status — what is real

**Built and passing — `forge test`: 70 tests, 0 failures**

- `src/FirmQuote.sol` — a resting quote the pool will not let its funder withdraw. Buy-side only by
  design: a sell escrows outcome tokens, which needs an ERC-6909 `setOperator` grant, and granting
  no operator is what keeps the lock airtight. (42 tests, incl. seven asserting the *absence* of every
  withdrawal selector.)
- `src/FirmnessRegistry.sol` — the ternary classifier (**FIRM / PULLABLE / UNVERIFIED**) expressed as
  a Solidity contract: attested-`EXTCODEHASH` set + `classify` / `classifyBatch` with the lock-window
  horizon. (21 tests.) **Not deployed** — the classification the demo runs on is the off-chain engine
  in `script/`, which reads `EXTCODEHASH` live from the same chain state.
- `src/adversarial/*.sol` — six attacker contracts, each with a real working escape proven against a
  faithful mock pool. (7 tests.)
- `script/` — the off-chain engine: a dependency-free `keccak256`, an EVM disassembler + static
  bytecode policy (`analyze`), the FIRM/PULLABLE/UNVERIFIED classifier, the **headline** comparison,
  the **firmness %** over a live market, and the **bench** (retype p95 **0.25 ms** inside a 100 ms
  block). `node script/test.mjs` → 12 checks; the analyzer's hash matches on-chain `EXTCODEHASH`.
- `src/IBinaryPool.sol` — the pool surface, transcribed from `@somnia-chain/markets-sdk@0.27.0`.
- `gate.sh` — the day-1 go/no-go against Somnia Shannon testnet. **Run 2026-08-19: PASSED.**

**Honest edges** (detailed in [DEMO.md](DEMO.md) → *Honest limits*): four of the six attacker escapes
execute a full on-chain withdrawal; the operator-grant escape's grant executes but the binary pool's
`cancelOrderFor` operator path is unwired (a finding), and the batch-cancel is rested with its `tidy()`
gas-blocked (native faucet dry). Both mechanisms are proven in unit tests; the 8/8-vs-2/8
classification is computed from **live on-chain EXTCODEHASH** and does not depend on the escapes running.

### ✅ Proven on-chain — 2026-08-19

**The gate passed.** A `BinaryPool` accepts a contract as `Order.owner`, and the funder cannot take
the order back. Order `…9685` rested with real escrow while its own funder's cancel **reverted**:

```
0xf5e39c1f  IncorrectSender(
  caller   = 0xFbc73Ce1…3595   ← the wallet that paid for the order
  expected = 0x2a09b4c4…191a   ← FirmQuote
)
```

The failed transaction is public and permanent:
**[`0x959b4770…6ddb`](https://shannon-explorer.somnia.network/tx/0x959b47704d493dd48f2e724f2692facf1609a2cdc738f1a7ceb1fd070b3c6ddb)** (status `0x0`).
Control: the same call `--from` the contract returns `0x` — the pool *would* allow its owner to
cancel; the owner simply has no code path to ask.

Full evidence, including why the first attempt was invalid and was re-run: **[DEMO.md](DEMO.md)**.

Verify it yourself with no wallet, no funds, no gas:

```bash
cast call 0x1b8ed5380a4741df019acf5faa0ce6ecbf6167ee "cancelOrder(uint128)" \
  129127208515966879685 --from 0xFbc73Ce1C0B43f87cD065f82df24697dEc653595 \
  --rpc-url https://api.infra.testnet.somnia.network
```

```bash
forge test                       # 70 passing
PRIVATE_KEY=0x… POOL=0x… ./gate.sh   # the day-1 gate — steps 4 and 5 SUCCEED BY REVERTING
```

`gate.sh` step 4 has the funding wallet attempt `pool.cancelOrder` on the contract's own order. That
transaction is **supposed to fail**, and the failed transaction on the explorer is the proof — an
artifact that cannot be mocked.

---

## Notes for anyone building on Somnia binary markets

Two things cost real time and neither is in the prose docs, which document `SpotPool`:

1. **A binary pool has `placeBinaryOrder`, not `placeOrder`.** The generic entry point reverts
   `UseBinaryPlacement`. The YES/NO side is an explicit `kind` param and `price` is *always* quoted
   in YES terms.
2. **`builderFeeBpsTimes1k` must be `uint96`.** It is selector-critical — a `uint256` there produces
   a different function selector and the call reverts with nothing decodable.

Both were read out of `markets-sdk/src/tradeAbi.ts`, not the documentation.

## License

MIT
