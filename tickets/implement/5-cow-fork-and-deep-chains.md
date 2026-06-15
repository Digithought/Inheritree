description: Multi-child fork isolation and deep (4+ level) inheritance chains
prereq: test-infra-cow-invariants
files: test/b-tree.cow-fork.test.ts (new), src/b-tree.ts
difficulty: medium
----
Two untested COW shapes, both high-value because inheritance/forking is the point of this library.

**Multi-child fork.** Nothing tests two (or more) COW children created from the *same* base and mutated independently. This is the classic aliasing bug: child A's rebalance accidentally mutates a node still shared with `base`, and child B (or `base`) sees the corruption. With the shared base read through `base.root` (`src/b-tree.ts:29-38`), correctness depends entirely on COW never mutating a base-owned node in place.

**Deep chains.** `test/b-tree.cow-delete.test.ts` covers base → mid → leaf (3 levels). Chains of 4+ levels, where a mutation on the deepest child must clone rootward through several *un-owned* ancestors, are uncovered.

TODO
- Fork two children A and B off one multi-level base; apply **different** non-front-anchored delete/insert sets to each; after each step assert: A matches its expected set, B matches its expected set, `base` is pristine, and `assertOwnershipInvariant(A, base)` / `(B, base)` hold. Confirm A's mutations never appear in B.
- Stress with 3+ concurrent children over a seeded interleaved op stream (`test/helpers/rng.ts`), each with its own shadow `Map`.
- Build a 4–5 level inheritance chain (base → c1 → c2 → c3 → c4); mutate the deepest child with interior keys; assert every ancestor keeps its own expected state and the deepest child's COW spine is connected through all the un-owned levels it cloned.
- A delete on the deepest child that triggers a borrow/merge against a sibling owned several levels up — the rootward-clone-through-unowned-ancestors path.
