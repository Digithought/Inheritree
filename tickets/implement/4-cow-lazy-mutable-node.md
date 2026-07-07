----
description: Speed up edits to trees that don't share history so they no longer pay a hidden bookkeeping cost meant only for shared, snapshot-style trees.
prereq:
files: src/b-tree.ts (mutableLeaf, mutableBranch, leafSibPath, branchSibSegments, rebalanceLeaf, rebalanceBranch call sites), bench/
difficulty: medium
----
This ticket fixes two related copy-on-write (COW) inefficiencies in the mutable-node layer, discovered together in code review (findings F3 and F4). They share the same call sites and are cleanest to fix in a single refactor.

## Background

The tree supports lightweight derivation: a derived tree shares structure with its `base` and clones nodes only when it first writes to them (copy-on-write). A tree with `this.base === undefined` is a "plain" tree that owns everything and never needs to clone. Ownership is upward-closed: if a node is owned by `this`, all its ancestors are owned too (the ownership invariant that the test suite formalizes as `assertOwnershipInvariant` check 1).

`mutableLeaf` and `mutableBranch` are the choke points that return a writable node, cloning along the spine when necessary. During rebalancing (`rebalanceLeaf`, `rebalanceBranch`), the code also needs writable sibling nodes, reached via `leafSibPath` and `branchSibSegments`.

## F3 — COW plumbing taxes plain (non-derived) trees

The eager preparation of clone material happens on every borrow/merge/split even when no clone can possibly be needed:

- `leafSibPath` clones the entire branch array plus a fresh `PathImpl`, only for `mutableLeaf` to take the no-base fast path and discard it.
- `branchSibSegments` likewise allocates a cloned segment list per branch borrow/merge.
- Every `mutableBranch` call site pre-allocates `path.branches.slice(0, depth + 1)` before the callee can early-return on `!this.base`.
- `leafSibPath` also fabricates a `leafIndex` that is meaningless in the sibling leaf and only harmless because nothing reads it.

Fix shape: make laziness the callee's responsibility. Pass the raw coordinates — `(path, depth)` for the main spine, and `(path, depth, sib, delta)` for siblings — and let `mutableLeaf` / `mutableBranch` construct the slice or sibling segment list only after they have decided a clone is actually required. Drop the fabricated `leafIndex`.

## F4 — mutableBranch does wasted work when the spine is already owned

For a derived tree that has already cloned its write path — the steady state for any write-heavy child — every subsequent `mutableBranch` call still allocates a `Map`, calls `replaceRootward` (which returns immediately at the first owned segment), then runs `mainPath.remap`, an O(depth) loop of `map.get` against an empty map.

`mutableLeaf` already has the ownership fast path; `mutableBranch` is missing its twin:

```ts
const branch = segments.at(-1)!.node;
if (!this.base || branch.tree === this) {
    return branch;   // owned => all ancestors owned (upward-closed ownership invariant)
}
```

This is justified by the upward-closed ownership invariant: an owned bottom-most branch implies all ancestors on the spine are owned.

Combined with F3, the entire mutable-node layer becomes allocation-free except when a clone genuinely occurs.

## Benchmarking

Upstream v1.5.0 shipped a `bench/` harness built on tinybench. Benchmark this fork against upstream Digitree on a delete-heavy workload BEFORE and AFTER this change to quantify the win. Delete-heavy is chosen because borrow/merge cascades exercise both the sibling paths (F3) and repeated `mutableBranch` calls on an owned spine (F4).

## Edge cases & interactions

- Single-level base chain vs multi-level base chains: the fast path keys off `branch.tree === this`, which must remain correct regardless of chain depth.
- Owned-spine steady state (the F4 target): the very first write still clones; only subsequent writes on the already-owned spine hit the fast path.
- Plain (no-base) trees: must never allocate clone material; verify `leafSibPath` / `branchSibSegments` work is fully deferred.
- Borrow/merge partition re-linking must stay correct at every cascade level — moving slice construction into the callee must not change which nodes get re-parented or in what order.
- The dropped `leafIndex` must be confirmed unused everywhere before removal.

## TODO

- Change `mutableLeaf` to accept `(path, depth)` and build the spine slice internally only after the clone decision.
- Change `mutableBranch` to accept `(path, depth)` for the main spine and `(path, depth, sib, delta)` for siblings; build slices / sibling segments lazily.
- Add the ownership fast path to `mutableBranch` (return the bottom branch immediately when `!this.base || branch.tree === this`).
- Remove the eager clone in `leafSibPath`; have `mutableLeaf` derive the sibling path when a clone is needed.
- Remove the eager clone in `branchSibSegments`; have `mutableBranch` derive sibling segments when a clone is needed.
- Remove the fabricated `leafIndex` in `leafSibPath` after confirming no reader depends on it.
- Update all `mutableLeaf` / `mutableBranch` call sites in `rebalanceLeaf` / `rebalanceBranch` (and elsewhere) to the new coordinate-passing signatures.
- Verify `assertOwnershipInvariant` still holds across the test suite.
- Run the `bench/` delete-heavy workload before and after; record fork-vs-upstream numbers.
