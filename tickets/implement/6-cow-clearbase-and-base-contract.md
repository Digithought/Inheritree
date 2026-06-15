description: clearBase after structural COW mutation, plus the base-mutation-while-derived contract
prereq: test-infra-cow-invariants
files: test/b-tree.cow-clearbase.test.ts (new), src/b-tree.ts, readme.md
difficulty: medium
----
Two related correctness edges around the base relationship.

**clearBase at scale.** `clearBase` is tested only on a tiny tree (`test/cow.test.ts:235`). `clearBase` (`src/b-tree.ts:40-43`) just drops the `base` pointer and pins `_root`. After a multi-level COW child has performed real borrows/merges/splits, there is no test that the resulting tree is correct *and* genuinely independent of the former base.

**Base-mutation-while-derived contract.** A derived tree reads `base.root` for any un-owned path (`src/b-tree.ts:29-38`), so mutating a base that still has live derived children can corrupt those children's view. This contract is currently neither documented, guarded, nor tested — a latent landmine. This ticket pins the *current* behavior with tests and documents the rule; if a cheap guard is warranted, note it but do not block on it.

TODO
- Build a multi-level base → COW child; have the child do a substantial non-front-anchored mix of inserts/deletes that forces borrows/merges/splits; call `clearBase()`; then assert: child key set unchanged by `clearBase`, `assertTreeInvariants(child)` holds, and **subsequent mutations to the former base do not affect the child** (and vice-versa). Where practical, assert the child shares no node with the former base after clearBase (extend the ownership helper).
- After `clearBase`, run a follow-up op batch on the now-rootless tree and confirm normal behavior.
- Document in `readme.md` (and a doc comment near `clearBase`/the `base` constructor param) the rule: **do not mutate a base while derived children are live; create children, then treat the base as frozen, or `clearBase` first.** Add a test that pins whatever the current behavior is when the rule is violated (so a future change to add a guard is a visible, intentional diff).
- Decision note for the reviewer: whether to add a runtime guard (e.g. a version/"has-children" check on the base) or leave it doc-only. Default to doc-only unless trivial.
