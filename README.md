[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/ASEP9929/makefun-png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/ASEP9929/makefun-png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

# PNG Squeeze — smallest lossless PNGs for screenshots

A lossless PNG recompressor for the
[make.fun png-squeeze-01 bounty](https://make.fun/bounty/png-squeeze-01-run-20261127):
it rewrites each 1280×720 RGBA screenshot as the smallest PNG it can, keeping
every pixel — including fully transparent pixels' colours — byte-exact.

## How it works

- **Decode** the stored input PNG to raw RGBA.
- **Pick the smallest lossless form** per image: a palette (type 3) when there
  are at most 256 colours, grey (type 0) or grey+alpha (type 4) for grey
  images, RGB (type 2) or RGBA (type 6) otherwise — with a `tRNS` key instead
  of an alpha channel when every non-opaque pixel is one fully-transparent
  value no opaque pixel uses.
- **Pick per-row PNG filters** (fixed, minimum signed-sum, fewest distinct
  pairs, or brute force by real deflate cost) and weigh every candidate with
  zlib, keeping the smallest.
- **Re-encode the winner with a zopfli-style optimal-parse DEFLATE encoder**
  written from scratch in this file: LZ77 with hash chains plus explicit
  structural distances (a run, the same column one or two rows back),
  shortest-path dynamic programming over a bit-cost model, iterated Huffman
  length refinement (package-merge for length-limited codes), and 256 KiB
  blocks each with their own Huffman tables. Deterministic: fixed work per
  image, no clock, no randomness — two runs are byte-identical.

## Run

```sh
node main.ts
```

Reads `$MAKEFUN_INPUT_DIR` (default `/input`), writes `$MAKEFUN_OUTPUT_DIR`
(default `/output`), one `image.png` per instance. Node 22+, no dependencies,
no network. The whole set of 8 runs in about 30 seconds on one CPU, inside
the 60-second wall.

## About

Built for the make.fun png-squeeze-01-run-20261127 bounty. MIT licensed.
