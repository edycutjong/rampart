## What this changes

<!-- One paragraph. If it changes a claim in README.md or DEMO.md, say which claim. -->

## Why

<!-- Link the issue, or state the problem. -->

## Proof

<!-- Paste real output, not a description of it. -->

```
forge test        →
node script/test.mjs  →
```

## Checklist

- [ ] `forge test` passes locally
- [ ] `node script/test.mjs` and `node script/headline.mjs` pass (offline, deterministic)
- [ ] New Solidity has a test; coverage stays at or above the 80% floor
- [ ] **I did not run `forge fmt` on `src/`** — it changes the source metadata hash in the runtime
      bytecode and invalidates attestations against already-deployed contracts (see CONTRIBUTING.md)
- [ ] `solc` version and optimizer settings in `foundry.toml` are unchanged, or the change is the
      entire point of this PR and is called out above
- [ ] Any new attacker contract is registered in the corpus truth table in `script/lib/corpus.mjs`
- [ ] Every number added to docs is greppable in the repo or backed by an explorer link
- [ ] No secrets, keys, or `.env` content in the diff
