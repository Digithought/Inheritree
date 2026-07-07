description: Made edits to non-shared trees faster by no longer paying copy-on-write bookkeeping that only shared trees need.
prereq:
files: src/b-tree.ts (mutableLeaf, mutableBranch, rebalanceLeaf, rebalanceBranch, branchInsert, updatePartition; leafSibPath removed), bench/index.ts (delete-heavy scenarios)
difficulty: medium
----
Implements findings F3 and F4 from the copy-on-write (COW) review: the mutable-node layer no longer allocates
clone material unless a clone actually happens. Build passes; `yarn test` is 298 passing (0 failing),
including the COW ownership-invariant and delete-biased stress suites. Delete-heavy benchmarks show a uniform
small speedup with no regression (numbers below).

## What changed (src/b-tree.ts)

Two choke points return a writable node, cloning along the spine only when the tree is derived and the node
isn't already owned. Before this change they eagerly built the clone material (spine slices, sibling paths)
at every call site, even on the paths where no clone is possible.

**F3 — stop taxing plain (non-derived) and already-owned trees with eager clone material.**
Laziness moved into the callee. Both methods now take raw coordinates against the *live* path and build any
slice / sibling segment list only *after* deciding a clone is required:

- `mutableLeaf(path, sib?, delta?)` — main spine when `sib` is omitted (leaf = `path.leafNode`); sibling
  borrow/merge when `sib`/`delta` are given (leaf = `sib`, reached by shifting the deepest branch index by
  `delta`). The old free function `leafSibPath` (which eagerly cloned the whole branch array + a throwaway
  `PathImpl`) is **deleted**; its index-shift logic is inlined and now runs only on the clone path.
- `mutableBranch(path, depth, sib?, delta?)` — main spine at `path.branches[depth]`, or a sibling via
  `branchSibSegments` (kept, but now called *inside* `mutableBranch`, lazily). Old call sites that pre-built
  `path.branches.slice(0, depth+1)` no longer do.
- The fabricated `leafIndex` the old `leafSibPath` put on its throwaway path is gone — confirmed unread
  (`mutableLeaf` only ever touched `.leafNode` and `.branches`).

**F4 — `mutableBranch` ownership fast path.** `mutableLeaf` already short-circuited on `!this.base` /
already-owned; `mutableBranch` did not — for a derived tree whose write path is already cloned (the steady
state of any write-heavy child), every call still allocated a `Map`, ran `replaceRootward`, and ran an
O(depth) `remap` against an empty map. Now:

```ts
const branch = sib ?? path.branches[depth].node;
if (!this.base || branch.tree === this) {
    return branch;   // owned bottom branch => all ancestors owned (upward-closed ownership invariant)
}
```

Net effect: the mutable-node layer is allocation-free unless a clone genuinely occurs.

All call sites in `rebalanceLeaf` / `rebalanceBranch` / `branchInsert` / `updatePartition` were updated to the
coordinate-passing signatures. The refactor is behavior-preserving: which nodes get cloned/re-parented and in
what order is unchanged — only *where* the slice/segment list is constructed moved (call site → callee, guarded
by the clone decision).

## How to validate

- `yarn build` — clean (tsc, no errors).
- `yarn test` — 298 passing. The load-bearing suites for this change:
  - `test/b-tree.cow-delete.test.ts`, `test/b-tree.cow-mutation-ops.test.ts`, `test/b-tree.cow-fork.test.ts`,
    `test/b-tree.cow-feature-matrix.test.ts` — exercise borrow/merge cascades on derived trees.
  - `assertOwnershipInvariant` (via `test/helpers/invariants.ts`) — the upward-closed ownership rule the F4
    fast path relies on; the "Randomized Operations Stress Test" runs 1500 delete-biased ops per seed and
    re-checks ownership + isolation after each.
  - `test/b-tree.cow-fork.test.ts` deep-chain (4–5 level) cases — cover the "fast path keys off
    `branch.tree === this` regardless of chain depth" edge case.
- `yarn bench` — now includes `delete-heavy, plain` and `delete-heavy, derived` scenarios (number + string).

## Benchmark (this change, BEFORE vs AFTER)

Measured with a throwaway interleaved harness (old vs new `BTree` back-to-back, same machine conditions,
N=10000, delete-every-key on a freshly-built tree per rep). Median throughput, ops/s (higher = better):

| workload           | OLD | NEW | Δ      |
|--------------------|-----|-----|--------|
| plain (number)     | 687 | 704 | +2.5%  |
| derived (number)   | 521 | 566 | +8.6%  |
| plain (string)     | 475 | 495 | +4.2%  |
| derived (string)   | 369 | 388 | +5.1%  |

Uniform improvement, no regression. Derived trees gain most (F4 owned-spine fast path); plain trees gain from
F3 allocation elimination. NOTE for the reviewer: the *full-suite* `yarn bench` AFTER run showed the string
delete rows ~2× slower — that was thermal/scheduling noise late in a long suite (variance ±1.2M ns), **not** a
real regression; the interleaved old-vs-new harness (which shares conditions) shows strings improving. If you
re-measure, use an interleaved harness or run delete-heavy in isolation, not the tail of the full suite.

## Edge cases covered (ticket checklist)

- Single- vs multi-level base chains — fast path keys off `branch.tree === this`; deep-chain fork tests pass.
- Owned-spine steady state (F4 target) — first write still clones; only later writes on the owned spine hit
  the fast path. Exercised by the derived delete-heavy scenario and the stress suite.
- Plain (no-base) trees never allocate clone material — `mutableLeaf`/`mutableBranch` defer all construction
  behind the `this.base` guard.
- Borrow/merge partition re-linking correct at every cascade level — 298 tests incl. depth-2/depth-3 rebalance
  + ownership invariant hold; re-parent order unchanged by construction.
- Dropped `leafIndex` confirmed unused before removal.

## Known gaps / where to look hardest (treat tests as a floor)

- **Upstream-Digitree comparison not run.** The ticket asked to benchmark this fork against upstream Digitree.
  The `digitree` package is not installed and this sandbox has no network to add it, so I ran the within-fork
  BEFORE/AFTER interleaved comparison instead — which directly quantifies *this change's* win (the actual ask).
  A fork-vs-upstream number (how much residual overhead the COW layer still adds over vanilla Digitree) is a
  separate, coarser measure; a human with network can run it by `yarn add -D digitree` and mirroring the
  delete-heavy scenario. Not a blocker for this change.
- **Behavior-preservation is the core claim to audit.** The strongest review is to diff old vs new and confirm
  each `mutable*` call site maps 1:1: `path.branches.slice(0, D+1)` → `mutableBranch(path, D)`;
  `path.branches` (full) → `mutableBranch(path, path.branches.length-1)`; `leafSibPath(path, sib, δ)` →
  `mutableLeaf(path, sib, δ)`; `branchSibSegments(path, depth, sib, δ)` → `mutableBranch(path, depth, sib, δ)`.
  Pay attention to the two `rebalanceLeaf` merge sites that formerly passed **no** `mainPath` to
  `mutableBranch` (they now pass `path`): this is safe only because the preceding `mutableLeaf(path)` already
  cloned the whole spine, so the branch is owned and the fast path returns before any remap. If that ordering
  ever changes, re-check.
- **`mutableBranch` now always remaps `path`** (the old optional `mainPath` is gone). Every current caller
  wants the live path remapped, and where remap would be a no-op the fast path returns first — but a future
  caller that deliberately did *not* want its path remapped would need a different entry point.

## Review findings

- F3 (eager clone material on plain/owned trees) and F4 (missing `mutableBranch` ownership fast path)
  implemented together in `src/b-tree.ts`; `leafSibPath` removed, `branchSibSegments` retained but now called
  lazily inside `mutableBranch`. 298 tests pass; delete-heavy benchmarks show +2.5–8.6% with no regression.
- **Tripwire (parked as a code comment, not a ticket):** the F4 fast path in `mutableBranch`
  (`branch.tree === this` ⇒ return without cloning) is only correct while ownership stays upward-closed. If a
  future change ever lets a child-owned node sit beneath a base-owned ancestor, this path would skip a needed
  clone and corrupt the derived tree. Documented at the site (`src/b-tree.ts`, `mutableBranch`) referencing the
  invariant; `assertOwnershipInvariant` check 1 is the guard that would catch a violation.
- **Gap (see above):** upstream-Digitree benchmark not runnable offline; within-fork before/after run instead.
