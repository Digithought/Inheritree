description: COW coverage for insert-driven splits and rootward branch cloning
prereq: test-infra-cow-invariants
files: test/b-tree.cow-insert.test.ts (new), src/b-tree.ts
difficulty: medium
----
The fix that landed addressed the COW **delete** rebalance path. Its structural twin — COW **insert** that splits nodes and must clone branches rootward — is under-tested. `branchInsert` → `mutableBranch` → `replaceRootward` (`src/b-tree.ts:578`, `:756`, `:764`) runs the same rootward re-linking on the insert side, but `test/cow.test.ts` only inserts into a single-leaf base, so branch cloning on the insert path at scale is unverified. A `replaceRootward` re-link error on insert would drop/duplicate keys exactly like the delete bug did.

Mirror the structure of `test/b-tree.cow-delete.test.ts`, but for inserts, against a multi-level immutable base.

TODO
- Build a base sized `> NodeCapacity` (multi-level), create a COW child, then insert keys into the child that force **leaf splits** in regions still owned by `base` — verify the child clones the leaf and its branch ancestors, base untouched.
- Inserts that force a **branch split** in the child (cascade up `internalInsertAt`, `src/b-tree.ts:480-492`), including the root-split case that creates a new root in the child only.
- Insert into multiple distinct regions so several independent branch clones occur; assert `assertOwnershipInvariant` (the COW spine stays connected) and `assertTreeInvariants` after each.
- Non-front-anchored insert sets (interior bands, scattered seeded keys via `test/helpers/rng.ts`) — not just appends, which can dodge re-link bugs.
- Verify bidirectional key set equals expected and `base` keys + invariants are unchanged throughout.
- Multi-level inheritance (base → mid → leaf) insert on the grandchild, mirroring the delete test's `multi-level inheritance` block.
