description: Verified and strengthened the tests that prove copy-on-write trees correctly clone shared nodes when an insert splits them, so the node-linking bug class can't slip through on the insert path.
prereq: test-infra-cow-invariants
files: test/b-tree.cow-insert.test.ts, test/b-tree.cow-delete.test.ts (reference), test/helpers/invariants.ts, test/helpers/rng.ts, src/b-tree.ts (read-only reference)
difficulty: medium
----
Completed **cow-insert-split-tests** through review. The implement stage added `test/b-tree.cow-insert.test.ts` (14 tests), the structural twin of `test/b-tree.cow-delete.test.ts` for the copy-on-write insert/split path. Review verified the suite's claims, found one over-claim, fixed it inline, and confirmed the build is green. **No `src/` changes** — this is a test-quality ticket (`git diff src/` is empty after review).

## What the suite guards

The landed COW fix lives in `replaceRootward` (`src/b-tree.ts:772`): when a freshly-cloned child must be linked into an **already-owned** ancestor, the old code returned without re-linking, orphaning the clone and leaving the owned ancestor pointing at a stale base node → dropped / phantom-duplicated keys on iteration. The insert path runs the *same* rootward re-linking (`leafInsert` → `mutableLeaf`, then `branchInsert` → `mutableBranch` → `replaceRootward`, `src/b-tree.ts:551,578,756,772`). The discriminating insight: a fresh clone must link into an ancestor the child *already owns* from an earlier, unrelated write — i.e. **interior bands, multiple distinct regions, and scattered keys** are the teeth; append/prepend are controls only.

## Review findings

**Checked:** the implement-stage diff (test-only; `src/` untouched, re-confirmed); the full test file read line-by-line; the prereq helpers it leans on (`assertTreeInvariants` / `assertOwnershipInvariant` / `snapshotBase` in `test/helpers/invariants.ts`, `lcg`/`lcgInt`/`shuffle` in `test/helpers/rng.ts`); the insert/split source path in `src/b-tree.ts`; the delete twin for genuine mirroring; lint/type-check and the full test suite.

**Found & fixed (minor, inline):**
- **The "branch split" test did not actually split a non-root branch.** The implement handoff claimed it did ("confirmed via offline calibration"), but with the committed inputs (`freshBlock(105000, 600)` on a 2100-key base) the targeted intermediate branch only grew from 33 to 51 children — never crossing `NodeCapacity` (64) — so **no intermediate `branchInsert` split ever occurred.** The test passed purely as a generic correctness check, leaving the non-root branch-split propagation path it was named for **uncovered**. (This path is distinct from the root-split case: at the root a split makes a new root; at an intermediate branch the split is absorbed by the parent's `branchInsert`.) Empirically confirmed via a structural probe across several sizes.
  - **Fix:** recalibrated the case to `freshBlock(120000, 1500)`, which concentrates enough inserts in one intermediate branch's region to push its child count past `NodeCapacity`, splitting it and promoting a child up to the (still 2-child) root without deepening the tree. Added an `expectNonRootBranchSplit` option to `checkInsertScenario` that **hard-asserts** the split happened: tree depth unchanged AND root child count increased (verified: root children 2→3, depth stays 2). The case can no longer silently stop exercising its path. Added a `rootChildCount` helper to support the assertion.
  - This also tightens the implement-stage "calibrated magic sizes" gap: both split-type tests (root split via the existing depth assertion, branch split via the new one) now fail **loudly** if a future `NodeCapacity` / base-size change stops triggering the split, rather than silently degrading to a plain correctness check.

**Verified (no change needed):**
- **Bug-catching proof re-run.** Re-injected the original `replaceRootward` bug (return without `seg.node.nodes[seg.index] = prior`). Result: **6 of 14 fail** — exactly the discriminating tests (multi-region, both scattered seeds, per-step, multi-level inheritance, differential). Front-anchored controls (append/prepend) and single-region leaf/branch-split tests **pass under the bug**, empirically confirming the header's rationale that non-front-anchored / multi-region inserts are required to trip the re-link bug. Source restored afterward; `git diff src/b-tree.ts` empty.
- **Genuine mirror of the delete suite** — same non-front-anchored / per-step / multi-level / differential structure, plus insert-specific root-split and branch-split sections (delete has the analogous cascade-to-empty section).
- **Base-immutability and ownership** are asserted after every region / per-step / sample via the prereq helpers, with bidirectional `liveSet` equality against a shadow model.

**Checked, accepted as out-of-scope (no new ticket):**
- **Integer keys only** — matches the delete suite and the rest of the test conventions; float/object-key/custom-comparator coverage is a project-wide test-breadth concern, not specific to this path.
- **Differential mixes 30% deletes / sampled invariants every 200 ops / three fixed seeds** — intentional and consistent with the delete suite; deterministic by design. No correctness risk identified.

None of the remaining items rise to a **major** finding; no new fix/plan/backlog ticket filed.

## Validation performed (review)

- `npx tsc --noEmit -p tsconfig.json` → clean.
- New file alone: **14 passing** (~2 s). Full suite (`test/**/*.test.ts`) → **138 passing** (~18 s).
- Working tree after review: only `test/b-tree.cow-insert.test.ts` modified; `git diff src/` empty; no scratch/probe files left.
- No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.
