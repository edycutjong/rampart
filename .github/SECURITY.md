# Security Policy

## What this project is

Rampart is a **testnet prototype**. `FirmQuote` and `FirmnessRegistry` are deployed on Somnia
Shannon (chain 50312) only. **Nothing is deployed to mainnet, and nothing here has been audited.**
Do not put real funds behind it.

## Scope of the trust model

The honest boundaries, stated up front — these are design limits, not undiscovered bugs:

- **`FirmQuote` custodies only its own depositor's collateral.** There is no third-party custody,
  no pooled funds, and no admin key that can move someone else's balance.
- **The attested registry is a transparency list, not a trustless oracle.** It says "this exact
  runtime bytecode passed a published static policy." Anyone can re-derive the same verdict from
  the same bytes. It does not assert that attested code is *safe*.
- **The static analyzer is a NECESSARY pre-filter, not a proof of irrevocability, and it is
  defeatable.** It rejects the six known escape classes and any *literal* occurrence of a
  withdrawal selector at any byte alignment. It cannot see a selector computed at runtime —
  `add(0xdbc91395, 1)` in Yul reaches `cancelOrder(uint128)` with those bytes nowhere in the code,
  and such a contract passes every clause of the policy. Because a green verdict is therefore not
  self-certifying, **attestation requires human review**; `analyze()` gates that review and never
  substitutes for it. Every `FIRM_CAPABLE` record carries a `guarantee` field saying so.
- **`FIRM` is a claim with a horizon, not a badge.** A quote is firm only until its own mandatory
  `expireTimestampNs`, because `sweepExpiredAtLevel` is permissionless. Any consumer must take
  `min(unlockAt, order expiry)`.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/edycutjong/rampart/security/advisories/new).
For anything affecting the Somnia binary pool itself rather than this repo, report it to Somnia —
this project is a consumer of that protocol, not its maintainer.

Please include: the contract or script, the exact call sequence, and what an attacker gains. A
reproducing `forge test` case is the fastest possible report.

## Especially welcome: a seventh escape

`src/adversarial/` holds six contracts that each look firm to a naive `EXTCODESIZE` check and can
in fact withdraw. If you find a **seventh** withdrawal path that the static policy in
`script/lib/analyzer.mjs` would wave through as `FIRM_CAPABLE`, that is the highest-value bug in
this repo. It breaks the central claim, and we want it.

## Deliberately unsafe code in this repo

`src/adversarial/*.sol` are **attacker contracts by design** — hidden cancels, an upgradeable
proxy, a `DELEGATECALL` escape, a late operator grant, a quiet reduce, and an alternate-selector
batch cancel. Static analyzers flag them, and that is the point: they are the corpus the classifier
is scored against. Do not deploy them for any purpose other than reproducing the benchmark.

## Toolchain pinning

`solc` is pinned to `0.8.28` in `foundry.toml` and is **bumped by hand, never by automation.** A
compiler change alters the source metadata hash the compiler appends to the runtime bytecode, which
changes `EXTCODEHASH`, which invalidates every attestation against already-deployed contracts. The
same reasoning makes `forge fmt` advisory rather than enforced in CI.
