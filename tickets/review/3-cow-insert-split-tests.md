description: Added tests proving copy-on-write trees correctly clone shared nodes when an insert splits them, mirroring the existing delete-side tests so the same node-linking bug class can't slip through on the insert path.
prereq: test-infra-cow-invariants
files: test/b-tree.cow-insert.test.ts (new), test/b-tree.cow-delete.test.ts (mirror), test/helpers/invariants.ts, test/helpers/rng.ts, src/b-tree.ts (read-only reference)
difficulty: medium
----
Implemented **cow-insert-split-tests**. Test-quality ticket — **no `src/` changes** (verified: `git diff src/` is empty). Added one new file, `test/b-tree.cow-insert.test.ts` (14 tests), the structural twin of `test/b-tree.cow-delete.test.ts` for the COW **insert/split** path.

## What this guards

The landed COW fix lived in `replaceRootward` (`src/b-tree.ts:772`): when a freshly-cloned child node must be linked into an **already-owned** ancestor, the old code returned without re-linking, orphaning the clone and leaving the owned ancestor pointing at a stale base node → dropped / phantom-duplicated keys on iteration. That fix was driven by the **delete** rebalance suite. The **insert** path runs the *same* rootward re-linking — `leafInsert` → `mutableLeaf`, then `branchInsert` → `mutableBranch` → `replaceRootward` (`src/b-tree.ts:551,578,756,772`) — and was previously only covered by single-leaf-base inserts in `test/cow.test.ts`, so branch cloning on the insert path at scale was unverified. This file closes that gap.

The discriminating insight (mirrored from the delete header): **appending past the max only ever splits the right-most leaf onto the spine the child already cloned, so it dodges the re-link bug.** The bug only bites when a fresh clone must link into an ancestor the child *already owns* from an earlier, unrelated write — i.e. **interior bands, multiple distinct regions, and scattered keys.** Those are this suite's teeth; append/prepend appear only as controls.

## Test inventory (use cases / validation)

Base trees use a `stride` so insertable integer gaps exist between base keys (base keys = `stride, 2·stride, …`); COW inserts target those gaps so they land in interior, base-owned leaves. All assertions use the prereq helpers `assertTreeInvariants` / `assertOwnershipInvariant` / `snapshotBase` plus bidirectional `liveSet` equality.

- **leaf splits in base-owned regions** (3 tests) — dense interior block / wider band / near-tail band force a base-owned leaf to split; verifies the child clones the leaf + its branch ancestors, base untouched.
- **branch and root splits cascade into the child only** (2 tests):
  - *root split* — a near-full 2-level base (~62 root children, 2000 keys) + a 600-key dense interior block overflows the cloned root branch, creating a **new, deeper root owned by the child** (asserted: `depthOf(child) > depthOf(base)`, base depth unchanged, `child.root.tree === child`).
  - *branch split* — a 3-level base (2100 keys); a dense block cascades leaf splits into an intermediate branch (the `branchInsert`→split→propagate path) while the base stays pristine.
- **multiple distinct regions clone independently** (1 test) — 4 separated interior regions; after the first the child owns its root, so every later region must re-link into the already-owned spine; invariants + base-pristine re-checked after each region.
- **non-front-anchored insert sets** (5 tests) — interior band, two scattered seeded streams (`0xC0FFEE`, `0x9E3779B1`), plus **controls**: pure append (above max) and pure prepend (below min).
- **per-step iteration integrity** (1 test) — 160 scattered inserts one at a time; full ordered set (both directions) + ownership re-verified after *every single* insert.
- **multi-level inheritance** (1 test) — base → mid → leaf; mid does its own inserts, then a dense interior band is inserted on the grandchild; both ancestors proven intact (mirrors the delete suite's block).
- **randomized differential (insert-heavy)** (1 test) — 4000 ops, 70% insert / 30% delete, seeded (`0x5EED1234`), vs a shadow `Set`; structural + ownership + base-pristine sampled every 200 ops.

## Validation performed

- **Bug-catching proof (the important one).** Temporarily re-injected the original `replaceRootward` bug (return without `seg.node.nodes[seg.index] = prior`). Result: **6 of 14 fail** — exactly the discriminating tests (multi-region, both scattered seeds, per-step, multi-level inheritance, differential). The front-anchored **controls (append/prepend) and the single-region leaf-split tests still PASS under the bug**, empirically confirming the header's rationale for why non-front-anchored/multi-region inserts are required to trip it. Source then restored; `git diff src/b-tree.ts` is empty.
- `npx tsc --noEmit -p tsconfig.json` → clean.
- New file alone: **14 passing** (~2 s). Full suite (`test/**/*.test.ts`) → **138 passing** (~18 s).

## Known gaps (honest handoff — reviewer should treat tests as a floor)

- **Branch-split test under-asserts.** The 3-level "branch split" case asserts invariants + base-pristine + correct key set, but does **not** structurally assert that an intermediate (non-root) branch split actually occurred — I confirmed it does via offline calibration, but the test itself would still pass if a future change made those inserts cascade differently (as long as the result stayed correct). The *root*-split case, by contrast, hard-asserts the depth increase. A reviewer wanting teeth here could instrument node counts or assert an intermediate branch's child count crossed `NodeCapacity`.
- **Calibrated magic sizes.** The root-split test depends on `NodeCapacity = 64` and the specific base size (2000 → ~62 root children) so that 600 inserts overflow the root. `NodeCapacity` is a fixed, documented-non-configurable const, but if it ever changes these sizes need recalibration. No assertion fails loudly to flag that — it would just stop exercising a root split silently (the depth assertion would catch a *missing* split, which is the safer failure direction).
- **Integer keys only**, like the delete suite — no float/object-key or custom-comparator coverage on the insert path.
- **Differential test mixes 30% deletes**, which re-exercises the already-covered delete path; that churn is intentional (keeps inserts hitting fresh structural spots) but means it isn't a pure-insert stream.
- **Sampled invariants** in the differential test (every 200 ops) — a transient self-healing corruption between samples is the only theoretical miss; any persistent corruption desyncs the shadow and is caught at the next sample or the per-op `find`/`insert` guard.
- Property-test breadth is three fixed seeds (deterministic by design), not generative fuzzing.

No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.
