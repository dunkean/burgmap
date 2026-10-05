# polygon-clipping vendor

- Upstream: [mfogel/polygon-clipping](https://github.com/mfogel/polygon-clipping), npm `polygon-clipping@0.15.7`.
- Source artifact: `dist/polygon-clipping.esm.js`, copied from the installed locked package.
- Original artifact SHA-256: `766d182d2908c03d19608f90837e870a99df42c313c537363d2a0adb0f44baaa`.
- Licence: the exact upstream MIT text is in `polygonClipping.LICENSE.md`.
- Dependencies: upstream imports of the already installed `splaytree` and `robust-predicates` remain unchanged; no new dependency is introduced.

The only code edits bound `SweepLine.process`'s consumed predecessor and successor loops independently by a snapshot of `this.tree.size + 1`. A finite tree cannot contain a longer distinct neighbour chain. Exceeding this bound throws an invariant error; it does not return a partial clipping result. The existing geometry wrapper owns its unchanged coarse retry and checked failure handling. There is no clock, wall-time threshold, new geometry heuristic, or alteration to the comparator.

A TypeScript `ts-nocheck` and attribution header isolate the mechanically copied foreign module. The upstream environment guards are unchanged. Removing that header and reversing the two documented guard insertions reproduces the original artifact byte for byte; the regression verifies its SHA-256. Other upstream traversal loops and every normal operation are untouched.
