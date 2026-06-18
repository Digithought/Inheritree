description: Added tests proving the higher-level edit operations (upsert, merge, and key-changing updates) correctly keep an inherited tree and its parent isolated, even at sizes large enough to trigger node splitting and rebalancing.
prereq: test-infra-cow-invariants
files: test/b-tree.cow-mutation-ops.test.ts (new, 13 tests), test/helpers/invariants.ts (reference), test/helpers/rng.ts (reference), src/b-tree.ts (read-only reference — UNCHANGED)
difficulty: medium
----
Implemented **cow-mutation-ops-tests**: a new suite `test/b-tree.cow-mutation-ops.test.ts` (13 tests) closing the zero-coverage gap for the copy-on-write behaviour of `upsert`, `merge`, and `updateAt` (same-key value replace AND key-change) on a **multi-level** base. `test/cow.test.ts` previously exercised only insert / same-key update / delete on a *single-leaf* base; these three higher-level mutators all route through the same COW clone machinery (`mutableLeaf` / `mutableBranch` / `internalInsertAt` / `internalUpdate` → `internalInsert` + `internalDelete`) that the escaped insert/delete bugs lived in.

**No `src/` changes.** This is a pure test-addition ticket; all 13 tests pass against the current implementation (`git diff src/` is empty). The structural patterns, helpers, and prose mirror the landed siblings `test/b-tree.cow-insert.test.ts` and `test/b-tree.cow-delete.test.ts`.

## What the suite covers (use cases for validation)

Every case builds an immutable, genuinely multi-level base (NodeCapacity = 64; base sizes 200–400 keys), derives a COW child, and after each op asserts: functional correctness (live set in **both** iteration directions + point lookups), `assertTreeInvariants(child)`, `assertOwnershipInvariant(child, base, snapshot)` (connected, base-disjoint mutable spine + base proven pristine), and value-level base immutability.

- **upsert** (3): new interior key (clones leaf + ancestors); new key into an engineered **full** base leaf (forces a split that cascades to a child-owned root); existing base key (value replace) — asserts the *base entry object identity* is unchanged while the child sees the new value.
- **merge** (4): insert-branch (fresh key, `getUpdated` proven *not* called); update-branch on a base key (`getUpdated` rewrites value, base object identity unchanged); a merge whose insert **splits** a full base leaf; the **conflict path** — `getUpdated` returns an already-present key, so `internalUpdate`→`internalInsert` hits the occupied slot: asserts `wasUpdate=false`, returned path `on=false`, and **both** keys survive untouched (net no-op).
- **updateAt same-key** (1): value replace deep in a base-owned leaf, with an exact "**only the touched spine** cloned" assertion (`countOwned(child.root) === depth+1`).
- **updateAt key-change** (3): a simple cross-tree move; the **heaviest single COW op** — one `updateAt` whose insert side splits a full base leaf *and* whose delete side rebalances a min-fill leaf against a base-owned sibling, with both preconditions structurally probed and asserted before the op; and a per-step scattered key-change stream re-verifying the full ordered set + ownership after *every* individual move.
- **Seeded mixed stream vs. shadow `Map`** (2 seeds × 900 ops): interleaves insert / delete / upsert(new+existing) / merge(insert+update) / updateAt-same / updateAt-keychange, sampling all invariants + ownership + base-pristine every 20 ops and fully at the end.

## Bug-injection proof (teeth confirmed during implement)

Temporarily re-injected the original `replaceRootward` bug (relink into an already-owned ancestor disabled) and ran the new file: **5 of 13 fail** — both key-change cases, the per-step key-change stream, and both mixed streams. The 8 single-write cases (upsert/merge/same-key replace/conflict) pass under the bug, because the orphaned-clone-into-owned-ancestor path only fires when a *second* mutation must relink into a spine the child already owns — which a key-change (insert **then** delete in one op) and the multi-op stream produce, but an isolated first write does not. Source restored byte-for-byte afterward (`git diff src/b-tree.ts` empty). This mirrors the `cow-insert` suite's documented "front-anchored/first-write controls pass under the bug" rationale.

## Honest gaps / what the reviewer should scrutinize (tests are a floor)

- **The heaviest-op case asserts preconditions, not post-hoc firing.** It probes that the insert target is a full (64) base leaf and the delete target a distinct min-fill (32) base leaf, which *guarantees* the single `updateAt` drives both an insert-split and a delete-rebalance — but it does not separately assert (e.g. via a leaf-count / depth delta) that both actually fired afterward. A stronger structural before/after assertion would harden it against a future refactor that quietly stops triggering one side, exactly the class of silent-degradation the `cow-insert` review caught.
- **Delete-side rebalance during a key-change is a BORROW, not a MERGE, in the dedicated heaviest case.** The probed min-fill leaf's right sibling is the full rightmost leaf, so deletion borrows rather than merges. A key-change whose delete forces a **merge** (and thus a parent `rebalanceBranch` clone) is only exercised *incidentally* by the mixed stream. Consider a dedicated case that pins a merge on the key-change delete side.
- **`upsert`'s `path.on` contract is inverted vs `insert`** (on=`false` for a newly-inserted key, `true` for an existing key) and the suite now *locks this in* with assertions. It matches the `BTree.upsert` doc comment but is surprising and inconsistent with `insert`. Confirm this is the intended public contract and not a latent quirk the tests are cementing.
- **Mixed-stream fresh keys are always fractional** (`int + uid/1e5`, interior but never integer), so the stream leans on the targeted tests for fresh-integer interior inserts; only 2 seeds × 900 ops, sampled every 20. Trivially scalable if deeper fuzzing is wanted.
- **Internal coupling.** `leafForKey` / `enumerateLeaves` / `countOwned` reach into `_root` and `.tree` (same style as the sibling suites). The "only touched spine cloned" assertion (`depth+1`) is exact only because it runs as the child's single first write; it is not a general invariant.
- **Number keys / object entries with an explicit `(a,b)=>a-b` comparator only** — no custom-comparator or non-numeric-key coverage. Consistent with project test conventions; a project-wide breadth concern, not specific to this path.

## Validation performed (implement)

- `npx tsc --noEmit -p tsconfig.json` → clean. `npm run build` → green.
- New file alone: **13 passing** (~1–2 s). Full suite (`test/**/*.test.ts`) → **151 passing** (~31 s), no pre-existing failures (`tickets/.pre-existing-error.md` not written).
- Bug-injection proof run + source restored; working tree after implement: only `test/b-tree.cow-mutation-ops.test.ts` added, `git diff src/` empty, no scratch/probe files left.
