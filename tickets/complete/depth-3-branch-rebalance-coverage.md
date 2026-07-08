description: Added tests that delete from a very large, deep tree so a single delete triggers rebalancing that ripples up through two internal branch layers — a path no earlier test reached — and reviewed that coverage.
prereq:
files: test/b-tree.cow-fork.test.ts (new "depth-3 branch rebalance under copy-on-write" group), src/b-tree.ts (unchanged — rebalanceBranch / branchSibSegments are the code under test)
difficulty: medium
----

## What was done

A fifth `describe` group — **"depth-3 branch rebalance under copy-on-write"** — was added to `test/b-tree.cow-fork.test.ts`, covering the path where a copy-on-write delete's rebalancing cascades through **two** internal branch levels (`branchSibSegments` invoked at branch `depth >= 2`). Two tests:

1. **`regression: an interior delete cascades a leaf merge into a two-level branch rebalance and stays correct`** — a leaf merge underflows a leaf-parent branch, which **left-merges** (`branchSibSegments` at branch depth 2), which underflows its own parent branch, which **borrows** from a sibling (`branchSibSegments` at branch depth 1).
2. **`a leaf merge underflows a depth-2 branch that borrows a cloned sibling branch`** — a leaf-parent branch **right-borrows** (`branchSibSegments` at branch depth 2), no cascade to depth 1.

No source changed (this is pure test coverage of already-shipped code). Both tests select their target via a structural finder that reads the live base tree and fails loudly (`expect(targetKey).to.be.greaterThan(-1)`) if no matching site exists, so they cannot pass vacuously. Correctness is proven by `assertTreeInvariants` (order, bidirectional agreement, stored-count vs traversal-count), an exact-key-set comparison, and `assertOwnershipInvariant` (cloned spine connected + base-disjoint, base pristine by key-list + node-identity).

## Review findings

Adversarial pass over the implement diff (commit `9992b37`), read before the handoff summary. Verdict: **the implementation is correct and the coverage claim is real.** No inline fixes were needed; no new tickets filed.

**Checked — implement diff is test-only.** `git diff <impl>~1..<impl> -- src/` is empty; the `.md` and one test file are the whole change. Confirmed.

**Checked — the finder logic actually forces the intended rebalance path (traced against source).** Read `rebalanceBranch`, `rebalanceLeaf`, `mutableBranch`, `branchSibSegments` (`src/b-tree.ts:1007-1265`) and confirmed:
  - `branchSibSegments` is reached only from `mutableBranch(path, depth, sib, delta)`, which `rebalanceBranch` calls for a **right-borrow, left-borrow, or left-merge** — never a right-merge (which absorbs the sibling's children directly and discards it, no clone/relink). The finders steer into borrow / left-merge, matching the intent.
  - `HalfCapacity === NodeCapacity >>> 1 === 32 === MIN_FILL` (`src/b-tree.ts:6,9`), so the finders' fill checks line up with the source's underflow/borrow thresholds. A min-fill branch losing one child hits `< HalfCapacity` and underflows; a sibling `> HalfCapacity` can lend.
  - `mergeLeafKeyUnder` requires the target leaf **and both immediate siblings** at min fill, which forecloses a leaf-level borrow and forces a **merge** — so the leaf-parent branch always loses a child and underflows. Deterministic; not shape-dependent-by-luck.
  - Test 1's `findDoubleCascadeKey` pins `low` = the parent's **last** child (no right sibling → left-merge, not right-merge) with a min-fill left sibling (→ merge, not borrow) under a min-fill, borrow-capable grandparent — so the leaf merge deterministically drives left-merge@depth-2 → borrow@depth-1.

**Checked — the handoff's #1 self-declared gap ("the cascade is proven only structurally, not runtime-asserted").** Rather than trust the structural argument, I verified it empirically: temporarily instrumented `branchSibSegments` to record its `depth` argument (via a `globalThis` array; `process`/`require` are untyped under this tsconfig so a typed logger won't compile), ran both tests, and observed exactly **`depths=[2,1]`** for test 1 and **`depths=[2]`** for test 2 — the claimed two-level cascade and single depth-2 borrow, respectively. Instrumentation and the throwaway probe spec were removed; `git diff src/` is empty again. So the coverage is genuinely real, not merely plausible. (I did **not** add a permanent runtime assertion the handoff floated: test 1 already asserts both branch levels are at min fill via `nodeChainToKey` before deleting, and the invariant battery would fail on any mis-relink, so the marginal value is low and a hand-written sibling-count assertion risks brittleness. Recorded here instead.)

**Checked — regression teeth are adequate.** A mis-linked cloned sibling branch orphans a whole subtree (≈`MIN_FILL^2` ≈ 1024 keys at depth 2); this surfaces as a rule-7 count mismatch and/or missing keys in the exact-set check, and a broken spine trips a rule-4/5 order/shape throw. `assertOwnershipInvariant` independently proves the base untouched by node identity. This is the same battery that caught the original escaped depth-2 bug. Sound.

**Checked — build + full suite.** `npm run build` (tsc) clean. Whole file: **10 passing**. Full suite `npm test`: **349 passing** (~47s), 0 failing, 0 pending. No pre-existing failures surfaced.

**Not covered — recorded as tripwires, not tickets (correct disposition, confirmed present):**
  - A branch-level **right-merge at depth 2** — deliberately excluded because it does not touch `branchSibSegments` (absorbs + discards the sibling, no clone/relink) and is lower risk; depth-1 right-merges are already swept by the depth-2 drain/differential cases. Parked as the `NOTE:` at `test/b-tree.cow-fork.test.ts:688`.
  - A **randomized depth-3 differential** — deferred on cost (a ~68k floor + per-op work on a ~70k tree). Same `NOTE:`. If a depth-3 branch bug ever escapes these two deterministic regressions, that differential is the next thing to add (CI-only if it blows the `npm test` budget).
  Both are genuinely conditional ("fine now; only worth building if X"), so tripwires — not latent defects.

**Deterministic-shape dependency (acknowledged, inherent).** Targets come from a fixed 70,000-ascending-insert tree. If `NodeCapacity`, the split/rebalance math, or `makeBase` changes, the finders may return -1 and the tests **fail loudly** (not silently pass) — someone must then re-probe. This is unavoidable for depth-3 testing (can't shrink `NodeCapacity` to make it cheap) and is documented in the group header. No action.

**Value-level base-pristine via node identity, not object deep-equal.** The depth-2 group uses `liveSet(base).deep.equal(entries)`; this group proves the base pristine by reachable-node **identity** (`assertOwnershipInvariant`'s snapshot) because chai deep-equal on 70k Entry objects costs seconds per test. Identity-equality implies value-equality (COW never mutates a base node in place), so it is sound — a different, arguably stronger check, not a weaker one. No action.

## How to validate / re-run

- Whole group: `node --loader=ts-node/esm node_modules/mocha/bin/mocha.js test/b-tree.cow-fork.test.ts --grep "depth-3 branch rebalance" --timeout 0` → 2 passing (~0.3s).
- Full file: same without `--grep` → 10 passing (~14s).
- Full suite: `npm test` → 349 passing (~47s). `npm run build` (tsc) clean.
