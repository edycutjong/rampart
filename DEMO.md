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

## Honest limits

- **Testnet only.** Nothing is deployed to Somnia mainnet.
- Order `…9685` rests until the market's expiry (~2026-08-20 08:00 UTC), after which the
  permissionless expiry sweep may clear it. **The transactions above are permanent regardless.**
- The order rests at 0.01 — deliberately far from the touch so it could not cross. It is a proof of
  the lock, not a market-making strategy.
- The **buy side only** is implemented. Selling firm needs an ERC-6909 operator grant, and granting
  no operator is what keeps the lock airtight.
- The typed-book classifier (FIRM / PULLABLE / UNVERIFIED) and its adversarial corpus are
  **specified and not yet built**. No firmness percentage is claimed anywhere.
