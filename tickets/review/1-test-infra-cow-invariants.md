description: Shared B-tree test helpers (a structural checker, a copy-on-write ownership checker, and a seeded random generator) are now in place; review them for correctness and honest coverage before other test tickets build on them.
prereq:
files: test/helpers/invariants.ts, test/helpers/rng.ts, test/invariants.test.ts, test/b-tree.cow-delete.test.ts, src/b-tree.ts, src/nodes.ts, src/path.ts
difficulty: medium
----
Implemented the foundational COW test-infra helpers the other COW tickets (2–7) depend on. `assertTreeInvariants` and the seeded RNG (`lcg`/`lcgInt`/`shuffle`) already existed in the tree from the upstream merge; **this ticket's new work is the COW ownership validator** (`assertOwnershipInvariant` + `snapshotBase` + `BaseSnapshot`), its self-tests, and wiring the shared helpers into `test/b-tree.cow-delete.test.ts` (removing its inline LCG).

No `src/` changes — the COW-delete fix itself already landed (commit 353211c, `replaceRootward`/`leafSibPath`). The `src/*` files are listed only because the validator's correctness is judged against them.

## What was built

**`test/helpers/invariants.ts` — `assertOwnershipInvariant(child, base, snapshot?)`** (appended; `assertTreeInvariants` left intact).
Encodes the rule that a COW child's mutable spine must be *upward-closed from the child's root*. Three checks:
1. **Connectivity** — traversing from `child.root`, once you step through a node not owned by `child` (into base territory), no descendant may be owned by `child`. A child-owned node beneath a base-owned ancestor = a clone grafted below shared structure / a base node aliased into the mutable spine.
2. **Shared-mutable** — no child-owned (mutable) node is also reachable from `base.root` (else a child write corrupts the base in place).
3. **Base immutability** (only when a `snapshot` from `snapshotBase(base)` is passed) — base's ordered key list, its reachable-node *identities*, and `assertTreeInvariants(base)` all match the pre-mutation snapshot.

Owner is read via node `.tree`; roots via the public `child.root`/`base.root` getters → key-type-agnostic.

**`test/invariants.test.ts`** — new `describe('assertOwnershipInvariant ...')` block: 3 accept cases (no-write child; child after an interior-band delete; two forked children) and 4 reject cases (connectivity, shared-mutable, base-mutation-detected, snapshot-gating).

**`test/b-tree.cow-delete.test.ts`** — replaced the inline `lcg` with the shared `rng.ts` helpers (`lcg`/`lcgInt`/`shuffle`) and added **additive** `assertTreeInvariants(cow)` + `assertOwnershipInvariant(cow, base, snap)` calls across the predicate, per-step, cascading, multi-level, and randomized-differential suites. No existing assertion was removed or loosened.

## Validation / usage (the intended consumer pattern)

```ts
const snap = snapshotBase(base);          // BEFORE any child writes
// ... child does COW operations ...
if (hasLocalRoot(child)) assertTreeInvariants(child);   // child structural correctness
assertOwnershipInvariant(child, base, snap);            // spine connected + base pristine
```
Tickets 2 (`cow.test.ts`) and 5 (`b-tree.cow-fork.test.ts`) call exactly `assertTreeInvariants(derived)` / `assertOwnershipInvariant(derived, base)` — the signature here matches.

## Test floor — what passes now

- `npm test`: **121 passing** (was 114; +7 ownership self-tests). `npx tsc --noEmit -p tsconfig.json`: clean.
- The ownership validator is exercised against *real* COW deletes (predicate band, scattered per-step, drain-to-empty, base→mid→leaf) and a 4000-op randomized differential, not just hand-built fixtures.

## Known gaps / things to scrutinize (treat tests as a floor)

- **The ownership checks do NOT catch the original bug's *primary* manifestation by themselves.** The escaped bug orphaned a freshly-cloned node while an owned ancestor kept pointing at the *stale base node*. That orphaned clone is unreachable, so the connectivity/shared/base-immutability checks all pass on it — the dropped-write/phantom-key it produces is caught **functionally** by `assertTreeInvariants(child)` (count/order) plus base-immutability. The ownership checks target the *complementary* "base node aliased into the mutable spine / shared-mutable node" manifestations. **The two validators are only a net when paired** — verify the helper JSDoc states this and that downstream tickets actually call both, not just the ownership one.
- **The "known-broken linkage" self-tests are hand-built**, not produced by reverting the production fix. I deliberately did not reintroduce the `replaceRootward` bug (out of scope; test infra shouldn't depend on broken `src`). A reviewer wanting stronger assurance could add a throwaway test that temporarily reverts the fix and asserts `assertTreeInvariants(child)` (not the ownership checks) catches it. Consider whether the hand-built connectivity/shared fixtures faithfully match the real corrupt shape.
- **Base-immutability's `assertTreeInvariants(base)` requires `base` to have a local `_root`.** For a multi-level chain (ticket 5: base→c1→…→c4) where an *intermediate* base was never written, passing it as `base` with a snapshot will throw "no local root". Mitigation today: pass a snapshot only when `base` is a real base or a written COW child; otherwise use the 2-arg form and assert base-pristine separately. Decide whether the helper should instead validate via the base's *effective* root.
- **Cost.** `assertTreeInvariants`/`assertOwnershipInvariant` each do full O(n) traversals (incl. ascending+descending). Current call sites sample (every 200 ops); tickets 2/5 must keep sampling, not call per-op, on large trees.
- **RNG sequence change.** Swapping cow-delete's inline LCG (constants 1103515245/12345, mod 2³¹) for the shared `lcg` (1664525/1013904223, mod 2³², returns `[0,1)`) changed the exact random keys/orders those tests exercise. Assertions are invariant-based so they still hold, but this is a behavioral change in *which* cases are covered; seeds are preserved for reproducibility.
- `assertOwnershipInvariant` reaches `_root` only through the public `root` getter; the cow-delete test's `hasLocalRoot` guard pokes `(tree as any)['_root']` to avoid validating a deferring child. Confirm that's acceptable test-only access.
