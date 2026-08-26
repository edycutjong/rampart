# SDK & documentation feedback — `@somnia-chain/markets-sdk` + docs.dreamdex.io

**From:** Rampart (Event Contracts Hackathon, Somnia x DreamDEX) · **Written:** 2026-08-22, after the day-1 gate
passed on Shannon testnet · **Finding 9 added 2026-08-26** against `@somnia-chain/markets-sdk@0.28.1`, then
**resolved-with-a-twist and joined by findings 13–15** later the same day when the differential harness
(`build/script/sdk-verify.mjs`, 35 assertions, runs in CI) was deepened; every earlier finding is re-verified
against 0.28.1 on each run (`FirmQuote` at `0x2a09b4c474828e6895af273e51Ba8C181c91191a`, four real transactions
including a deliberately-failed cancel — see `build/DEMO.md`).

**Method.** We built a Solidity contract that composes directly with a `BinaryPool` — a contract-owned resting
order — which means we consumed the docs from the least-traveled side: the on-chain write ABI, not the
TypeScript happy path. Every finding below is reproducible against `docs.dreamdex.io`, the
`@somnia-chain/markets-sdk@0.27.0` package source, or the hackathon listing itself, and every "trap" finding cost
us real debugging time on this build (traceable in `build/` history). Where the docs are good, we say so —
several pages are the best technical writing we read this hackathon, and inflating every finding to "critical"
would make this report less useful, not more.

## Summary

| # | Type | Finding | Severity |
|---|---|---|---|
| 1 | Gap | `placeOrder` reverts on a binary pool; the real entry point `placeBinaryOrder` is absent from every prose page | High |
| 2 | Gap | `collateral()` is not a `BinaryPool` method — it lives on the per-window `Market` — and this is undocumented anywhere in prose | High |
| 3 | Gap | HTTP API is spot/perp-only; no event-contract endpoints exist, and no page says so | Medium |
| 4 | Trap | `builderFeeBpsTimes1k` must be `uint96` — get the width wrong and the selector silently changes | Medium |
| 5 | Gap | Indexer-vs-chain lag is documented but easy to skip; a write gated on the indexer can revert or silently no-op | Medium |
| 6 | Gap | The Up/Down mint-a-pair mechanism (opposite buyers cross with no seller) is documented but easy to miss on a skim | Low–Medium |
| 7 | Nit | The faucet sentence on the hackathon listing has no href | Low |
| 8 | Nit | SDK version floor (<0.23.0 cannot read markets) is not stated anywhere in the SDK itself | Low |
| 9 | Trap | `PLACE_ORDER_FOR_SELECTOR` is exported with no matching ABI entry — a consumer cannot derive or verify it. **Update 2026-08-26:** signature identified by exhaustive sweep (it is the *spot* `placeOrderFor`) — see finding 13 for why that makes it worse, not better | Low–Medium |
| 10 | Trap | `PLACE_ORDER_FOR_SELECTOR` names the **spot** `placeOrderFor` — granting it to an operator on a *binary* pool, exactly as the SDK's own operator-approval docs instruct, authorizes only a method that reverts `UseBinaryPlacement`; the selector that actually places on a binary pool (`placeBinaryOrderFor`, `0x5d97c566`) has no exported constant | Medium |
| 11 | Gap | The binary pool **read** ABI (`getAllOpenOrdersOffChain`, `getOrder`, `getBookLevels`, `getBinaryPoolParams`, …) is not exported — only `binaryPoolWriteAbi` is. The zero-auth book read must be hand-transcribed and cannot be verified against the package | Medium |
| 12 | Gap | The contract-error ABI (`contractErrorsAbi.ts`, incl. `IncorrectSender(address,address)`) is shipped in `src/` but not exported — revert decoding outside the SDK's own client means trusting `errors.md` prose with no programmatic cross-check | Low–Medium |
| 13 | Praise | `developers/event-contracts/gotchas.md` is the best page in the corpus | — |
| 14 | Praise | The `cancelOrder` / `cancelOrderFor` operator-authorization asymmetry is documented precisely enough to build a security product on | — |
| 15 | Praise | `errors.md`'s selector table, with `cast decode-error` / `cast 4byte` snippets, is exactly the right shape for an integrator | — |

---

## 1. `placeOrder` traps binary-pool integrators — the real entry point is absent from prose docs (High)

**Expected:** the documented `placeOrder(bool isBid, ...)` on `developers/contracts/functions.md` would work
against any pool returned by the market registry, since the page makes no distinction between pool kinds.

**What happened:** calling `placeOrder` on a `BinaryPool` reverts with `UseBinaryPlacement`. The actual entry
point for binary (event-contract) markets is a different function with a different signature:

```solidity
placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs,
                  uint8 orderType, uint8 selfMatchingOption, address builder,
                  uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)
```

**Where:** `developers/contracts/functions.md` documents only `SpotPool.placeOrder` (confirmed: the string
`placeBinaryOrder` does not appear anywhere in the 49-page prose corpus we crawled — `_docs/pages/*.md`). The
real signature exists only in the SDK package source, `@somnia-chain/markets-sdk@0.27.0`
`src/tradeAbi.ts` (`binaryPoolWriteAbi`), which does carry a comment noting binary pools revert
`UseBinaryPlacement` on the generic entry — but that comment lives in code, not in docs a Solidity-only
integrator would ever open.

Two other differences that fall out of the same gap and are equally undocumented in prose:
- `kind` (0 `BUY_YES` · 1 `SELL_YES` · 2 `BUY_NO` · 3 `SELL_NO`) replaces `isBid`, and **`price` is always
  quoted in YES terms** regardless of which side you're trading — a Down/NO buyer still prices in Up terms.
- The generic errors page's `UseBinaryPlacement` selector, if it's cataloged at all, is not cross-referenced
  from `placeOrder`'s own docs as "you will hit this on a binary pool."

**Repro:** deploy any contract that calls `pool.placeOrder(...)` against a `BinaryPool` address (e.g. the BTC
24h window pool on Shannon, `0x1b8ed5380a4741df019acf5faa0ce6ecbf6167ee`) — the call reverts `UseBinaryPlacement`
every time, with no doc page explaining why.

**Recommendation:** add a "BinaryPool write surface" section next to the SpotPool functions reference — even a
single table with the Solidity signature, the `kind` enum, and the YES-terms pricing convention would have saved
us the reverse-engineering step. Cross-link `UseBinaryPlacement` from `placeOrder`'s own doc entry.

## 2. `collateral()` lives on the Market, not the Pool — and isn't documented on either (High)

**Expected:** since `market-structure.md` describes the Pool as the thing that "owns all escrow," we expected
`pool.collateral()` to resolve the ERC-20 collateral address, matching the pattern SpotPool uses for
`getPoolParams()` (`baseToken_`, `quoteToken_`, ...).

**What happened:** `collateral()` reverts when called on the `BinaryPool`. It exists only on the per-window
`Market` contract, reached via `pool.market()`. The pool's own read surface exposes `outcomeToken()` and
`market()`, not `collateral()`.

**Where:** we grepped `collateral()` against all 49 prose pages (`_docs/pages/*.md`) — zero matches. The
function is not documented as belonging to either contract. We found the correct binding only by reading the
SDK's `readsAbi.ts` (`collateral()` appears once, at line 100, attached to the binary-market read ABI, not the
pool read ABI) and by testing directly on Shannon.

**Impact — this cost a real debugging cycle here:** our first `FirmQuote` constructor called
`IBinaryPool(_pool).collateral()` directly, following the SpotPool mental model. The call reverted on deploy —
not with a decodable reason, just a bare revert — which for a few minutes looked like a broken interface rather
than a wrong contract target. The fix, once found, is one hop:

```solidity
// WRONG — reverts, collateral() is not a BinaryPool method
collateral = IERC20(IBinaryPool(_pool).collateral());

// RIGHT — collateral() lives on the per-window Market
collateral = IERC20(IBinaryMarket(IBinaryPool(_pool).market()).collateral());
```

See `build/src/IBinaryPool.sol:62-67` and the constructor at `build/src/FirmQuote.sol:67-69` for the fix in
context, with an inline comment recording that this was verified empirically on Shannon on 2026-08-19.

**Recommendation:** `market-structure.md`'s "one market, four contracts" table is exactly the right place to add
a one-line read-surface map — which view functions live on the Pool vs. the Market vs.
`BinaryMarketsModule`. Right now that binding has to be reverse-engineered from the SDK's internal ABI split
(`binaryPoolReadAbi` vs. `binaryMarketReadAbi`), which most integrators will never open.

## 3. HTTP API is spot/perp-only; no page states the event-contract scope limit (Medium)

**Expected:** given `developers/http-api.md` advertises "list the currently-available markets ... prepare orders
for transmission" with no scope caveat, and `developers/event-contracts.md` sits under the same `developers/`
tree, we expected the HTTP API to at least discover and prepare orders for binary/event-contract markets even if
trading UX favored the SDK.

**What happened:** the trading endpoint's own OpenAPI schema (embedded in
`_docs/pages/developers__http-api__trading.md`) enumerates exactly two market kinds for `fundingSource`:

```
| Market `kind` | Valid `fundingSource` |
|---|---|
| `spot` | `wallet` (default), `vault` |
| `perp` | `marginBank` |
```

There is no `binary` (or `event`) kind anywhere in the schema, and none of the eight `developers/http-api/*`
pages (authentication, market-data, trading, portfolio, vault, wallets, builder-fees, error-handling) mentions
event contracts once. The restriction is discoverable only by absence — nothing says "the HTTP API does not
serve event contracts," you just don't find them.

**Where:** `_docs/pages/developers__http-api__trading.md` (embedded OpenAPI `PrepareOrder` schema,
`FundingSource` enum); `_docs/pages/developers__http-api.md` (index page, no scope caveat).

**Recommendation:** one banner line at the top of `developers/http-api.md` — "Event contracts are not served by
this API; use `@somnia-chain/markets-sdk` or on-chain reads instead" — would save every REST-first team the
afternoon it cost us to confirm this by exhaustive absence rather than by being told.

## 4. `builderFeeBpsTimes1k` is `uint96` and selector-critical (Medium)

**Expected:** transcribing `placeBinaryOrder`'s parameter types by hand from the SDK, the natural first guess
for a basis-points fee field is `uint256`.

**What happened:** the type must be exactly `uint96`. Because this parameter is part of the function signature
(not just an internal value), getting the width wrong produces a **different 4-byte selector** — the call
reverts with no decodable reason, which is one of the harder failure modes to debug because it looks like a
funding or permission problem, not a type problem.

**Where:** the type is stated correctly, but only for `SpotPool.placeOrder`, in
`developers/contracts/functions.md`'s parameter table — not for `placeBinaryOrder`, which isn't in prose at all
(see finding 1). Anyone transcribing the binary entry point by hand inherits the SpotPool type by analogy, which
happens to be right here, but there's no page that confirms it for the binary function specifically.

**Recommendation:** publish a canonical, copy-pasteable Solidity `interface IBinaryPool` snippet somewhere in
the docs so nobody hand-transcribes this ABI. Ours (`build/src/IBinaryPool.sol`) is MIT-licensed and Somnia is
welcome to it verbatim.

## 5. Indexer-vs-chain lag is documented, but the consequence for writes needs to be louder (Medium)

**What we found:** `developers/event-contracts/gotchas.md` item 1 ("Gate on the on-chain market status, not the
indexer") is exactly correct and is genuinely one of the best-written gotchas in the corpus — it explicitly
says the indexer lags by seconds and that orders on a market that just locked "revert — or worse, appear to
succeed." `gate.sh`'s own step 0 sanity check follows this rule directly: it reads `market.status()` on-chain
(must equal `1`, Trading) before ever attempting a write, never the indexer.

**Why it's still worth a flag:** this gotcha is item #1 of 13 on a single page that most builders will read once
during onboarding and not revisit. Given that acting on stale status is one of the few ways to lose real funds
(a write against a Locked market doesn't cleanly revert — see gotcha #2, "silently succeeded" through SDK
0.22.0), we'd promote this specific rule out of the gotchas list and into the quick-start's "recommended
workflow" section, next to the existing "simulate first" / "verify after confirmation" steps — it's the same
class of advice and belongs in the same place newcomers actually read.

## 6. Up/Down mint-a-pair mechanism is documented but non-obvious on first read (Low–Medium)

**What we found:** `developers/event-contracts/market-structure.md` does document that Up and Down share a
single order book quoted in Up terms (Down price = 1 − Up price), and that a `Buy Up × Buy Down` cross triggers
"mint-a-pair" — the pool mints a fresh Up/Down pair rather than requiring an opposite seller. This is accurate
and, once found, is well explained with a clear four-row table of crossing paths.

**Why it's still a finding:** this is genuinely surprising behavior relative to every other CLOB mental model
(a buy normally needs a matching sell, not another buy), and it sits in the middle of a lifecycle page rather
than being called out where a builder is most likely to be confused — e.g. when they see two opposite-side buy
orders both marked as "filled" with no counterparty in sight, or when computing implied liquidity from open
interest. We'd add a one-line pointer to this mechanism from `developers/contracts/errors.md` or
`trading/event-contracts/faq.md`, so it's reachable from "why did my order fill against nothing" rather than
only from a lifecycle deep-dive.

## 7. Faucet link on the hackathon listing has no href (Low)

**Expected:** the hackathon listing's line "You can also request test STT tokens from here." to link somewhere.

**What happened:** "here" is plain text with no `<a>` tag — confirmed in the crawled listing,
`_crawl/pages/dorahacks-detail.md:215`. The actual STT faucet does exist and is documented correctly elsewhere
(`developers/quick-start.md`: `https://testnet.somnia.network/`, plus the Google Cloud Web3 faucet as a
fallback) — the break is specifically in the hackathon listing page, not the SDK docs.

**Recommendation:** fix the link on the listing page to point at `https://testnet.somnia.network/`.

## 8. SDK version floor isn't stated anywhere in the SDK itself (Low)

**What we found:** the hackathon listing recommends `@somnia-chain/markets-sdk >= 0.25.0`. Separately,
`developers/event-contracts/gotchas.md` documents version-gated *behavior* changes at 0.22.0→0.23.0 (revert
handling) and 0.23.0→0.24.0 (lot-size precision) — but nowhere does either the SDK's own `README.md` or its
`package.json` state that versions below 0.23.0 **cannot read markets at all**, which is the actual hard floor
(confirmed against `_docs/sdk/markets-sdk/package/README.md`, which documents the 0.19.0→0.20.0 npm-publishing
change but nothing about a read-capability floor). A team pinning an old version from a stale tutorial gets no
warning until markets silently fail to load.

**Recommendation:** a one-line support matrix in the SDK's own `README.md` — "use ≥ 0.25.0; versions < 0.23.0
cannot read markets at all" — next to the existing install instructions, not only in a hackathon-specific
listing that will disappear after the event.

---

## 9. `PLACE_ORDER_FOR_SELECTOR` is exported without the ABI entry that would let you verify it (Low–Medium)

**What we found (v0.28.1, 2026-08-26):** the package exports two selector constants,
`CANCEL_ORDER_FOR_SELECTOR` (`0xe37b444b`) and `PLACE_ORDER_FOR_SELECTOR` (`0x80054449`). The first is
verifiable — `keccak256("cancelOrderFor(address,uint128)")[0:4]` reproduces it exactly, and the corresponding
signature is derivable from the exported ABIs. **The second is not.** We enumerated every `type: "function"`
entry across **every array the package exports**, hashed each canonical signature, and none produced
`0x80054449`.

A wider candidate sweep eventually did identify it — it is the **spot** pool's
`placeOrderFor(address,bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)`, which we now assert
in CI. But that is a preimage we had to *guess*: it is still absent from every ABI the package exports, so a
consumer cannot derive or verify it from the package alone. **Finding 10 covers the consequence** — that
selector is also the wrong one to grant on a binary pool.

**Why it matters:** these constants exist to be passed to `setOperatorApprovalForPool(..., bytes4[] selectors, ...)`
— granting an operator the right to call a specific method. A constant you cannot derive is a constant you must
trust blindly, and the *entire* operator-approval security model is "the owner authorises exactly these
selectors." Given finding 4 (a `uint256` where the pool wants `uint96` silently changes the selector and reverts
undecodably), "trust this 4-byte literal" is a materially uncomfortable position for an integrator.

**Reproduce:** `node script/sdk-verify.mjs` in our repo. The check is deliberately non-fatal — it reports the
constant as *unverifiable* rather than failing — precisely so a green run never implies we checked something we
could not.

**Recommendation:** export the matching ABI entry (or document the canonical signature in a comment next to the
constant) so `keccak256(sig)[0:4] === PLACE_ORDER_FOR_SELECTOR` is checkable by consumers. Ideally derive both
constants from the ABI at build time, so they cannot drift from the contract they name.

**Update (2026-08-26, later the same day, v0.28.1):** a wider candidate sweep found the preimage. The constant
is `keccak256("placeOrderFor(address,bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)")[0:4]` —
the owner-prefixed form of the **SpotPool's** `placeOrder(bool isBid, uint64 userData, …)`. Our earlier sweep
missed it because we didn't try the spot parameter list (the `uint64 userData` second parameter) under the
generic `placeOrderFor` name. Two corrections and one escalation follow: (a) the constant is now *derivable in
principle*, so `sdk-verify` asserts it (it would fail loudly if the constant ever changed); (b) one line above
we said `cancelOrderFor`'s signature "is derivable from the exported ABIs" — on re-check that was **wrong**:
`cancelOrderFor(address,uint128)` appears in no exported ABI either; it reproduces only from the signature the
*docs* state (`functions.md`), which is a docs dependency, not a package one; (c) knowing the preimage revealed
that the constant is a **spot-only** value being recommended without qualification — escalated as finding 13.

---

## 10. `PLACE_ORDER_FOR_SELECTOR` is spot-only, and the SDK's own operator docs steer binary integrators into granting a selector that can only revert (Medium)

**What we found (v0.28.1, 2026-08-26):** the operator-approval parameter docs (`trade.ts`,
`OperatorApprovalParamsBase.selectors`) say: *"4-byte selectors the operator may call. Grant only what it
needs — `PLACE_ORDER_FOR_SELECTOR` to place, `CANCEL_ORDER_FOR_SELECTOR` to cancel."* No market-kind
qualification. But per finding 9's update, `PLACE_ORDER_FOR_SELECTOR` (`0x80054449`) is the **generic/spot**
`placeOrderFor` — and the SDK's *own* `tradeAbi.ts` comment states that on a binary pool "the generic
`placeOrder`/`placeOrderFor`/`amendOrder` entries REVERT `UseBinaryPlacement`." The method that actually places
for an owner on a binary pool is `placeBinaryOrderFor(address,uint8,uint256,uint256,uint64,uint8,uint8,address,uint96,uint64)`
— present in `binaryPoolWriteAbi` with selector `0x5d97c566` — and **no constant for it is exported**.

**Why it matters:** a binary-market team that follows the documented recipe grants their bot operator rights to
a method that reverts on every call. The grant transaction succeeds, `isOperator` reads true, and the operator
still cannot place — a debugging session that starts from "but I did exactly what the docs said." It fails
closed (no security hole), but it is the same seam as findings 1–3: spot-vs-binary behaviour divergence that
each side documents correctly in isolation and nothing connects.

**Reproduce:** `node script/sdk-verify.mjs` — section 3 derives `0x80054449` from the spot signature with our
independent keccak; section 7 shows `placeBinaryOrderFor`'s selector `0x5d97c566 ≠ 0x80054449`.

**Recommendation:** export a `PLACE_BINARY_ORDER_FOR_SELECTOR` constant next to the existing two, and add one
qualifying sentence to `OperatorApprovalParamsBase.selectors` — "on binary pools grant
`PLACE_BINARY_ORDER_FOR_SELECTOR`; the generic placement selector reverts there."

## 11. The binary pool READ ABI is not exported — the zero-auth book read must be transcribed on trust (Medium)

**What we found (v0.28.1):** `binaryPoolWriteAbi` is exported; `binaryPoolReadAbi` — which carries
`getAllOpenOrdersOffChain(bool,uint256,uint64)`, `getOrder`, `getBookLevels`, `getOrderBookParameters`,
`getBinaryPoolParams` and friends — exists only in the shipped `src/readsAbi.ts` and is absent from the
package's export surface (we enumerated every exported ABI array: 14 of them, none contains these entries).
`getAllOpenOrdersOffChain` is the *only* documented way to read the full resting book with zero
authentication (it requires `msg.sender == 0`, i.e. a bare `eth_call`) — the natural integration point for
every indexer, analytics tool, or monitoring bot that does not want the SDK's full client and store.

**Impact — this is a real cost on this exact build:** our book reader decodes the 8-field Order struct
(`orderId, isBid, owner, userData, price, fullQuantity, quantityRemaining, expireTimestampNs`) by word offset
from a hand-transcribed layout. Nothing in the package's public surface lets us verify that transcription, so
our CI check parses the *shipped TypeScript source text* instead — which works (the `src/` directory is in the
npm tarball) but breaks the moment a refactor renames the file, and no consumer should need to know the SDK's
internal file layout to verify a struct.

**Reproduce:** `node script/sdk-verify.mjs` — section 10; or
`node -e "import('@somnia-chain/markets-sdk').then(s => console.log('binaryPoolReadAbi' in s))"` → `false`.

**Recommendation:** export `binaryPoolReadAbi` (and `binaryMarketReadAbi`, per finding 2's Pool/Market split)
alongside the write ABI. The comment already sitting on `orderViews` — explaining the `msg.sender == 0`
requirement — is exactly the documentation integrators need; today it is invisible to them.

## 12. The contract-error ABI (incl. `IncorrectSender`) is shipped but not exported (Low–Medium)

**What we found (v0.28.1):** `src/contractErrorsAbi.ts` is a 418-entry error ABI — the machine-readable twin
of `errors.md`'s excellent selector table (finding 12) — and it is not exported. Our entire on-chain proof
decodes `IncorrectSender(address sender, address expected)` (`0xf5e39c1f`); the *selector* we can re-derive
ourselves, but the **argument order** (which address is the expected owner) is exactly the kind of thing a
consumer wants to check against the package rather than trust from prose. We ended up parsing the shipped
source text in CI, same workaround and same fragility as finding 14.

**Reproduce:** `node script/sdk-verify.mjs` — section 9; the error entry exists at `src/contractErrorsAbi.ts`
(v0.28.1: line 122) but `IncorrectSender` appears in none of the 14 exported ABI arrays.

**Recommendation:** export `contractErrorsAbi`. It composes directly with `viem`'s `decodeErrorResult`, turning
every undecodable revert an integrator hits (findings 1, 2, 4 all produced them) into a named error with one
line of code.

---

## What's genuinely good (not padding — these shaped real design decisions)

**13. `developers/event-contracts/gotchas.md` is the best page in the corpus.** Thirteen numbered, battle-tested
items, several with precise version ranges for when a behavior changed (item 2: silent resolve-on-revert through
SDK 0.22.0 vs. a decoded throw from 0.23.0; item 6: `amountToPrecision` lot-sizing fixed in 0.24.0). Item 3 (the
float-price/`parseUnits` tick trap — only 0.25/0.5/0.75 survive `toFixed(18)` on an 18-decimal venue) directly
shaped our design: Rampart sends bigint tick-snapped prices through `placeBinaryOrder` directly and never
touches the unified float-based `createOrder` path, specifically because we read this item first. This page
should be required reading, linked from the quick-start, not discovered by accident.

**14. The operator-authorization asymmetry is documented precisely enough to build a security product on.**
Our entire mechanism rests on two sentences from `developers/contracts/functions.md`: `cancelOrderFor` — *"Unlike
`placeOrderFor`, the system-contract allowlist does **not** admit callers here — only the owner's per-user
approval does"* — and `reduceOrderFor` — *"Per-user approval only (no system allowlist)."* Combined with
`errors.md`'s precise `IncorrectSender(caller, expected)` (`0xf5e39c1f`) selector documentation, this let us
design and commit to a protocol-enforced commitment device entirely from prose, before sending a single
transaction. That a security-relevant authorization boundary is stated this exactly, with the asymmetry called
out explicitly rather than left implicit, is rare in any protocol's docs. We'd promote it into its own short
"who can cancel your order" callout — it's a market-integrity feature worth advertising on its own, not a
footnote inside the functions reference.

**15. `errors.md`'s selector table is exactly the right shape.** Every custom error is mapped to its 4-byte
selector with a `cast decode-error` / `cast 4byte` snippet up top, grouped by category (order validation,
funding/vault, gas, lifecycle, batch/amend, operators, builder codes). This is the page we referenced most while
writing `gate.sh`, which deliberately expects two calls to revert (`cancelOrder`, `reduceOrder`) and needed to
assert on the exact selector rather than just "did it revert." More SDK docs across the ecosystem should look
like this page.

---

## What we would fix first (priority order)

1. **Document `placeBinaryOrder` and the Pool/Market read-surface split** (findings 1 and 2). Both are High
   severity, both cost real time on this exact build, and both are a few hours of documentation work — no code
   changes needed, since the SDK source already has the correct information.
2. **State the HTTP API's spot/perp-only scope explicitly** (finding 3) — one sentence at the top of
   `developers/http-api.md` prevents every future REST-first team from losing an afternoon to exhaustive absence.
3. **Publish a canonical `IBinaryPool` Solidity interface** (finding 4) so nobody else hand-transcribes the
   selector-critical `uint96` field.
4. **Export `PLACE_BINARY_ORDER_FOR_SELECTOR` and qualify the operator-grant docs** (finding 13) — one constant
   plus one sentence stops binary teams from granting an operator a selector that can only revert.
5. **Export `binaryPoolReadAbi` and `contractErrorsAbi`** (findings 14-15) — both already exist and are already
   shipped in the tarball; exporting them is a two-line change that removes the last two surfaces an integrator
   must transcribe on trust.
6. **Promote the on-chain-status-before-write rule out of the gotchas list into the quick-start** (finding 5) —
   it's the one gotcha with real financial consequences if skipped.
7. Low-severity fixes (findings 6-8) — the faucet link, the mint-a-pair callout, and the SDK version floor — are
   each single-line changes with no design work required.

## Bottom line

The documentation's *contracts* pages — `errors.md`, the operator-authorization language in `functions.md`, and
`event-contracts/gotchas.md` — are strong enough that we designed a protocol-enforced commitment device from
prose alone before sending a single transaction. The gaps we found (findings 1-3, and now 13) share one shape:
they are all places where a binary/event-contract integrator falls through a seam between two things that are
each documented well on their own (SpotPool functions; the HTTP API's spot/perp scope; the operator-grant
recipe) but never explicitly connected to what happens on a *binary* pool. Closing that specific seam — not a
general documentation rewrite — is the highest-leverage fix available. The second, smaller theme (findings 9,
14, 15) is export hygiene: ABIs and constants that already exist in the shipped package, correct and
well-commented, that consumers simply cannot reach — each is a one-line `export` away from eliminating a class
of hand-transcription bugs like our own finding-4 near-miss.
