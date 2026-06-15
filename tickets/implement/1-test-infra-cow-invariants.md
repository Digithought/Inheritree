description: Shared invariant validator + seeded RNG, extended with COW ownership invariant
files: test/helpers/invariants.ts (new), test/helpers/rng.ts (new), src/b-tree.ts, src/nodes.ts, src/path.ts
difficulty: medium
----
Foundational test-infra ticket; the other COW tickets depend on it. The COW-delete rebalancing bug (fixed in `src/b-tree.ts` — `replaceRootward`/`leafSibPath`, with regression coverage in `test/b-tree.cow-delete.test.ts`) survived because the COW stress test was too shallow and unseeded, and there is no reusable structural or **ownership** validator. This ticket adds the helpers, including the ownership check that targets this exact bug class.

## Structural validator — `test/helpers/invariants.ts`

Port (or re-author) `assertTreeInvariants(tree, opts?)` matching the DigiTree ticket of the same name: uniform leaf depth; non-root fill in `[NodeCapacity>>>1, NodeCapacity]` (root exempt); `partitions.length === nodes.length-1`; partition separation with `p[i] === min-key(subtree n[i+1])`; strictly-increasing in-order keys; ascending === reverse(descending) === sorted; `getCount()` === traversal count. Reach the root via `(tree as any)['_root']`; use the public `tree.compare`/`tree.keyFromEntry` so it is key-type-agnostic.

## COW ownership invariant — `assertOwnershipInvariant(child, base)`

This is Inheritree-specific. Nodes carry a `.tree` owner (`src/nodes.ts`) and COW clones rootward (`replaceRootward`, `src/b-tree.ts:764`). The escaped bug was "an owned ancestor keeps pointing at a stale base node," which leaves a child-owned node unreachable / a base node aliased into the child's mutable spine. Encode the rule that ownership is **upward-closed from the child's root**:

1. Traverse from `child.root`. Track whether the current path has crossed from child-owned territory into base-owned territory. Assert that **once you pass through a node not owned by `child`, no descendant is owned by `child`** (i.e. every child-owned node's ancestors within the reachable tree are also child-owned — the COW spine is connected from the root).
2. **Base immutability**: snapshot `base`'s full ordered key list (and its node object identities for the touched region if practical) before the child mutates, and assert after the child's operations that `base`'s key list and `assertTreeInvariants(base)` are unchanged.
3. Optionally assert no node object reachable from `child.root` that is owned by `child` is also reachable from `base.root` (no shared *mutable* node).

## Seeded RNG — `test/helpers/rng.ts`

Promote the LCG currently inlined at `test/b-tree.cow-delete.test.ts:123` into `lcg(seed)`, plus `lcgInt(rng, lo, hi)` and a Fisher–Yates `shuffle(arr, rng)`. Reproducible failures.

TODO
- Add `test/helpers/invariants.ts` with `assertTreeInvariants` and `assertOwnershipInvariant`.
- Add `test/helpers/rng.ts`.
- Add a self-test that builds a known-broken COW linkage (or simulates the pre-fix behavior) and asserts `assertOwnershipInvariant` throws, so the validator is trusted.
- Wire the helpers into `test/b-tree.cow-delete.test.ts` (replace its inline `lcg`) without weakening its existing assertions.
- Keep `npm test` green.
