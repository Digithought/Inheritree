description: Our deletion-rebalancing tests only cover medium-sized trees; very large trees (deep enough to have an extra internal layer) take a different rebalancing path that no test currently exercises. Add coverage for that path.
prereq:
files: test/b-tree.cow-fork.test.ts, src/b-tree.ts (rebalanceBranch / branchSibSegments)
difficulty: medium
----
The `cow-fork-and-deep-chains` work fixed a real branch-rebalance bug in `rebalanceBranch` and added a
"depth-2 branch rebalance under copy-on-write" group that exercises `branchSibSegments` at the level where
the bug reproduced. The fix is written to be **depth-general** (`branchSibSegments` operates on
`segments[depth - 1]` for any `depth`, and `rebalanceBranch` recurses rootward), but there is **no test that
forces a borrow/merge cascading across two branch levels** (i.e. `branchSibSegments` invoked at `depth >= 2`).

The implement handoff claimed the randomized differential "can push the tree to depth 3" — that is not true.
With `NodeCapacity = 64`, a `depthOf >= 3` tree (root → branch → branch → leaves) requires more than
~64*64*32 ≈ 131k entries; the existing differential caps the working set at ~2100–4000 keys via its `FLOOR`,
so it stays strictly depth-2. The deeper cascade path is therefore **entirely uncovered**, not "incidental."

## Use case / expected behavior

A delete on a copy-on-write child of a genuinely depth-3 base, targeting a min-fill leaf whose merge
underflows its parent branch *and* cascades to underflow that branch's parent, must:

- leave the child functionally correct (exactly the deleted key gone, both iteration directions agree),
- keep all ancestors / the base pristine (key set, value set, reachable-node identities),
- keep the child's cloned spine connected and base-disjoint (`assertOwnershipInvariant`),

with the borrow/merge re-linking cloned sibling branches into the correct parent slot at **every** level it
cascades through — the depth-general extension of the fixed bug.

## Notes / risks for the implementer

- **Cost is the central tradeoff.** Building a depth-3 tree needs >~131k inserts, which is far heavier than
  anything currently in the suite (the depth-2 groups already dominate this file at ~11s). Options, roughly in
  order of preference: (a) construct the depth-3 tree once and reuse it across the assertions; (b) keep the
  op-count small and rely on sampled invariant checks (as the depth-2 groups do) rather than per-op O(n)
  re-validation; (c) if wall-clock exceeds the ~10-minute agent/idle ceiling, mark it as a slow/CI-only test
  rather than part of the default `npm test`. Document whichever path is taken.
- `NodeCapacity` is not configurable (src/b-tree.ts), so the depth cannot be lowered to make this cheaper —
  the entry count is the only lever.
- The depth-2 regression in `test/b-tree.cow-fork.test.ts` ("regression: one interior delete ...") is the
  template; this is its depth-3 analogue (probe for an interior min-fill leaf whose parent branch is also at
  min fill so the merge cascades two levels).
