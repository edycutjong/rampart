# Screenshots

Captured 2026-08-26 from the real product — the pages in `site/` and live runs of the CLI. Nothing
here is a mockup, and no terminal output was typed by hand: each `06`–`08` shot is the actual stdout
of the command in its caption.

**Every file in this folder is referenced by [`../README.md`](../README.md).** Anything that stopped
being referenced was moved out rather than left to rot.

| # | File | Shows | Used in |
|---|---|---|---|
| 01 | `01-viewer-hero.png` | **0.1% of this book cannot be withdrawn** — 11 orders, 2 FIRM, 0 PULLABLE, 9 UNVERIFIED | 📸 See it in Action |
| 02 | `02-viewer-ladder.png` | The ladder with the **REASON** column, FIRM/UNVERIFIED badges, owner chips | 📸 See it in Action |
| 03 | `03-landing-hero.png` | Landing page above the fold | 📽️ Demo Materials |
| 04 | `04-pitch-deck.png` | Pitch deck opening slide | 📽️ Demo Materials |
| 06 | `06-firmness-pinned.png` | `firmness.mjs --block 468201000` → 11 orders, 2 FIRM, 0.1% | ⛓️ Live Deployment |
| 07 | `07-forge-test.png` | `forge test` → 93 passing, 0 failures | 📊 Engineering Rigor |
| 08 | `08-sdk-verify.png` | `npm run sdk-verify` → 35/35 | 📊 Engineering Rigor |

No `05`: the static shot of `headline.mjs` was replaced by the animated
[`site/assets/loop-classifier.gif`](../site/assets/loop-classifier.gif), which shows the same run
building row by row.

## The animated loops

They live in [`../site/assets/`](../site/assets/), not here, because they are synced from the
kitchen masters by the project's media allowlist — the same route as the icon, hero and
architecture diagram.

| File | Shows |
|---|---|
| `loop-classifier.gif` | `headline.mjs` classifying the corpus → **8/8 vs 2/8** · 1440×766 · 259 KB |
| `loop-refusal.gif` | the `cast call` replay → `execution reverted`, caller and expected owner both named · 1440×380 · 136 KB |

Both are cut from the demo video rather than re-recorded, so what loops here is the same footage
judges see on YouTube. They exist because **GitHub will not embed a YouTube video** — a reader who
never clicks out still sees something run.

## Still to capture by hand

The **Shannon explorer page for the failed cancel** —
[`0x959b4770…6ddb`](https://shannon-explorer.somnia.network/tx/0x959b47704d493dd48f2e724f2692facf1609a2cdc738f1a7ceb1fd070b3c6ddb)
showing **status `0x0`**. It is the single strongest image the project has, but it is a third-party
page: capturing it automatically risks shipping a half-loaded render, so grab it in a browser once.

## Specs

All PNG, `deviceScaleFactor: 2` (retina), `pngquant --quality=86-97` — visually lossless.
Desktop 1440×900/980.

Regenerate: `node assets/_shots.cjs` (screenshots) · `bash assets/_gif.sh` (loops) — both kitchen-only.
