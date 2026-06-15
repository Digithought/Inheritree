description: Harden the COW randomized stress test (was structurally unable to catch the bug)
prereq: test-infra-cow-invariants
files: test/cow.test.ts
difficulty: medium
----
Direct fix for *why the COW-delete bug escaped*. The randomized COW stress test (`test/cow.test.ts:325`) cannot exercise the buggy path:

- `INITIAL_BASE_SIZE = 50` < `NodeCapacity = 64` (`test/cow.test.ts:328`) → the **base tree is a single leaf with no branches**, so it never rebalances. The delete-rebalance re-linking bug only occurs in multi-level trees where a sibling is still owned by `base` while the deleted leaf is owned by the child.
- It uses unseeded `Math.random()` (`:358`) → failures are unreproducible.
- Verification walks **ascending only** (`getAllEntries`, `:6`) and checks the shadow `Map` only every 200 ops at the end — a phantom-repeat / drop on the reverse direction can hide.

Rework it (or add a sibling test) to actually stress the COW rebalance path.

TODO
- Raise the base well above `NodeCapacity` (e.g. 300–500 entries) so `base` is genuinely multi-level; keep a deterministic variant plus the existing object-entry shape.
- Replace `Math.random()` with the seeded `lcg` from `test/helpers/rng.ts`; log the seed so a failure reproduces.
- Bias the op mix toward delete (the path under test) and ensure deletes hit **interior/non-front-anchored** keys (front-anchored deletes only ever borrow/merge right and dodge the bug — see `test/b-tree.cow-delete.test.ts` header).
- After each op (or a tight sampling interval), assert `assertTreeInvariants(derived)`, `assertOwnershipInvariant(derived, base)`, and bidirectional set-equality vs the shadow `Map`.
- Assert `base` stays pristine (keys + invariants) throughout, not just at the end.
- Preserve the existing `clearBase` and isolation tests; only strengthen the randomized section.
