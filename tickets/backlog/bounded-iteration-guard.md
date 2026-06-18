description: When the tree's internal structure gets corrupted, walking through it can loop forever and exhaust memory instead of failing quickly with a clear error; add a safety limit so corruption surfaces loudly and fast.
prereq:
files: src/b-tree.ts (internalNext/internalPrior/moveNext/movePrior), test/helpers/invariants.ts
difficulty: medium
----
A copy-on-write borrow/merge bug (fixed under `cow-fork-and-deep-chains`) could alias a node into the
mutable spine such that forward/backward iteration never terminates: the cursor's `path.branches` grows
without bound and `ascending`/`descending` (and any invariant check built on them) hangs and eventually
OOMs the process rather than throwing. A hung CI box is a far worse failure mode than a thrown assertion —
it gives no signal about *what* broke and burns the whole idle budget.

## Use case / expected behavior

A future structural-corruption regression (in COW rebalance, split, or path remapping) should fail **fast
and loud** — a thrown error naming the problem — not hang. Concretely:

- Iteration (`internalNext` / `internalPrior`, and the public `moveNext` / `movePrior` / `ascending` /
  `descending`) should not be able to visit more nodes/steps than the tree could legitimately contain.
- When that ceiling is crossed, throw a descriptive error (e.g. "iteration exceeded N steps; tree structure
  is likely corrupt") instead of looping.

This is a defensive guard, not a correctness fix — the underlying COW bug is already fixed. It exists so the
*next* such bug is caught by a clean test failure instead of a timeout.

## Notes / open questions for the implementer

- A natural ceiling is the tree's entry count (`getCount`) plus a small slack, or a depth bound on
  `path.branches.length`. Pick whichever is cheap enough not to regress the hot iteration path — this is
  performance-sensitive code (see readme "Performance"), so prefer an O(1)-per-step counter over anything
  that re-walks state.
- The connectivity DFS in `test/helpers/invariants.ts` already added a `seen` guard for the same class of
  problem (`collectReachableNodes`); the related helper-review ticket flagged that the ownership-connectivity
  recursion (`visitConnectivity` / `visitShared`) has no cycle guard either — worth folding in here so a
  corrupt aliased spine can't loop the validators themselves.
- Confirm the guard does not fire on any legitimate tree (the existing 159 tests, especially the large
  depth-2 drains in `test/b-tree.cow-fork.test.ts`, are the floor).
