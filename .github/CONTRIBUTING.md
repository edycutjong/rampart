# Contributing

## Get it running (no keys, no funds, no gas)

Every claim in this repo is verifiable read-only. Nothing below needs a wallet.

```bash
git clone --recursive https://github.com/edycutjong/rampart.git && cd rampart
forge test                    # 70 passing
node script/test.mjs          # 12 off-chain checks
node script/headline.mjs      # attested 8/8 vs naive 2/8
node script/bench.mjs         # retype p50/p95 vs the 100 ms block budget
```

Prerequisites: [Foundry](https://book.getfoundry.sh/getting-started/installation) and Node ≥ 20.
The off-chain classifier has **zero runtime dependencies** — it speaks JSON-RPC over global `fetch`
and implements keccak locally, so `npm install` is not part of the loop above.

If you cloned without `--recursive`: `git submodule update --init --recursive`.

## The one rule that will surprise you: do not run `forge fmt`

`forge fmt` collapses the multi-line function headers in `src/`. That rewrites the source, which
changes the source metadata hash the compiler appends to the runtime bytecode, which changes
`EXTCODEHASH` — which invalidates every attestation against the contracts **already deployed on
Shannon**. The attested classifier is the whole product, so formatting is not allowed to break it.

CI reports `forge fmt --check` as advisory for exactly this reason. Leave it advisory.

The same logic applies to bumping `solc` (pinned at `0.8.28`) and to touching optimizer settings.
Either is a deliberate, standalone decision — never a drive-by.

## What a good contribution looks like

Ranked by how much we want it:

1. **A seventh escape.** `src/adversarial/` holds six contracts that look firm to a naive
   `EXTCODESIZE` check and can actually withdraw. A seventh withdrawal path that
   `script/lib/analyzer.mjs` would wave through as `FIRM_CAPABLE` breaks the central claim. See
   [SECURITY.md](SECURITY.md).
2. **A tightening of the static policy** that removes a false `FIRM_CAPABLE` without turning a
   genuinely-firm contract into `UNVERIFIED`.
3. **Sell-side firm quotes.** Cut from v1 on purpose: selling firm needs an ERC-6909 operator
   grant, and granting no operator is what keeps the buy-side lock airtight. Solving that
   tension properly is real work.
4. Tests, docs, and reproduce-path fixes.

## What will be turned down

- Anything that makes `UNVERIFIED` collapse into `FIRM`. Classifying on `EXTCODESIZE > 0` is
  forgeable, and laundering unreliable liquidity through our own metric is worse than no metric.
- A `FIRM` badge with no horizon. Firmness expires with the order; consumers must take
  `min(unlockAt, order expiry)`.
- Mainnet deployment scripts. This is a testnet prototype and says so everywhere.
- Reformatting, mass renames, or dependency churn (see the `forge fmt` rule above).

## Conventions

- Commits: `type: imperative summary` (`fix:`, `feat:`, `docs:`, `test:`, `ci:`, `deps:`).
- New Solidity gets a test in the matching `test/*.t.sol`. Line coverage floor is **80%** and CI
  enforces it; the repo currently sits at ~88%.
- New attacker contracts go in `src/adversarial/` and must be added to the corpus truth table in
  `script/lib/corpus.mjs`, so the classifier is scored against them.
- Claims in `README.md` and `DEMO.md` must be greppable in the repo or a live explorer link. A
  number that exists only in prose does not ship.
